/**
 * Reactivity.js - Reactive Data System
 *
 * Type-specific handlers for DataProxy with unified binding management.
 * Based on ReactivityBridge architecture but with cleaner type dispatch.
 *
 * Architecture:
 *   DataProxy (selects handler by type)
 *       ↓
 *   Type Handler (Object, Array, Map, Set, Date)
 *       ↓
 *   dataBindMap (object → property → bindings)
 *       ↓
 *   dynamics (__forLoops__, __dynamic__property)
 */

import { TARGET, PARENT_PROXY, PARENT_KEY, REBINDABLE, createProxyFactory } from './DataProxy.js';
import { isObject } from './helpers.js';
import { trackAccess, registerManager, getManager, ComputedManager } from './Computed.js';
import { createLogger } from './Logger.js';

const logger = createLogger('Reactivity');

/** Unwrap a proxy to its raw target, or return as-is if not proxied */
function getRawTarget(obj) { return obj[TARGET] || obj; }

/** Prune a disconnected structure from its tracking set. Returns true if alive. */
function isStructureAlive(structure, trackingSet) {
    if (structure.anchor && !structure.anchor.isConnected) {
        trackingSet.delete(structure);
        return false;
    }
    return true;
}

// Render runtime interface - these functions handle actual DOM updates
// Imported from render module (or injected at initialization)
let renderUpdates = null;

/**
 * Set the render update functions
 * Called by render runtime during initialization
 * @param {Object} updates - Object containing render update functions
 */
export function setRenderUpdates(updates) {
    renderUpdates = updates;
}

// ============================================================================
// DATA BIND MAP (module-level, WeakMap for GC)
// ============================================================================

/**
 * dataBindMap: WeakMap<target, value>
 *
 * Structure:
 *   - Set<binding>                    (if target is an object value - direct O(1) lookup)
 *   - Map<property, ...>              (if target is parent of primitives)
 *       ├── "count" → Set<binding>       (regular property bindings)
 *       └── "__dynamic__items" → Set<struct> (dynamics watching "items")
 *
 * forLoopMap: WeakMap<collection, Set<structure>>
 *   Separate storage for :for loop registrations to avoid collisions
 *   with object-value bindings (which store a Set directly on the same target).
 */
const dataBindMap = new WeakMap();
const forLoopMap = new WeakMap();

// ============================================================================
// REBINDING SUPPORT (save/restore bindings across delete → reassign)
// ============================================================================

const savedRebindings = new WeakMap(); // parentTarget → Map<key, { bindings, forLoops }>

/**
 * Save bindings from a deleted rebindable object for later restoration.
 * @param {Object} parentTarget - Parent raw target
 * @param {string} key - Property key being deleted
 * @param {Object} oldObj - The object being deleted
 */
function saveBindingsForRebind(parentTarget, key, oldObj) {
	const oldTarget = getRawTarget(oldObj);
	const bindings = dataBindMap.get(oldTarget);
	const forLoops = forLoopMap.get(oldTarget);

	if (!bindings && !forLoops) return;

	let saved = savedRebindings.get(parentTarget);
	if (!saved) {
		saved = new Map();
		savedRebindings.set(parentTarget, saved);
	}
	saved.set(key, { bindings: bindings || null, forLoops: forLoops || null });

	if (bindings) dataBindMap.delete(oldTarget);
	if (forLoops) forLoopMap.delete(oldTarget);
}

/**
 * Transfer bindings from an old object to a new rebindable object.
 * Handles both direct replacement and restore-from-saved cases.
 * @param {Object} parentTarget - Parent raw target
 * @param {string} key - Property key being set
 * @param {Object} oldObj - Previous value (may be null)
 * @param {Object} newObj - New rebindable value
 */
function transferOrRestoreBindings(parentTarget, key, oldObj, newObj) {
	const newTarget = getRawTarget(newObj);

	// Try restoring from saved (delete → reassign path)
	const saved = savedRebindings.get(parentTarget);
	if (saved && saved.has(key)) {
		const entry = saved.get(key);
		if (entry.bindings) dataBindMap.set(newTarget, entry.bindings);
		if (entry.forLoops) forLoopMap.set(newTarget, entry.forLoops);
		saved.delete(key);
		if (saved.size === 0) savedRebindings.delete(parentTarget);
		return;
	}

	// Direct replacement: transfer from old object to new
	if (isObject(oldObj)) {
		const oldTarget = getRawTarget(oldObj);
		const bindings = dataBindMap.get(oldTarget);
		const forLoops = forLoopMap.get(oldTarget);
		if (bindings) {
			dataBindMap.set(newTarget, bindings);
			dataBindMap.delete(oldTarget);
		}
		if (forLoops) {
			forLoopMap.set(newTarget, forLoops);
			forLoopMap.delete(oldTarget);
		}
	}
}

