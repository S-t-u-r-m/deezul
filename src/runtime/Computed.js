/**
 * Computed.js - Computed Properties & Watchers
 *
 * Provides cached, dependency-tracked computed properties and watchers
 * that integrate with the existing reactive proxy system.
 *
 * Dependency tracking: During computed evaluation, all property reads
 * are recorded via trackAccess(). Dependencies are re-captured on
 * each evaluation so they stay current.
 *
 * Computed-to-computed: When computed B reads computed A, the
 * componentProxy get trap calls trackAccess(dataTarget, 'A') before
 * evaluating A. Inner evaluation saves/restores tracking context.
 * Invalidation cascades through the dependency graph.
 */

import { createLogger } from './Logger.js';
import { cloneValue } from './helpers.js';

const logger = createLogger('Computed');

// ============================================================================
// GLOBAL DEPENDENCY TRACKING
// ============================================================================

let isTracking = false;
let currentDeps = null;           // Map<target, Set<key>>
const evaluationStack = [];       // [{ manager, name }, ...] for circular detection

/**
 * Record a property access during computed evaluation.
 * Called from objectHandlers.get in Reactivity.js.
 * No-op when not tracking (single boolean check).
 * @param {Object} target - Raw data target
 * @param {string} key - Property name
 */
export function trackAccess(target, key) {
	if (!isTracking) return;
	if (typeof key === 'symbol') return;

	let props = currentDeps.get(target);
	if (!props) {
		props = new Set();
		currentDeps.set(target, props);
	}
	props.add(key);
}

/**
 * Start dependency tracking. Saves previous state for nesting.
 * @returns {{ wasTracking: boolean, prevDeps: Map|null }}
 */
function startTracking() {
	const prev = { wasTracking: isTracking, prevDeps: currentDeps };
	isTracking = true;
	currentDeps = new Map();
	return prev;
}

/**
 * Stop tracking and restore previous state.
 * @param {{ wasTracking: boolean, prevDeps: Map|null }} prev
 * @returns {Map<Object, Set<string>>} Collected dependencies
 */
function stopTracking(prev) {
	const deps = currentDeps;
	isTracking = prev.wasTracking;
	currentDeps = prev.prevDeps;
	return deps;
}

// ============================================================================
// PUBLIC EVALUATION STATE API
// ============================================================================

/**
 * Get the evaluation stack as a formatted trace string.
 * @returns {string} e.g. "fullName → displayLabel → greeting"
 */
export function getStackTrace() {
	if (evaluationStack.length === 0) return '';
	return evaluationStack.map(e => e.name).join(' \u2192 ');
}

// ============================================================================
// MANAGER REGISTRY (WeakMap — per-component lookup from queueUpdate)
// ============================================================================

const managerMap = new WeakMap();

/**
 * Register a ComputedManager for a data target
 * @param {Object} dataTarget - Raw data object
 * @param {ComputedManager} manager
 */
export function registerManager(dataTarget, manager) {
	managerMap.set(dataTarget, manager);
}

/**
 * Get the ComputedManager for a data target
 * @param {Object} dataTarget - Raw data object
 * @returns {ComputedManager|null}
 */
export function getManager(dataTarget) {
	return managerMap.get(dataTarget) || null;
}

/**
 * Reverse interest index: rawTarget → Set<ComputedManager> whose computed
 * properties currently depend on that target. Unlike managerMap (1:1, the
 * manager that OWNS a data root), this is many-to-many: a shared object — a
 * data store, a model passed between components — can be a dependency of
 * computed properties in several components at once, and every one of them
 * must be invalidated when it changes. Maintained by _updateDepIndex.
 */
const interestedManagers = new WeakMap();

/**
 * Get the managers whose computed properties depend on a target.
 * @param {Object} target - Raw data target
 * @returns {Set<ComputedManager>|null}
 */
export function getInterestedManagers(target) {
	return interestedManagers.get(target) || null;
}

function addManagerInterest(target, manager) {
	let set = interestedManagers.get(target);
	if (!set) {
		set = new Set();
		interestedManagers.set(target, set);
	}
	set.add(manager);
}

function removeManagerInterest(target, manager) {
	const set = interestedManagers.get(target);
	if (set) set.delete(manager);
}

// ============================================================================
// COMPUTED MANAGER
// ============================================================================

