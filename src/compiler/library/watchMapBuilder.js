/**
 * watchMapBuilder.js - Watch Map Generator
 *
 * Creates a mapping from reactive property names to binding indices.
 * When a property changes, the runtime looks up which bindings to update.
 *
 * Output format: { propertyName: [bindingIndex1, bindingIndex2, ...] }
 *
 * This allows O(1) lookup to find all bindings affected by a property change,
 * followed by direct bytecode iteration to update only those bindings.
 */

import { BIND_TYPE } from './detector.js';

/**
 * Build watch map from bindings
 * @param {object[]} bindings - Array of binding descriptors
 * @returns {object} Map of property name to binding indices
 */
export function buildWatchMap(bindings) {
	const watchMap = {};

	bindings.forEach((binding, index) => {
		// Get properties this binding depends on
		const properties = getBindingProperties(binding);

		for (const prop of properties) {
			if (!watchMap[prop]) {
				watchMap[prop] = [];
			}
			watchMap[prop].push(index);
		}
	});

	return watchMap;
}

/**
 * Get properties that a binding depends on
 * @param {object} binding - Binding descriptor
 * @returns {string[]} Array of property names
 */
function getBindingProperties(binding) {
	switch (binding.type) {
		case BIND_TYPE.TEXT:
		case BIND_TYPE.TEXT_EVAL:
		case BIND_TYPE.ATTR:
		case BIND_TYPE.ATTR_EVAL:
		case BIND_TYPE.TWO_WAY:
			return binding.properties || [];

		case BIND_TYPE.EVENT:
			// Events don't trigger on property changes
			// They're set up once at render time
			return [];

		default:
			return [];
	}
}

/**
 * Build optimized watch map as Uint16Array pairs
 * Format: [propIdx, bindingCount, binding1, binding2, ..., propIdx, bindingCount, ...]
 *
 * @param {object[]} bindings - Array of binding descriptors
 * @param {StringTable} stringTable - String table for property indices
 * @returns {Uint16Array} Packed watch map
 */
export function buildPackedWatchMap(bindings, stringTable) {
	const watchMap = buildWatchMap(bindings);
	const entries = [];

	for (const [prop, indices] of Object.entries(watchMap)) {
		const propIdx = stringTable.indexOf(prop);
		if (propIdx === -1) continue;

		entries.push(propIdx);
		entries.push(indices.length);
		entries.push(...indices);
	}

	return new Uint16Array(entries);
}

/**
 * Generate watch map as JavaScript object literal code
 * @param {object[]} bindings - Array of binding descriptors
 * @returns {string} JavaScript code for watch map object
 */
export function generateWatchMapCode(bindings) {
	const watchMap = buildWatchMap(bindings);

	if (Object.keys(watchMap).length === 0) {
		return '{}';
	}

	const entries = Object.entries(watchMap).map(([prop, indices]) => {
		return `\t${JSON.stringify(prop)}: [${indices.join(', ')}]`;
	});

	return `{\n${entries.join(',\n')}\n}`;
}

/**
 * Decode packed watch map for debugging
 * @param {Uint16Array} packed - Packed watch map
 * @param {string[]} strings - String table
 * @returns {object} Decoded watch map
 */
export function decodePackedWatchMap(packed, strings) {
	const result = {};
	let i = 0;

	while (i < packed.length) {
		const propIdx = packed[i++];
		const count = packed[i++];
		const prop = strings[propIdx];

		result[prop] = [];
		for (let j = 0; j < count; j++) {
			result[prop].push(packed[i++]);
		}
	}

	return result;
}

/**
 * Get statistics about watch map
 * @param {object} watchMap - Watch map object
 * @returns {object} Statistics
 */
export function getWatchMapStats(watchMap) {
	const properties = Object.keys(watchMap);
	const totalBindings = properties.reduce((sum, p) => sum + watchMap[p].length, 0);

	return {
		propertyCount: properties.length,
		totalBindings,
		avgBindingsPerProperty: properties.length ? (totalBindings / properties.length).toFixed(2) : 0,
		maxBindings: properties.length ? Math.max(...properties.map(p => watchMap[p].length)) : 0,
		properties: properties.map(p => ({
			name: p,
			bindings: watchMap[p].length
		})).sort((a, b) => b.bindings - a.bindings)
	};
}

export default {
	buildWatchMap,
	buildPackedWatchMap,
	generateWatchMapCode,
	decodePackedWatchMap,
	getWatchMapStats
};
