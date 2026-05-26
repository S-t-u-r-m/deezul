/**
 * Reactivity.js - Reactive Data System
 *
 * Design:
 *
 * 1. The pre-check lives in DataProxy's set trap.
 *    The set trap rejects identity-equal assignments before any handler
 *    runs, so handlers carry no `if (oldValue === value)` branches and
 *    receive the already-validated `oldValue` as a parameter.
 *
 * 2. Handlers do not apply updates directly.
 *    Property changes go through `recordChange(target, key, oldValue, value)`.
 *    Collection mutations (push/splice/Map.set/Set.add/Date.setX/...) go
 *    through `recordMutation(target, type, meta, proxyInstance)`.
 *    The chain batches via microtask — `batch()` is preserved for the rare
 *    caller that needs a synchronous flush boundary.
 *
 * 3. Per-target apply phase.
 *    The flush iterates per-target rather than per-change. For each changed
 *    target we invalidate its computed properties, fire its bindings/dynamics,
 *    and run its watchers as a unit. Manager and $updated lookups happen
 *    once per target, not once per change.
 */

import {
    TARGET, PARENT_PROXY, PARENT_KEY, REBINDABLE,
    createProxyFactory, recordChange, recordMutation,
    setFlushHandlers, setOnProxyCreated, flushSync
} from './DataProxy.js';
import { isObject } from './helpers.js';
import { trackAccess, registerManager, getManager, ComputedManager } from './Computed.js';
import { createLogger } from './Logger.js';

const logger = createLogger('Reactivity');

// ============================================================================
// HELPERS
// ============================================================================

function getRawTarget(obj) { return obj[TARGET] || obj; }

/**
 * Iterate live :for structures registered on a target. Snapshots the live
 * Set as an Array so a reconciler that re-registers itself mid-iteration
 * doesn't get visited twice; structures whose anchor has been removed from
 * the DOM are pruned from the Set as we encounter them.
 */
function forEachLiveForLoop(target, callback) {
    const set = forLoopMap.get(target);
    if (!set || set.size === 0) return;
    const snapshot = [...set];
    for (let i = 0, len = snapshot.length; i < len; i++) {
        const structure = snapshot[i];
        if (structure.anchor && !structure.anchor.isConnected) {
            set.delete(structure);
            continue;
        }
        callback(structure);
    }
}

// ============================================================================
// RENDER RUNTIME INJECTION
// ============================================================================

let renderUpdates = null;

export function setRenderUpdates(updates) {
    renderUpdates = updates;
}

// ============================================================================
// BINDING STORAGE
// ============================================================================

/**
 * dataBindMap: WeakMap<rawTarget, Set<binding> | Map<key, ...>>
 *
 *   - Set<binding>             : when the target is itself an object value
 *                                with bindings on it (O(1) lookup).
 *   - Map<key, Set<binding>>   : when the target is a parent of primitives.
 *   - Map<"__dynamic__key">    : :for/:if structures keyed by trigger property.
 *
 * forLoopMap: WeakMap<collection, Set<structure>>
 *   :for-loop registrations, kept separate from dataBindMap so they don't
 *   collide with object-value bindings stored directly on the same target.
 */
const dataBindMap = new WeakMap();
const forLoopMap = new WeakMap();

const onUpdateCallbacks = new WeakMap();

export function registerUpdateCallback(dataTarget, callback) {
    onUpdateCallbacks.set(dataTarget, callback);
}

/**
 * Drop the $updated callback for a data target. Called by DzComponent.unmount
 * so the captured closure (which holds the custom element strongly) becomes
 * eligible for GC immediately rather than waiting for the WeakMap entry to
 * collect on the next Major GC after the data target becomes unreachable.
 */
export function unregisterUpdateCallback(dataTarget) {
    onUpdateCallbacks.delete(dataTarget);
}

// ============================================================================
// REBINDING SUPPORT
// ============================================================================

const savedRebindings = new WeakMap();

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

