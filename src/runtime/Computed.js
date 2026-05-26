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
	 * Initialize computed property metadata from definitions
	 * @param {Object} defs - { propName: getter, ... }
	 */
	setupComputed(defs) {
		const entries = Object.entries(defs);
		for (let i = 0, len = entries.length; i < len; i++) {
			const [name, getter] = entries[i];
			if (typeof getter !== 'function') {
				logger.warn(`Computed "${name}" is not a function, skipping`);
				continue;
			}
			this.computed.set(name, {
				getter,
				cache: undefined,
				dirty: true,
				deps: null
			});
		}
		logger.debug('Computed properties registered', [...this.computed.keys()]);
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
				if (targetMap.size === 0) this.depIndex.delete(target);
			}
		}
		if (newDeps) {
			for (const [target, keys] of newDeps) {
				let targetMap = this.depIndex.get(target);
				if (!targetMap) {
					targetMap = new Map();
					this.depIndex.set(target, targetMap);
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
	 * Re-evaluates dirty computed, fires bindings for changed values, cascades.
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

		// Snapshot to an array — cascade may push more entries, and evaluate()
		// inside the loop can mutate the index sets.
		const toProcess = [...directly];

		const processed = new Set();
		let i = 0;
		while (i < toProcess.length) {
			const name = toProcess[i++];
			if (processed.has(name)) continue;
			processed.add(name);

			const meta = this.computed.get(name);
			const oldValue = meta.cache;
			meta.dirty = true;

			// Re-evaluate
			const newValue = this.evaluate(name);

			// If value changed, fire bindings and cascade.
			if (!Object.is(oldValue, newValue)) {
				applyBindingsFn(this.dataTarget, name, newValue);
				applyDynamicsFn(this.dataTarget, name, newValue);

				this._invokeComputedWatcher(name, newValue, oldValue);

				// Cascade via the reverse index: find computed that read THIS
				// computed (deps stored as (dataTarget, name)).
				const rootMap = this.depIndex.get(this.dataTarget);
				if (rootMap) {
					const dependents = rootMap.get(name);
					if (dependents) {
						for (const otherName of dependents) {
							if (!processed.has(otherName)) toProcess.push(otherName);
						}
					}
				}
			}
		}
	}

	// ========================================================================
	// Watchers
	// ========================================================================

	/**
	 * Invoke watcher for a data property change (called from queueUpdate)
	 * @param {string} key - Property name
	 * @param {*} newValue - New value
	 */
	invokeWatcher(key, newValue) {
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