export class ComputedManager {
	/**
	 * @param {Object} dataTarget - Raw data object (for binding lookups)
	 * @param {Proxy} componentProxy - Unified component proxy (this context for getters)
	 */
	constructor(dataTarget, componentProxy) {
		this.dataTarget = dataTarget;
		this.componentProxy = componentProxy;

		/** @type {Map<string, { getter: Function, cache: *, dirty: boolean, deps: Map|null }>} */
		this.computed = new Map();

		/** @type {Map<string, { callback: Function, oldValue: * }>} */
		this.watchers = new Map();

		/**
		 * Reverse dependency index: (target, key) → Set<computedName>
		 * Lets `invalidate` and the cascade do O(1) lookups instead of an
		 * O(N) scan over every computed in this manager. Maintained by
		 * `_updateDepIndex` after each successful evaluate.
		 *
		 * @type {Map<Object, Map<string, Set<string>>>}
		 */
		this.depIndex = new Map();
	}

	// ========================================================================
	// Setup
	// ========================================================================

	/**
	 * Initialize computed property metadata from definitions.
	 * Accepts plain getter functions or { get, set } objects:
	 *
	 *   computed: {
	 *       fullName: {
	 *           get() { return this.first + ' ' + this.last; },
	 *           set(v) { [this.first, this.last] = v.split(' '); }
	 *       }
	 *   }
	 *
	 * @param {Object} defs - { propName: getter | { get, set }, ... }
	 */
	setupComputed(defs) {
		const entries = Object.entries(defs);
		for (let i = 0, len = entries.length; i < len; i++) {
			const [name, def] = entries[i];
			let getter, setter = null;
			if (typeof def === 'function') {
				getter = def;
			} else if (def && typeof def.get === 'function') {
				getter = def.get;
				setter = typeof def.set === 'function' ? def.set : null;
			} else {
				logger.warn(`Computed "${name}" is not a function or { get, set } object, skipping`);
				continue;
			}
			this.computed.set(name, {
				getter,
				setter,
				cache: undefined,
				dirty: true,
				deps: null
			});
		}
		logger.debug('Computed properties registered', [...this.computed.keys()]);
	}

	/**
	 * Check if a computed property declared a setter
	 * @param {string} name
	 * @returns {boolean}
	 */
	hasSetter(name) {
		const meta = this.computed.get(name);
		return !!(meta && meta.setter);
	}

	/**
	 * Invoke a computed property's setter (this = componentProxy). The
	 * setter's writes to data flow through the normal reactive path, which
	 * invalidates the computed itself like any other dependency change.
	 * @param {string} name
	 * @param {*} value
	 */
	invokeSetter(name, value) {
		const meta = this.computed.get(name);
		if (!meta || !meta.setter) return;
		try {
			meta.setter.call(this.componentProxy, value);
		} catch (error) {
			logger.error(`Error in setter for computed "${name}"`, error);
		}
	}

	/**
	 * Initialize watchers from definitions
	 * @param {Object} defs - { propName: callback, ... }
	 */
	setupWatchers(defs) {
		const entries = Object.entries(defs);
		for (let i = 0, len = entries.length; i < len; i++) {
			const [property, callback] = entries[i];
			if (typeof callback !== 'function') {
				logger.warn(`Watcher "${property}" is not a function, skipping`);
				continue;
			}
			// Function.length reports declared param count (rest/default excluded).
			// If the watcher only takes (newValue), we never need to snapshot oldValue.
			// This skips a per-fire shallow clone on the hot path.
			const needsOldValue = callback.length >= 2;
			const boundCallback = callback.bind(this.componentProxy);
			// Capture initial value — for computed, this triggers first evaluation.
			// Skip the clone when oldValue will never be read.
			const initialRaw = this.componentProxy[property];
			const initialValue = needsOldValue ? cloneValue(initialRaw) : undefined;
			this.watchers.set(property, {
				callback: boundCallback,
				oldValue: initialValue,
				needsOldValue
			});
		}
		logger.debug('Watchers registered', [...this.watchers.keys()]);
	}

	// ========================================================================
	// Computed Evaluation
	// ========================================================================

	/**
	 * Check if a name is a computed property
	 * @param {string} name
	 * @returns {boolean}
	 */
	has(name) {
		return this.computed.has(name);
	}