function transferOrRestoreBindings(parentTarget, key, oldObj, newObj) {
    const newTarget = getRawTarget(newObj);

    const saved = savedRebindings.get(parentTarget);
    if (saved && saved.has(key)) {
        const entry = saved.get(key);
        if (entry.bindings) dataBindMap.set(newTarget, entry.bindings);
        if (entry.forLoops) forLoopMap.set(newTarget, entry.forLoops);
        saved.delete(key);
        if (saved.size === 0) savedRebindings.delete(parentTarget);
        return;
    }

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

function getOrCreatePropertyMap(target) {
    let propertyMap = dataBindMap.get(target);
    if (!propertyMap) {
        propertyMap = new Map();
        dataBindMap.set(target, propertyMap);
    }
    return propertyMap;
}

export function addBinding(objectRef, property, nodeRef, metadata) {
    const target = getRawTarget(objectRef);
    const value = target[property];

    const bindingEntry = metadata || {};
    bindingEntry.node = nodeRef;
    bindingEntry.property = property;

    let bindingSet;
    if (isObject(value)) {
        const objectTarget = getRawTarget(value);
        bindingSet = dataBindMap.get(objectTarget);
        if (!bindingSet) {
            bindingSet = new Set();
            dataBindMap.set(objectTarget, bindingSet);
        }
    } else {
        const propertyMap = getOrCreatePropertyMap(target);
        bindingSet = propertyMap.get(property);
        if (!bindingSet) {
            bindingSet = new Set();
            propertyMap.set(property, bindingSet);
        }
    }
    bindingSet.add(bindingEntry);
    // Stash the owning Set on the entry so removeBinding can drop it in O(1)
    // without re-resolving the (target, property) → Set lookup.
    bindingEntry._set = bindingSet;

    return bindingEntry;
}

/**
 * Remove a previously-registered binding entry from its owning Set.
 * Called by teardownInstance when a chain item (:if branch) is unmounted —
 * without this, addBinding entries accumulate on every branch swap and
 * applyBindings later iterates over entries pointing to detached DOM.
 */
export function removeBinding(bindingEntry) {
    const set = bindingEntry && bindingEntry._set;
    if (!set) return;
    set.delete(bindingEntry);
    bindingEntry._set = null;
}

function getBindings(objectRef, property) {
    const target = getRawTarget(objectRef);
    const value = target[property];

    if (isObject(value)) {
        const objectTarget = getRawTarget(value);
        const bindingSet = dataBindMap.get(objectTarget);
        if (bindingSet instanceof Set) return bindingSet;
        return null;
    }

    const propertyMap = dataBindMap.get(target);
    if (!propertyMap || !(propertyMap instanceof Map)) return null;
    return propertyMap.get(property) || null;
}

export function addArrayForLoop(collectionRef, dynamicStructure) {
    if (!Array.isArray(collectionRef) && !(collectionRef instanceof Map) && !(collectionRef instanceof Set)) return;
    const target = getRawTarget(collectionRef);
    let forLoops = forLoopMap.get(target);
    if (!forLoops) {
        forLoops = new Set();
        forLoopMap.set(target, forLoops);
    }
    forLoops.add(dynamicStructure);
    trackMembership(dynamicStructure, forLoops);
}

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
    trackMembership(dynamicStructure, structures);
}

// Track each Set a structure is added to so unregisterStructure can
// reverse every membership in O(memberships) without scanning the maps.
// Dedup via indexOf: an :if branch that toggles N times re-registers the
// structure against the same Sets N times, but we only need each Set ref
// once for cleanup. indexOf is O(memberships) but the array stays tiny in
// practice (1-5 entries per structure).
function trackMembership(structure, set) {
    if (!structure._memberships) {
        structure._memberships = [set];
        return;
    }
    if (structure._memberships.indexOf(set) === -1) {
        structure._memberships.push(set);
    }
}

/**
 * Remove a dynamic structure from every Set it was added to (both
 * forLoopMap and dataBindMap entries). Called by the render-side teardown
 * when an instance is being removed, so dead :for/:if registrations don't
 * accumulate in the reactivity maps across mount/unmount cycles.
 */
export function unregisterStructure(structure) {
    const sets = structure._memberships;
    if (!sets) return;
    for (let i = 0, len = sets.length; i < len; i++) {
        sets[i].delete(structure);
    }
    structure._memberships = null;
}

function getDynamicStructures(objectRef, property) {
    const target = getRawTarget(objectRef);
    const propertyMap = dataBindMap.get(target);
    if (!propertyMap) return null;
    const structures = propertyMap.get(`__dynamic__${property}`);
    return structures && structures.size > 0 ? structures : null;
}

