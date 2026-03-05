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
			const boundCallback = callback.bind(this.componentProxy);
			// Capture initial value — for computed, this triggers first evaluation
			const initialValue = cloneValue(this.componentProxy[property]);
			this.watchers.set(property, {
				callback: boundCallback,
				oldValue: initialValue
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

		meta.deps = stopTracking(prev);
		meta.cache = value;
		meta.dirty = false;

		evaluationStack.pop();

		return value;
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
		// Phase 1: Find directly affected computed properties
		const toProcess = [];
		for (const [name, meta] of this.computed) {
			if (!meta.deps) continue;
			const props = meta.deps.get(target);
			if (props && props.has(key)) {
				toProcess.push(name);
			}
		}

		if (toProcess.length === 0) return;

		// Phase 2: Process with cascade
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

			// If value changed, fire bindings and cascade
			if (!Object.is(oldValue, newValue)) {
				applyBindingsFn(this.dataTarget, name, newValue);
				applyDynamicsFn(this.dataTarget, name, newValue);

				// Invoke watcher for this computed property (if any)
				this._invokeComputedWatcher(name, newValue, oldValue);

				// Cascade: find computed that depend on this computed name
				for (const [otherName, otherMeta] of this.computed) {
					if (processed.has(otherName)) continue;
					if (!otherMeta.deps) continue;
					const props = otherMeta.deps.get(this.dataTarget);
					if (props && props.has(name)) {
						toProcess.push(otherName);
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
		watcher.oldValue = cloneValue(newValue);

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

		watcher.oldValue = cloneValue(newValue);

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
		if (this.dataTarget) {
			managerMap.delete(this.dataTarget);
		}
		this.dataTarget = null;
		this.componentProxy = null;
	}
}