	/**
	 * Evaluate a computed property, returning cached value if clean.
	 * Performs dependency tracking and circular detection.
	 * @param {string} name
	 * @returns {*} Computed value
	 */
	evaluate(name) {
		const meta = this.computed.get(name);
		if (!meta) return undefined;

		// Return cached if clean
		if (!meta.dirty) return meta.cache;

		// Circular dependency check — scoped per manager (component)
		if (evaluationStack.some(e => e.manager === this && e.name === name)) {
			logger.error(`Circular computed dependency: ${getStackTrace()} \u2192 ${name}`);
			return meta.cache; // Return stale cache to avoid infinite loop
		}

		evaluationStack.push({ manager: this, name });
		const prev = startTracking();

		let value;
		try {
			value = meta.getter.call(this.componentProxy);
		} catch (error) {
			logger.error(`Error evaluating computed "${name}"`, error);
			value = meta.cache; // Keep stale cache on error
		}

		const oldDeps = meta.deps;
		meta.deps = stopTracking(prev);
		meta.cache = value;
		meta.dirty = false;

		this._updateDepIndex(name, oldDeps, meta.deps);

		evaluationStack.pop();

		return value;
	}

	/**
	 * Sync the reverse dep-index for a computed property when its deps change.
	 * Called after each evaluate(). Removes entries from the old deps map
	 * and adds entries from the new one.
	 */
	_updateDepIndex(name, oldDeps, newDeps) {
		if (oldDeps) {
			for (const [target, keys] of oldDeps) {
				const targetMap = this.depIndex.get(target);
				if (!targetMap) continue;
				for (const key of keys) {
					const computedSet = targetMap.get(key);
					if (computedSet) {
						computedSet.delete(name);
						if (computedSet.size === 0) targetMap.delete(key);
					}
				}
				if (targetMap.size === 0) {
					this.depIndex.delete(target);
					removeManagerInterest(target, this);
				}
			}
		}
		if (newDeps) {
			for (const [target, keys] of newDeps) {
				let targetMap = this.depIndex.get(target);
				if (!targetMap) {
					targetMap = new Map();
					this.depIndex.set(target, targetMap);
					addManagerInterest(target, this);
				}
				for (const key of keys) {
					let computedSet = targetMap.get(key);
					if (!computedSet) {
						computedSet = new Set();
						targetMap.set(key, computedSet);
					}
					computedSet.add(name);
				}
			}
		}
	}

	// ========================================================================
	// Invalidation
	// ========================================================================

	/**
	 * Invalidate computed properties that depend on (target, key).
	 * Re-evaluates the affected computed in dependency order, then fires
	 * bindings, dynamics and watchers for the ones whose value changed.
	 *
	 * Three phases, so every computed sees its inputs' NEW values:
	 *
	 * 1. Mark: everything downstream of the change (direct dependents, and
	 *    transitively the computed that read them) goes dirty before anything
	 *    is re-evaluated. A dirty computed read during phase 2 — by a getter,
	 *    in any order — evaluates fresh instead of returning a stale cache.
	 *
	 * 2. Settle, dependencies first: a computed is re-evaluated only when the
	 *    changed key feeds it directly or one of its computed dependencies
	 *    actually changed value. Otherwise its cache stands (marked clean
	 *    again), so an unchanged value still cuts the cascade off.
	 *
	 * 3. Fire, in the same dependency order, once every value has settled —
	 *    so a binding or watcher never observes a half-updated graph.
	 *
	 * The earlier single pass re-evaluated in discovery order and never
	 * revisited a computed: with list → pageCount → current → pageItems and
	 * list → pageItems, pageItems ran before `current` caught up, got the old
	 * page, and was then skipped when `current` changed (it stayed stale).
	 *
	 * @param {Object} target - Raw data target where change occurred
	 * @param {string} key - Property name that changed
	 * @param {Function} applyBindingsFn - applyBindings from Reactivity.js
	 * @param {Function} applyDynamicsFn - applyDynamics from Reactivity.js
	 */
	invalidate(target, key, applyBindingsFn, applyDynamicsFn) {
		// O(1) lookup of computed depending on (target, key) via reverse index.
		const targetMap = this.depIndex.get(target);
		if (!targetMap) return;
		const directly = targetMap.get(key);
		if (!directly || directly.size === 0) return;

		// Snapshot — evaluate() rewrites the index sets.
		const direct = new Set(directly);

		// Phase 1 — mark. Computed-to-computed deps are indexed as
		// (dataTarget, computedName).
		const rootMap = this.depIndex.get(this.dataTarget);
		const affected = new Map();   // name → { oldValue, wasDirty }, in discovery order
		const queue = [...direct];
		for (let i = 0; i < queue.length; i++) {
			const name = queue[i];
			if (affected.has(name)) continue;
			const meta = this.computed.get(name);
			if (!meta) continue;
			affected.set(name, { oldValue: meta.cache, wasDirty: meta.dirty });
			meta.dirty = true;
			const dependents = rootMap && rootMap.get(name);
			if (dependents) {
				for (const other of dependents) {
					if (!affected.has(other)) queue.push(other);
				}
			}
		}

		// Phase 2 — settle each affected computed after its affected dependencies.
		// changedByName: name → true/false once settled, VISITING while in progress.
		const VISITING = 0;
		const changedByName = new Map();
		const changedInOrder = [];
		const settle = (name) => {
			if (changedByName.has(name)) return changedByName.get(name) === true;
			changedByName.set(name, VISITING);
			const meta = this.computed.get(name);
			const entry = affected.get(name);
			if (!meta) {
				changedByName.set(name, false);
				return false;
			}

			let inputsChanged = direct.has(name);
			const computedDeps = meta.deps && meta.deps.get(this.dataTarget);
			if (computedDeps) {
				// Snapshot: settling a dependency never touches this computed's deps,
				// but evaluating this one (below) replaces them.
				for (const dep of [...computedDeps]) {
					if (dep !== name && affected.has(dep) && settle(dep)) inputsChanged = true;
				}
			}

			// Not dirty any more = a getter already pulled a fresh value during this pass.
			if (meta.dirty) {
				if (inputsChanged || entry.wasDirty) this.evaluate(name);
				else meta.dirty = false;   // nothing it reads changed: keep the cache
			}

			const changed = !Object.is(entry.oldValue, meta.cache);
			changedByName.set(name, changed);
			if (changed) changedInOrder.push(name);
			return changed;
		};
		for (const name of affected.keys()) settle(name);

		// Phase 3 — fire. A binding can unmount this component (an :if in a
		// parent), which destroys the manager; stop if that happens.
		for (const name of changedInOrder) {
			if (!this.dataTarget) return;
			const newValue = this.evaluate(name);
			applyBindingsFn(this.dataTarget, name, newValue);
			applyDynamicsFn(this.dataTarget, name, newValue);
			this._invokeComputedWatcher(name, newValue, affected.get(name).oldValue);
		}
	}