// ============================================================================
// APPLY PRIMITIVES — invoked from the flush phases below
// ============================================================================

function applyBindings(target, key, value) {
    const bindings = getBindings(target, key);
    if (!bindings) return;
    for (const binding of bindings) {
        if (!binding.applyFn) continue;
        try { binding.applyFn(value, binding); }
        catch (e) { logger.error('Error updating DOM binding', e); }
    }
}

function applyDynamics(target, key, value) {
    const dynamics = getDynamicStructures(target, key);
    if (!dynamics) return;
    for (const structure of dynamics) {
        if (!structure.updateFn) continue;
        try { structure.updateFn(value, structure); }
        catch (e) { logger.error('Error updating dynamic structure', e); }
    }
}

// ============================================================================
// FLUSH HANDLERS — registered with DataProxy
// ============================================================================

/**
 * Apply all changes for a single target in a single pass per key.
 *
 * For each changed key we invalidate dependent computed properties, fire
 * the key's bindings and dynamics, then run its watcher. Per-iteration
 * order matches the previous phased flush; the only difference is that
 * a watcher for key A runs before key B's bindings update the DOM. Deezul
 * watchers don't read the DOM, so the simplification is safe.
 *
 * The no-op prune (value === oldValue without force) lives inline now —
 * with one pass, there's nothing to gain from a separate pre-prune.
 */
function applyChanges(target, propertyMap) {
    const manager = getManager(target);
    for (const [key, entry] of propertyMap) {
        if (entry.value === entry.oldValue && !entry.force) continue;
        if (manager) manager.invalidate(target, key, applyBindings, applyDynamics);
        applyBindings(target, key, entry.value);
        applyDynamics(target, key, entry.value);
        if (manager) manager.invokeWatcher(key, entry.value);
    }
}

/**
 * Apply a collection mutation to its forLoops + walk up to fire parent
 * bindings / dynamics (e.g., :if="items.length > 0").
 */
function applyMutation(target, type, meta, proxyInstance) {
    if (!renderUpdates) return;

    // Date mutations: bindings stored directly on the date target.
    if (type === 'date') {
        const bindings = dataBindMap.get(target);
        if (bindings instanceof Set) {
            for (const binding of bindings) {
                if (!binding.applyFn) continue;
                try { binding.applyFn(target, binding); }
                catch (e) { logger.error('Error updating Date binding', e); }
            }
        }
        return;
    }

    // forLoop reconciliation for replace-array-in-place (object handler).
    if (type === 'reconcile') {
        forEachLiveForLoop(target, (structure) => {
            renderUpdates.forLoopReconcile?.(structure, meta.value);
        });
        return;
    }

    const dispatcher = mutationDispatchers[type];
    if (!dispatcher) return;

    forEachLiveForLoop(target, (structure) => {
        dispatcher(structure, meta, target);
    });

    // Walk up the proxy chain so the parent's bindings / dynamics fire.
    // Same-reference mutation can't be detected via recordChange (oldValue ===
    // value), so this lives in the mutation path directly.
    if (proxyInstance) {
        const parent = proxyInstance[PARENT_PROXY];
        const parentKey = proxyInstance[PARENT_KEY];
        if (parent && parentKey) {
            const parentTarget = getRawTarget(parent);
            applyBindings(parentTarget, parentKey, target);
            applyDynamics(parentTarget, parentKey, target);
        }
    }
}

const mutationDispatchers = {
    push:      (s, m)    => renderUpdates.forLoopPush?.(s, m.items),
    pop:       (s, m)    => renderUpdates.forLoopPop?.(s, m.removed),
    shift:     (s, m)    => renderUpdates.forLoopShift?.(s, m.removed),
    unshift:   (s, m)    => renderUpdates.forLoopUnshift?.(s, m.items),
    splice:    (s, m)    => renderUpdates.forLoopSplice?.(s, m.start, m.deleteCount, m.items, m.removed),
    sort:      (s, m, t) => renderUpdates.forLoopReorder?.(s, t),
    reverse:   (s, m, t) => renderUpdates.forLoopReorder?.(s, t),
    set:       (s, m)    => renderUpdates.forLoopSet?.(s, m.key, m.value, m.oldValue),
    mapSet:    (s, m)    => renderUpdates.forLoopMapSet?.(s, m.key, m.value, m.isNew),
    mapDelete: (s, m)    => renderUpdates.forLoopMapDelete?.(s, m.key),
    clear:     (s)       => renderUpdates.forLoopClear?.(s),
    setAdd:    (s, m)    => renderUpdates.forLoopSetAdd?.(s, m.value),
    setDelete: (s, m)    => renderUpdates.forLoopSetDelete?.(s, m.value),
};

