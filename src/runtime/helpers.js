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

import { TYPEOF } from './constants.js';

// ============================================================================
// Type Checks
// ============================================================================

/**
 * Checks if parameter is an object (not null)
 */
export function isObject(obj) {
	return (typeof obj === TYPEOF.OBJECT && obj !== null);
}

// ============================================================================
// Cloning
// ============================================================================

/**
 * Deep clone an object, handling Date, Set, Map, and Arrays
 */
export function deepClone(obj) {
	if (obj === null || typeof obj !== "object") {
		return obj;
	}

	if (obj instanceof Date) {
		return new Date(obj.getTime());
	}

	if (obj instanceof Set) {
		const copy = new Set();
		for (const item of obj) copy.add(deepClone(item));
		return copy;
	}

	if (obj instanceof Map) {
		const copy = new Map();
		for (const [key, value] of obj) copy.set(deepClone(key), deepClone(value));
		return copy;
	}

	const copy = Array.isArray(obj) ? [] : {};

	// Copy regular properties
	for (const key in obj) {
		if (obj.hasOwnProperty(key)) {
			copy[key] = deepClone(obj[key]);
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