	// ========================================================================
	// Watchers
	// ========================================================================

	/**
	 * Invoke watcher for a data property change (called from the flush phase).
	 *
	 * The target guard matters: this manager is propagated to every nested
	 * target in the data tree, so without it a watcher on root-level `name`
	 * would also fire for `state.user.name` or `state.items[3].name` —
	 * any same-named key anywhere in the tree.
	 *
	 * @param {Object} target - Raw data target the change occurred on
	 * @param {string} key - Property name
	 * @param {*} newValue - New value
	 */
	invokeWatcher(target, key, newValue) {
		if (target !== this.dataTarget) return;

		const watcher = this.watchers.get(key);
		if (!watcher) return;

		// Skip if this is a computed property (handled by _invokeComputedWatcher)
		if (this.computed.has(key)) return;

		const oldValue = watcher.oldValue;
		if (watcher.needsOldValue) watcher.oldValue = cloneValue(newValue);

		try {
			watcher.callback(newValue, oldValue);
		} catch (error) {
			logger.error(`Error in watcher for "${key}"`, error);
		}
	}

	/**
	 * Invoke watcher for a computed property change (called from invalidate)
	 * @param {string} name - Computed property name
	 * @param {*} newValue
	 * @param {*} oldValue
	 */
	_invokeComputedWatcher(name, newValue, oldValue) {
		const watcher = this.watchers.get(name);
		if (!watcher) return;

		if (watcher.needsOldValue) watcher.oldValue = cloneValue(newValue);

		try {
			watcher.callback(newValue, oldValue);
		} catch (error) {
			logger.error(`Error in watcher for computed "${name}"`, error);
		}
	}

	// ========================================================================
	// Cleanup
	// ========================================================================

	/**
	 * Destroy the manager, removing all references for GC
	 */
	destroy() {
		// Withdraw interest registrations — without this, long-lived shared
		// targets (stores) would keep invalidating a dead manager.
		for (const target of this.depIndex.keys()) {
			removeManagerInterest(target, this);
		}
		this.computed.clear();
		this.watchers.clear();
		this.depIndex.clear();
		if (this.dataTarget) {
			managerMap.delete(this.dataTarget);
		}
		this.dataTarget = null;
		this.componentProxy = null;
	}
}