/**
 * After bindings & watchers settle, fire $updated lifecycle callbacks once
 * per touched target — across both property changes and collection mutations.
 */
function afterFlush(localChain, localMutations) {
    const notified = new Set();
    const visit = (target) => {
        if (notified.has(target)) return;
        notified.add(target);
        const cb = onUpdateCallbacks.get(target);
        if (cb) cb();
    };
    for (const [target] of localChain) visit(target);
    for (let i = 0, len = localMutations.length; i < len; i++) {
        visit(localMutations[i].target);
    }
}

setFlushHandlers({ applyChanges, applyMutation, afterFlush });

/**
 * Propagate the ComputedManager from a parent target down to each nested
 * target the first time its proxy is created.
 *
 * Without this, a change deep in the data tree (e.g., `state.user.name = 'Bob'`)
 * would call `getManager(userTarget)` → null because the manager is only
 * registered on the root `state`. Copying the parent's manager pointer onto
 * each child the moment its proxy is created lets any descendant find its
 * manager via a flat WeakMap lookup.
 */
setOnProxyCreated((target, parentTarget) => {
    if (!parentTarget) return;
    const parentManager = getManager(parentTarget);
    if (parentManager && !getManager(target)) {
        registerManager(target, parentManager);
    }
});

// ============================================================================
// BATCH (back-compat)
// ============================================================================

/**
 * Synchronously batch a callback's writes. With microtask auto-flush this is
 * mostly redundant — most call sites can drop the wrapper — but it remains
 * useful when the caller needs the DOM updated before the microtask boundary.
 */
export function batch(callback) {
    callback();
    flushSync();
}

// ============================================================================
// CREATE REACTIVITY
// ============================================================================