// ============================================================================
// BINDING REGISTRATION (called by runtime at render time)
// ============================================================================

/**
 * Get or create property map for a target
 * @param {Object} target - Raw target object
 * @returns {Map} Property map for the target
 */
function getOrCreatePropertyMap(target) {
    let propertyMap = dataBindMap.get(target);
    if (!propertyMap) {
        propertyMap = new Map();
        dataBindMap.set(target, propertyMap);
    }
    return propertyMap;
}

/**
 * Add a binding entry
 * @param {Object} objectRef - Target object (proxy or raw)
 * @param {string} property - Property name
 * @param {Node|Object} nodeRef - DOM node or binding object
 * @param {Object} metadata - Binding metadata (type, attributeName, etc.)
 */
export function addBinding(objectRef, property, nodeRef, metadata) {
    const target = getRawTarget(objectRef);
    const value = target[property];

    // Reuse metadata object as binding entry
    const bindingEntry = metadata || {};
    bindingEntry.node = nodeRef;
    bindingEntry.property = property;

    // If value is an object, register binding directly on that object (O(1) lookup)
    // Otherwise register on parent with property as key
    if (isObject(value)) {
        const objectTarget = getRawTarget(value);
        let bindingSet = dataBindMap.get(objectTarget);
        if (!bindingSet) {
            bindingSet = new Set();
            dataBindMap.set(objectTarget, bindingSet);
        }
        bindingSet.add(bindingEntry);
    } else {
        // Primitive - register on parent with property as key
        const propertyMap = getOrCreatePropertyMap(target);
        let bindingSet = propertyMap.get(property);
        if (!bindingSet) {
            bindingSet = new Set();
            propertyMap.set(property, bindingSet);
        }
        bindingSet.add(bindingEntry);
    }

    return bindingEntry;
}

/**
 * Get all bindings for a property
 * @param {Object} objectRef - Target object (proxy or raw)
 * @param {string} property - Property name
 * @returns {Set|null} Set of bindings or null if none
 */
function getBindings(objectRef, property) {
    const target = getRawTarget(objectRef);
    const value = target[property];

    // Check if value is an object - bindings stored directly on it
    if (isObject(value)) {
        const objectTarget = getRawTarget(value);
        const bindingSet = dataBindMap.get(objectTarget);
        if (bindingSet instanceof Set) {
            return bindingSet;
        }
        return null;
    }

    // Primitive - lookup on parent with property key
    const propertyMap = dataBindMap.get(target);
    if (!propertyMap || !(propertyMap instanceof Map)) return null;

    return propertyMap.get(property) || null;
}

// ============================================================================
// DYNAMIC STRUCTURES (:for, :if)
// ============================================================================

/**
 * Add a for-loop structure to track on a collection
 * @param {Array|Map|Set} collectionRef - Collection (proxy or raw)
 * @param {Object} dynamicStructure - Structure with template, anchor, instances, updateFn
 */
export function addArrayForLoop(collectionRef, dynamicStructure) {
    if (!Array.isArray(collectionRef) && !(collectionRef instanceof Map) && !(collectionRef instanceof Set)) return;

    const target = getRawTarget(collectionRef);
    let forLoops = forLoopMap.get(target);
    if (!forLoops) {
        forLoops = new Set();
        forLoopMap.set(target, forLoops);
    }
    forLoops.add(dynamicStructure);
}

/**
 * Get for-loops tracking a collection
 * @param {Array|Map|Set} collectionRef - Collection (proxy or raw)
 * @returns {Set|null} Set of for-loop structures or null if none
 */
function getArrayForLoops(collectionRef) {
    const target = getRawTarget(collectionRef);
    const forLoops = forLoopMap.get(target);
    return forLoops && forLoops.size > 0 ? forLoops : null;
}

