/**
 * helpers.js - Utility Functions
 *
 * Core utilities used across the framework.
 *
 * Sections:
 * - Type Checks
 * - Cloning
 * - DOM Utilities
 */

// ============================================================================
// Type Checks
// ============================================================================

/**
 * Checks if parameter is an object (not null)
 */
export function isObject(obj) {
	return (typeof obj === 'object' && obj !== null);
}

// ============================================================================
// Cloning
// ============================================================================

/**
 * Deep clone an object, handling Date, Set, Map, and Arrays.
 * Cycle-safe: a structure that references itself clones to a structure
 * whose copies reference each other the same way.
 */
export function deepClone(obj, seen = new WeakMap()) {
	if (obj === null || typeof obj !== "object") {
		return obj;
	}

	const cached = seen.get(obj);
	if (cached) return cached;

	if (obj instanceof Date) {
		return new Date(obj.getTime());
	}

	if (obj instanceof Set) {
		const copy = new Set();
		seen.set(obj, copy);
		for (const item of obj) copy.add(deepClone(item, seen));
		return copy;
	}

	if (obj instanceof Map) {
		const copy = new Map();
		seen.set(obj, copy);
		for (const [key, value] of obj) copy.set(deepClone(key, seen), deepClone(value, seen));
		return copy;
	}

	const copy = Array.isArray(obj) ? [] : {};
	seen.set(obj, copy);

	// Copy regular properties
	for (const key in obj) {
		if (obj.hasOwnProperty(key)) {
			copy[key] = deepClone(obj[key], seen);
		}
	}

	// Copy Symbol properties
	const symbols = Object.getOwnPropertySymbols(obj);
	for (let i = 0, len = symbols.length; i < len; i++) {
		const sym = symbols[i];
		copy[sym] = obj[sym];  // Don't deep clone symbols themselves, just copy the reference
	}

	return copy;
}

/**
 * Clone a value for old value tracking
 * Handles primitives, objects, and arrays (shallow clone)
 * @param {*} value - Value to clone
 * @returns {*} Cloned value
 */
export function cloneValue(value) {
	if (value === null || value === undefined) {
		return value;
	}

	// Primitives are passed by value
	if (typeof value !== 'object') {
		return value;
	}

	// Arrays
	if (Array.isArray(value)) {
		return [...value];
	}

	// Plain objects
	if (value.constructor === Object) {
		return { ...value };
	}

	// For other object types (Date, Map, Set, etc.), return as-is
	return value;
}

// ============================================================================
// DOM Utilities
// ============================================================================

/**
 * Execute callback when DOM is ready
 * @param {Function} callback - Function to execute
 */
export function onReady(callback) {
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', callback);
	} else {
		callback();
	}
}