export default function createReactivity(componentDef) {
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

    let manager = null;

    const componentProxy = new Proxy(componentDef, {
        get(target, key) {
            if (target.methods && key in target.methods) {
                return target.methods[key].bind(componentProxy);
            }
            if (manager && manager.has(key)) {
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
            if (target.methods && key in target.methods) return true;
            if (manager && manager.has(key)) return true;
            return key in data;
        }
    });

    const hasComputed = componentDef.computed && Object.keys(componentDef.computed).length > 0;
    const hasWatch = componentDef.watch && Object.keys(componentDef.watch).length > 0;

    if (hasComputed || hasWatch) {
        manager = new ComputedManager(data, componentProxy);
        registerManager(data, manager);
        if (hasComputed) manager.setupComputed(componentDef.computed);
        if (hasWatch) manager.setupWatchers(componentDef.watch);
    }

    return { proxy: componentProxy, dataProxy, factory, manager };
}

// ============================================================================
// OBJECT HANDLERS
// ============================================================================

const objectHandlers = {
    get(target, key, proxyInstance) {
        trackAccess(target, key);
        return target[key];
    },

    set(target, key, value, proxyInstance, oldValue) {
        // Equality pre-check already performed by DataProxy's set trap.

        // Rebinding: transfer bindings from old object to new rebindable value.
        if (value && typeof value === 'object' && value[REBINDABLE]) {
            transferOrRestoreBindings(target, key, oldValue, value);
            delete value[REBINDABLE];
        }

        // Array reassignment with active :for loops — reconcile in-place so
        // existing DOM nodes can be reused. Pre-check has already ruled out
        // same-reference assignment.
        if (renderUpdates && Array.isArray(oldValue) && Array.isArray(value)
            && forLoopMap.get(oldValue)?.size > 0) {
            reconcileArray(target, key, oldValue, value);
            return true;
        }

        target[key] = value;
        recordChange(target, key, oldValue, value);
        return true;
    },

    delete(target, key, proxyInstance) {
        const oldValue = target[key];
        if (isObject(oldValue) && (oldValue[REBINDABLE] || oldValue[TARGET]?.[REBINDABLE])) {
            saveBindingsForRebind(target, key, oldValue);
        }
        const result = delete target[key];
        recordChange(target, key, oldValue, undefined);
        return result;
    }
};

// ============================================================================
// COLLECTION HANDLERS (Array / Map / Set / Date)
// ============================================================================

function collectionSet(target, key, value, proxyInstance, oldValue) {
    target[key] = value;
    recordChange(target, key, oldValue, value);
    return true;
}

/**
 * Replace an array's contents in place while preserving its reference, so
 * existing :for DOM nodes can be reconciled instead of torn down. The new
 * array's items are copied into the old array, then a 'reconcile' mutation
 * is queued for the renderer; a force-fire change on the parent property
 * notifies bindings/dynamics (e.g., `:if="items.length > 0"`) even though
 * `target[key]` still holds the same reference.
 */
function reconcileArray(target, key, oldArray, newArray) {
    oldArray.length = 0;
    for (let i = 0; i < newArray.length; i++) oldArray[i] = newArray[i];
    oldArray.length = newArray.length;

    recordMutation(oldArray, 'reconcile', { value: newArray }, null);
    recordChange(target, key, oldArray, oldArray, true);
}

function collectionDelete(target, key) {
    if (!(key in target)) return true;
    const oldValue = target[key];
    const result = delete target[key];
    recordChange(target, key, oldValue, undefined);
    return result;
}

// ----- Array -----

const arrayMethodCache = new WeakMap();

function getArrayMethods(target, proxyInstance) {
    let methods = arrayMethodCache.get(target);
    if (methods) return methods;

    methods = {
        push(...items) {
            const result = target.push(...items);
            recordMutation(target, 'push', { items }, proxyInstance);
            return result;
        },
        pop() {
            const removed = target.pop();
            recordMutation(target, 'pop', { removed }, proxyInstance);
            return removed;
        },
        shift() {
            const removed = target.shift();
            recordMutation(target, 'shift', { removed }, proxyInstance);
            return removed;
        },
        unshift(...items) {
            const result = target.unshift(...items);
            recordMutation(target, 'unshift', { items }, proxyInstance);
            return result;
        },
        splice(start, deleteCount, ...items) {
            const removed = target.splice(start, deleteCount, ...items);
            recordMutation(target, 'splice', { start, deleteCount, items, removed }, proxyInstance);
            return removed;
        },
        sort(compareFn) {
            const result = target.sort(compareFn);
            recordMutation(target, 'sort', {}, proxyInstance);
            return result;
        },
        reverse() {
            const result = target.reverse();
            recordMutation(target, 'reverse', {}, proxyInstance);
            return result;
        },
        // fill and copyWithin overwrite slots in place — array length never
        // changes. Emit a `set` mutation per affected index instead of a
        // splice (a splice would mistakenly insert/remove DOM nodes).
        fill(value, start = 0, end = target.length) {
            const len = target.length;
            const from = start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
            const to   = end   < 0 ? Math.max(len + end,   0) : Math.min(end,   len);

            // Snapshot before mutation — each set event needs the original oldValue.
            const oldValues = new Array(Math.max(to - from, 0));
            for (let i = from; i < to; i++) oldValues[i - from] = target[i];

            const result = target.fill(value, start, end);

            for (let i = from; i < to; i++) {
                const oldValue = oldValues[i - from];
                if (value === oldValue) continue;
                recordMutation(target, 'set', { key: i, value, oldValue }, proxyInstance);
            }
            return result;
        },
        copyWithin(toIdx, start = 0, end = target.length) {
            const len = target.length;
            const dest  = toIdx < 0 ? Math.max(len + toIdx, 0) : Math.min(toIdx, len);
            const from  = start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
            const final = end   < 0 ? Math.max(len + end,   0) : Math.min(end,   len);
            const count = Math.max(Math.min(final - from, len - dest), 0);

            const oldValues = new Array(count);
            for (let i = 0; i < count; i++) oldValues[i] = target[dest + i];

            const result = target.copyWithin(toIdx, start, end);

            for (let i = 0; i < count; i++) {
                const idx = dest + i;
                const newValue = target[idx];
                if (newValue === oldValues[i]) continue;
                recordMutation(target, 'set', { key: idx, value: newValue, oldValue: oldValues[i] }, proxyInstance);
            }
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

    set(target, key, value, proxyInstance, oldValue) {
        target[key] = value;
        recordChange(target, key, oldValue, value);
        if (!isNaN(key)) {
            recordMutation(target, 'set', { key: Number(key), value, oldValue }, proxyInstance);
        }
        return true;
    },

    delete: collectionDelete
};

/**
 * Build a get/set/delete handler set for a collection-like type (Map, Set, Date).
 *
 * `mutatorWrappers` is an object keyed by method name. Each entry receives
 * `(target, proxyInstance)` and returns the wrapped method. Anything not in
 * the map falls through to the raw target — function-valued members are
 * bound to the raw target so methods like `Map.prototype.get` work correctly
 * when called against the proxy.
 *
 * Wrapped mutators and bound builtins are cached per (target, key) so a hot
 * loop like `proxy.someMap.set(...)` doesn't allocate a fresh closure on
 * every call. Primitive reads (e.g. `.size`) bypass the cache since their
 * values can change.
 */
function makeCollectionHandlers(mutatorWrappers) {
    const methodCache = new WeakMap();

    return {
        get(target, key, proxyInstance) {
            let methods = methodCache.get(target);
            if (methods) {
                const cached = methods[key];
                if (cached !== undefined) return cached;
            }

            const wrap = mutatorWrappers[key];
            if (wrap) {
                if (!methods) {
                    methods = Object.create(null);
                    methodCache.set(target, methods);
                }
                const wrapped = wrap(target, proxyInstance);
                methods[key] = wrapped;
                return wrapped;
            }

            const value = target[key];
            if (typeof value === 'function') {
                if (!methods) {
                    methods = Object.create(null);
                    methodCache.set(target, methods);
                }
                const bound = value.bind(target);
                methods[key] = bound;
                return bound;
            }

            return value;
        },
        set: collectionSet,
        delete: collectionDelete
    };
}

// ----- Map -----

const mapHandlers = makeCollectionHandlers({
    set: (target, proxyInstance) => function(mapKey, value) {
        const isNew = !target.has(mapKey);
        const result = target.set(mapKey, value);
        recordMutation(target, 'mapSet', { key: mapKey, value, isNew }, proxyInstance);
        return result;
    },
    delete: (target, proxyInstance) => function(mapKey) {
        const had = target.has(mapKey);
        const result = target.delete(mapKey);
        if (had) recordMutation(target, 'mapDelete', { key: mapKey }, proxyInstance);
        return result;
    },
    clear: (target, proxyInstance) => function() {
        if (target.size > 0) {
            target.clear();
            recordMutation(target, 'clear', {}, proxyInstance);
        }
    }
});

// ----- Set -----

const setHandlers = makeCollectionHandlers({
    add: (target, proxyInstance) => function(value) {
        const isNew = !target.has(value);
        const result = target.add(value);
        if (isNew) recordMutation(target, 'setAdd', { value }, proxyInstance);
        return result;
    },
    delete: (target, proxyInstance) => function(value) {
        const had = target.has(value);
        const result = target.delete(value);
        if (had) recordMutation(target, 'setDelete', { value }, proxyInstance);
        return result;
    },
    clear: (target, proxyInstance) => function() {
        if (target.size > 0) {
            target.clear();
            recordMutation(target, 'clear', {}, proxyInstance);
        }
    }
});

// ----- Date -----

const DATE_MUTATORS = [
    'setDate', 'setFullYear', 'setHours', 'setMilliseconds',
    'setMinutes', 'setMonth', 'setSeconds', 'setTime',
    'setUTCDate', 'setUTCFullYear', 'setUTCHours', 'setUTCMilliseconds',
    'setUTCMinutes', 'setUTCMonth', 'setUTCSeconds', 'setYear'
];

const dateMutatorWrappers = {};
for (const method of DATE_MUTATORS) {
    dateMutatorWrappers[method] = (target, proxyInstance) => function(...args) {
        const result = target[method](...args);
        recordMutation(target, 'date', {}, proxyInstance);
        return result;
    };
}

const dateHandlers = makeCollectionHandlers(dateMutatorWrappers);