/**
 * Add a dynamic structure (:for, :if) for a property
 * @param {Object} objectRef - Target object (proxy or raw)
 * @param {string} property - Property name that triggers this dynamic
 * @param {Object} dynamicStructure - Structure with type, template, anchor, updateFn
 */
export function addDynamicStructure(objectRef, property, dynamicStructure) {
    const target = getRawTarget(objectRef);
    const propertyMap = getOrCreatePropertyMap(target);

    const dynamicKey = `__dynamic__${property}`;
    let structures = propertyMap.get(dynamicKey);
    if (!structures) {
        structures = new Set();
        propertyMap.set(dynamicKey, structures);
    }
    structures.add(dynamicStructure);
}

/**
 * Get dynamic structures for a property
 * @param {Object} objectRef - Target object (proxy or raw)
 * @param {string} property - Property name
 * @returns {Set|null} Set of dynamic structures or null if none
 */
function getDynamicStructures(objectRef, property) {
    const target = getRawTarget(objectRef);
    const propertyMap = dataBindMap.get(target);
    if (!propertyMap) return null;
    const dynamicKey = `__dynamic__${property}`;
    const structures = propertyMap.get(dynamicKey);
    return structures && structures.size > 0 ? structures : null;
}

// ============================================================================
// UPDATE CALLBACKS (component-level $updated hook)
// ============================================================================

const onUpdateCallbacks = new WeakMap();

/**
 * Register a callback to fire after reactive updates are applied to a target.
 * Used by DzComponent to trigger the $updated lifecycle hook.
 * @param {Object} dataTarget - Raw data object (component.data)
 * @param {Function} callback - Callback to fire after updates
 */
export function registerUpdateCallback(dataTarget, callback) {
	onUpdateCallbacks.set(dataTarget, callback);
}

// ============================================================================
// BATCHING
// ============================================================================

let updateStack = [];
let isBatching = false;

/**
 * Batch multiple data changes into a single DOM update
 * @param {Function} callback - Function containing data changes
 */
export function batch(callback) {
    isBatching = true;
    try {
        callback();
        flushUpdates();
    } finally {
        isBatching = false;
    }
}

/**
 * Flush all pending updates (batch mode)
 * Three-phase flush: computed invalidation → bindings/dynamics → watchers
 */
function flushUpdates() {
    const len = updateStack.length;

    // Phase 1: Invalidate computed properties across all queued changes
    for (let i = 0; i < len; i++) {
        const { target, key } = updateStack[i];
        const manager = getManager(target);
        if (manager) manager.invalidate(target, key, applyBindings, applyDynamics);
    }

    // Phase 2: Apply data bindings and dynamics
    for (let i = 0; i < len; i++) {
        const { target, key, value } = updateStack[i];
        applyBindings(target, key, value);
        applyDynamics(target, key, value);
    }

    // Phase 3: Invoke data watchers
    for (let i = 0; i < len; i++) {
        const { target, key, value } = updateStack[i];
        const manager = getManager(target);
        if (manager) manager.invokeWatcher(key, value);
    }

    // Phase 4: Notify update callbacks ($updated hook) — once per unique target
    const notifyTargets = new Set();
    for (let i = 0; i < len; i++) {
        const { target } = updateStack[i];
        if (onUpdateCallbacks.has(target)) notifyTargets.add(target);
    }

    updateStack.length = 0;

    for (const target of notifyTargets) {
        onUpdateCallbacks.get(target)();
    }
}

/**
 * Queue an update (if batching) or apply immediately
 */
function queueUpdate(target, key, value, oldValue) {
    if (isBatching) {
        updateStack.push({ target, key, value, oldValue });
    } else {
        // 1. Invalidate computed (re-evaluates changed ones, fires their bindings)
        const manager = getManager(target);
        if (manager) manager.invalidate(target, key, applyBindings, applyDynamics);

        // 2. Apply data bindings
        applyBindings(target, key, value);

        // 3. Apply dynamics (:if, :for)
        applyDynamics(target, key, value);

        // 4. Invoke data watchers
        if (manager) manager.invokeWatcher(key, value);

        // 5. Notify update callback ($updated hook)
        const cb = onUpdateCallbacks.get(target);
        if (cb) cb();
    }
}

// ============================================================================
// APPLY UPDATES (called by handlers or flush)
// ============================================================================

/**
 * Apply all bindings for a property change
 * @param {Object} target - Raw target object
 * @param {string} key - Property name
 * @param {*} value - New value
 */
function applyBindings(target, key, value) {
    const bindings = getBindings(target, key);
    if (bindings) {
        for (const binding of bindings) {
            if (binding.applyFn) {
                try {
                    binding.applyFn(value, binding);
                } catch (e) {
                    logger.error('Error updating DOM binding', e);
                }
            }
        }
    }
}

/**
 * Apply dynamic structures for a property change
 * @param {Object} target - Raw target object
 * @param {string} key - Property name
 * @param {*} value - New value
 */
function applyDynamics(target, key, value) {
    const dynamics = getDynamicStructures(target, key);
    if (dynamics) {
        for (const structure of dynamics) {
            if (structure.updateFn) {
                try {
                    structure.updateFn(value, structure);
                } catch (e) {
                    logger.error('Error updating dynamic structure', e);
                }
            }
        }
    }
}

// ============================================================================
// CREATE REACTIVITY (main entry point)
// ============================================================================

/**
 * Creates a reactive system for a component
 * @param {Object} componentDef - Component definition
 * @param {Object} [componentDef.data] - Initial data object
 * @param {Object} [componentDef.methods] - Methods bound to proxy
 * @param {Object} [componentDef.computed] - Computed property getters
 * @param {Object} [componentDef.watch] - Watcher definitions
 * @returns {{ proxy: Proxy, dataProxy: Proxy, factory: Object, manager: ComputedManager|null }}
 */
export default function createReactivity(componentDef) {
    // Create handler map for DataProxy
    const handlerMap = new Map([
        [Array, arrayHandlers],
        [Map, mapHandlers],
        [Set, setHandlers],
        [Date, dateHandlers],
        [Object, objectHandlers]
    ]);

    const factory = createProxyFactory(handlerMap);
    const data = componentDef.data || {};
    const dataProxy = factory.createProxy(data);

    // Declared before Proxy — closure captured by get trap.
    // Assigned after Proxy is created. Safe because get trap only
    // runs on property access, never during Proxy construction.
    let manager = null;

    // Create component proxy (unified interface for data/methods/computed)
    const componentProxy = new Proxy(componentDef, {
        get(target, key) {
            // Priority: methods > computed > data
            if (target.methods && key in target.methods) {
                return target.methods[key].bind(componentProxy);
            }
            if (manager && manager.has(key)) {
                // Record access for computed-to-computed dependency tracking
                trackAccess(data, key);
                return manager.evaluate(key);
            }
            return dataProxy[key];
        },
        set(target, key, value) {
            dataProxy[key] = value;
            return true;
        },
        deleteProperty(target, key) {
            delete dataProxy[key];
            return true;
        },
        has(target, key) {
            // Required for `with(proxy)` in condition evaluation.
            // `with` uses the `has` trap to check property existence before resolving names.
            if (target.methods && key in target.methods) return true;
            if (manager && manager.has(key)) return true;
            return key in data;
        }
    });

    // Set up ComputedManager if computed or watch definitions exist
    const hasComputed = componentDef.computed && Object.keys(componentDef.computed).length > 0;
    const hasWatch = componentDef.watch && Object.keys(componentDef.watch).length > 0;

    if (hasComputed || hasWatch) {
        manager = new ComputedManager(data, componentProxy);
        registerManager(data, manager);
        if (hasComputed) manager.setupComputed(componentDef.computed);
        if (hasWatch) manager.setupWatchers(componentDef.watch);
    }

    return {
        proxy: componentProxy,
        dataProxy,
        factory,
        manager
    };
}

// ============================================================================
// OBJECT HANDLERS
// ============================================================================
const objectHandlers = {
    get(target, key, proxyInstance) {
        trackAccess(target, key);
        return target[key];
    },

    set(target, key, value, proxyInstance) {
        // Capture old value before mutation (for watchers)
        const oldValue = target[key];

        // Skip if unchanged
        if (oldValue === value) return true;

        // Rebinding: transfer bindings from old object to new rebindable value
        if (value && typeof value === 'object' && value[REBINDABLE]) {
            transferOrRestoreBindings(target, key, oldValue, value);
            delete value[REBINDABLE];
        }

        // Array reassignment: reconcile in-place, keep old reference
        if (renderUpdates && Array.isArray(oldValue) && Array.isArray(value)) {
            const oldTarget = oldValue;
            // Same underlying array (e.g., proxy.items = proxy.items) — no-op
            if (oldTarget === getRawTarget(value)) return true;
            const forLoopsSet = getArrayForLoops(oldTarget);
            if (forLoopsSet && forLoopsSet.size > 0) {
                // Snapshot to avoid double-iteration if notifyParent adds structures
                const snapshot = [...forLoopsSet];
                for (let i = 0, sLen = snapshot.length; i < sLen; i++) {
                    if (!isStructureAlive(snapshot[i], forLoopsSet)) continue;
                    renderUpdates.forLoopReconcile(snapshot[i], value);
                }
                // Mutate old array to match new contents (bypass proxy)
                oldTarget.length = 0;
                for (let i = 0; i < value.length; i++) oldTarget[i] = value[i];
                oldTarget.length = value.length;
                // Notify bindings/dynamics (e.g., :if="items.length > 0")
                queueUpdate(target, key, oldTarget);
                return true;
            }
        }

        // Set the value
        target[key] = value;

        // Queue or apply update
        queueUpdate(target, key, value, oldValue);

        return true;
    },

    delete(target, key, proxyInstance) {
        // Capture old value before delete (for watchers)
        const oldValue = target[key];

        // Save bindings from rebindable objects for later restoration
        if (isObject(oldValue) && (oldValue[REBINDABLE] || oldValue[TARGET]?.[REBINDABLE])) {
            saveBindingsForRebind(target, key, oldValue);
        }

        // Delete the property
        const result = delete target[key];

        // Queue or apply update
        queueUpdate(target, key, undefined, oldValue);

        return result;
    }
};

// ============================================================================
// SHARED COLLECTION HANDLERS (used by Array, Map, Set, Date)
// ============================================================================

/** Shared property set handler for collection types */
function collectionSet(target, key, value) {
    if (target[key] === value) return true;
    target[key] = value;
    queueUpdate(target, key, value);
    return true;
}

/** Shared property delete handler for collection types */
function collectionDelete(target, key) {
    const result = delete target[key];
    queueUpdate(target, key, undefined);
    return result;
}

// ============================================================================
// ARRAY HANDLERS
// ============================================================================

/**
 * Notify parent object that a collection property changed.
 * Uses PARENT_PROXY/PARENT_KEY from DataProxy to walk up the proxy chain.
 * This triggers :if conditions and bindings that depend on the collection.
 * @param {Proxy} proxyInstance - The collection's proxy
 * @param {*} target - The raw collection
 */
function notifyParent(proxyInstance, target) {
    if (!proxyInstance) return;
    const parent = proxyInstance[PARENT_PROXY];
    const key = proxyInstance[PARENT_KEY];
    if (parent && key) {
        const parentTarget = getRawTarget(parent);
        queueUpdate(parentTarget, key, target);
    }
}

/**
 * Shared collection mutation notification boilerplate.
 * Snapshots forLoops, notifies parent, then dispatches per-structure.
 *
 * CRITICAL: Snapshot as an array copy, NOT a reference to the live Set.
 * notifyParent may trigger renderForLoop → addArrayForLoop which adds to
 * the same Set. If we held a reference, we'd iterate the new structure too
 * (which already rendered all items), causing double-rendering.
 *
 * @param {*} target - Raw collection
 * @param {string} type - Mutation type
 * @param {Object} meta - Mutation metadata
 * @param {Proxy} proxyInstance - Collection proxy (for parent notification)
 * @param {Function} dispatchFn - Per-structure dispatch (module-level, no closure)
 */
function notifyCollectionMutation(target, type, meta, proxyInstance, dispatchFn) {
    if (!renderUpdates) return;
    const forLoopsSet = getArrayForLoops(target);
    const forLoops = forLoopsSet ? [...forLoopsSet] : null;
    notifyParent(proxyInstance, target);
    if (!forLoops) return;
    for (let i = 0, len = forLoops.length; i < len; i++) {
        const structure = forLoops[i];
        if (!isStructureAlive(structure, forLoopsSet)) continue;
        dispatchFn(structure, type, meta, target);
    }
}

/** Dispatch array mutation to appropriate render function */
function dispatchArrayUpdate(structure, type, meta, target) {
    switch (type) {
        case 'push': renderUpdates.forLoopPush?.(structure, meta.items); break;
        case 'pop': renderUpdates.forLoopPop?.(structure, meta.removed); break;
        case 'shift': renderUpdates.forLoopShift?.(structure, meta.removed); break;
        case 'unshift': renderUpdates.forLoopUnshift?.(structure, meta.items); break;
        case 'splice': renderUpdates.forLoopSplice?.(structure, meta.start, meta.deleteCount, meta.items, meta.removed); break;
        case 'sort': case 'reverse': renderUpdates.forLoopReorder?.(structure, target); break;
        case 'set': renderUpdates.forLoopSet?.(structure, meta.key, meta.value, meta.oldValue); break;
    }
}

/** Dispatch Map mutation to appropriate render function */
function dispatchMapUpdate(structure, type, meta) {
    switch (type) {
        case 'set': renderUpdates.forLoopMapSet?.(structure, meta.key, meta.value, meta.isNew); break;
        case 'delete': renderUpdates.forLoopMapDelete?.(structure, meta.key); break;
        case 'clear': renderUpdates.forLoopClear?.(structure); break;
    }
}

/** Dispatch Set mutation to appropriate render function */
function dispatchSetUpdate(structure, type, meta) {
    switch (type) {
        case 'add': renderUpdates.forLoopSetAdd?.(structure, meta.value); break;
        case 'delete': renderUpdates.forLoopSetDelete?.(structure, meta.value); break;
        case 'clear': renderUpdates.forLoopClear?.(structure); break;
    }
}

function notifyArrayMutation(target, type, meta, proxyInstance) {
    notifyCollectionMutation(target, type, meta, proxyInstance, dispatchArrayUpdate);
}

// Cache array method wrappers per target to avoid creating new functions on every access
const arrayMethodCache = new WeakMap();

function getArrayMethods(target, proxyInstance) {
    let methods = arrayMethodCache.get(target);
    if (methods) return methods;

    methods = {
        push(...items) {
            const result = target.push(...items);
            notifyArrayMutation(target, 'push', { items }, proxyInstance);
            return result;
        },
        pop() {
            const removed = target.pop();
            notifyArrayMutation(target, 'pop', { removed }, proxyInstance);
            return removed;
        },
        shift() {
            const removed = target.shift();
            notifyArrayMutation(target, 'shift', { removed }, proxyInstance);
            return removed;
        },
        unshift(...items) {
            const result = target.unshift(...items);
            notifyArrayMutation(target, 'unshift', { items }, proxyInstance);
            return result;
        },
        splice(start, deleteCount, ...items) {
            const removed = target.splice(start, deleteCount, ...items);
            notifyArrayMutation(target, 'splice', { start, deleteCount, items, removed }, proxyInstance);
            return removed;
        },
        sort(compareFn) {
            const result = target.sort(compareFn);
            notifyArrayMutation(target, 'sort', {}, proxyInstance);
            return result;
        },
        reverse() {
            const result = target.reverse();
            notifyArrayMutation(target, 'reverse', {}, proxyInstance);
            return result;
        },
        fill(value, start = 0, end = target.length) {
            const removed = target.slice(start, end);
            const result = target.fill(value, start, end);
            notifyArrayMutation(target, 'splice', {
                start,
                deleteCount: end - start,
                items: target.slice(start, end),
                removed
            }, proxyInstance);
            return result;
        },
        copyWithin(targetIdx, start = 0, end = target.length) {
            const result = target.copyWithin(targetIdx, start, end);
            const count = Math.min(end - start, target.length - targetIdx);
            notifyArrayMutation(target, 'splice', {
                start: targetIdx,
                deleteCount: count,
                items: target.slice(targetIdx, targetIdx + count),
                removed: []
            }, proxyInstance);
            return result;
        }
    };

    arrayMethodCache.set(target, methods);
    return methods;
}

const ARRAY_MUTATORS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin']);

const arrayHandlers = {
    get(target, key, proxyInstance) {
        if (ARRAY_MUTATORS.has(key)) {
            return getArrayMethods(target, proxyInstance)[key];
        }

        return target[key];
    },

    set(target, key, value, proxyInstance) {
        // Skip if unchanged
        if (target[key] === value) return true;

        const oldValue = target[key];
        target[key] = value;

        // Queue or apply binding updates
        queueUpdate(target, key, value);

        // Notify for loops of index set (surgical: update single node)
        if (!isNaN(key)) {
            notifyArrayMutation(target, 'set', { key: Number(key), value, oldValue }, proxyInstance);
        }

        return true;
    },

    delete: collectionDelete
};

// ============================================================================
// MAP HANDLERS
// ============================================================================

function notifyMapMutation(target, type, meta, proxyInstance) {
    notifyCollectionMutation(target, type, meta, proxyInstance, dispatchMapUpdate);
}

const mapHandlers = {
    get(target, key, proxyInstance) {
        // Map.prototype.set - add/update entry
        if (key === 'set') {
            return function(mapKey, value) {
                const isNew = !target.has(mapKey);
                const result = target.set(mapKey, value);
                notifyMapMutation(target, 'set', { key: mapKey, value, isNew }, proxyInstance);
                return result;
            };
        }

        // Map.prototype.delete - remove entry
        if (key === 'delete') {
            return function(mapKey) {
                const had = target.has(mapKey);
                const result = target.delete(mapKey);
                if (had) {
                    notifyMapMutation(target, 'delete', { key: mapKey }, proxyInstance);
                }
                return result;
            };
        }

        // Map.prototype.clear - remove all entries
        if (key === 'clear') {
            return function() {
                if (target.size > 0) {
                    target.clear();
                    notifyMapMutation(target, 'clear', {}, proxyInstance);
                }
            };
        }

        // Read methods - bind to target
        const value = target[key];
        if (typeof value === 'function') {
            return value.bind(target);
        }
        return value;
    },

    set: collectionSet,
    delete: collectionDelete
};

// ============================================================================
// SET HANDLERS
// ============================================================================

function notifySetMutation(target, type, meta, proxyInstance) {
    notifyCollectionMutation(target, type, meta, proxyInstance, dispatchSetUpdate);
}

const setHandlers = {
    get(target, key, proxyInstance) {
        // Set.prototype.add - add value
        if (key === 'add') {
            return function(value) {
                const isNew = !target.has(value);
                const result = target.add(value);
                if (isNew) {
                    notifySetMutation(target, 'add', { value }, proxyInstance);
                }
                return result;
            };
        }

        // Set.prototype.delete - remove value
        if (key === 'delete') {
            return function(value) {
                const had = target.has(value);
                const result = target.delete(value);
                if (had) {
                    notifySetMutation(target, 'delete', { value }, proxyInstance);
                }
                return result;
            };
        }

        // Set.prototype.clear - remove all values
        if (key === 'clear') {
            return function() {
                if (target.size > 0) {
                    target.clear();
                    notifySetMutation(target, 'clear', {}, proxyInstance);
                }
            };
        }

        // Read methods - bind to target
        const value = target[key];
        if (typeof value === 'function') {
            return value.bind(target);
        }
        return value;
    },

    set: collectionSet,
    delete: collectionDelete
};

// ============================================================================
// DATE HANDLERS
// ============================================================================

// Date mutating methods that need interception
const DATE_MUTATORS = new Set([
    'setDate', 'setFullYear', 'setHours', 'setMilliseconds',
    'setMinutes', 'setMonth', 'setSeconds', 'setTime',
    'setUTCDate', 'setUTCFullYear', 'setUTCHours', 'setUTCMilliseconds',
    'setUTCMinutes', 'setUTCMonth', 'setUTCSeconds', 'setYear'
]);

/**
 * Notify bindings of Date mutation
 */
function notifyDateMutation(target) {
    // Date bindings are stored on the date object itself
    const bindings = dataBindMap.get(target);
    if (bindings instanceof Set) {
        for (const binding of bindings) {
            if (binding.applyFn) {
                binding.applyFn(target, binding);
            }
        }
    }
}

const dateHandlers = {
    get(target, key, proxyInstance) {
        // Intercept mutating methods
        if (DATE_MUTATORS.has(key)) {
            return function(...args) {
                const result = target[key](...args);
                notifyDateMutation(target);
                return result;
            };
        }

        // Read methods - bind to target
        const value = target[key];
        if (typeof value === 'function') {
            return value.bind(target);
        }
        return value;
    },

    set: collectionSet,
    delete: collectionDelete
};