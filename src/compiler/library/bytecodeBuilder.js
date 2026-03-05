/**
 * bytecodeBuilder.js - Bytecode Generator
 *
 * Converts detected bindings into a Uint16Array bytecode format.
 * Uses variable-length entries to support arbitrary path depths.
 *
 * Bytecode Format (variable length per entry):
 * - TEXT:      [type, pathLen, ...path, refIdx]
 * - TEXT_EVAL: [type, pathLen, ...path, evalIdx, depsLen, ...depIndices]
 * - ATTR:      [type, pathLen, ...path, attrIdx, refIdx]
 * - ATTR_EVAL: [type, pathLen, ...path, attrIdx, evalIdx, depsLen, ...depIndices]
 * - TWO_WAY:   [type, pathLen, ...path, refIdx]
 * - EVENT:     [type, pathLen, ...path, eventNameIdx, eventConfigIdx]
 * - PROP:      [type, pathLen, ...path, propNameIdx, sourceKeyIdx]
 * - PROP_SYNC: [type, pathLen, ...path, propNameIdx, sourceKeyIdx]
 *
 * Path encoding:
 * - pathLen: number of indices in path (supports any depth)
 * - ...path: childNodes indices to traverse from root
 *
 * EVAL deps encoding:
 * - depsLen: number of dependency indices
 * - ...depIndices: indices into strings table for each dependency
 *
 * Example: path [0, 2, 1] with TEXT binding:
 *   [1, 3, 0, 2, 1, refIdx] (6 values total)
 *
 * refIdx = index into strings (property names)
 * evalIdx = index into eval array (expression functions)
 * attrIdx/eventIdx = index into strings for attribute/event names
 * depIndices = indices into strings for dependency property names
 */

import { BIND_TYPE } from './detector.js';

/**
 * Build bytecode from detected bindings
 * @param {object[]} bindings - Array of binding descriptors from detector
 * @param {StringTable} stringTable - String table for index lookups
 * @returns {object} Bytecode result with array and eval functions
 */
export function buildBytecode(bindings, stringTable) {
	const evalFunctions = [];
	const evalMap = new Map(); // For deduplication
	const bytecodeData = [];
	const eventCounter = { value: 0 };

	for (const binding of bindings) {
		const entry = encodeBinding(binding, stringTable, evalFunctions, evalMap, eventCounter);
		if (entry) {
			bytecodeData.push(...entry);
		}
	}

	return {
		bytecode: new Uint16Array(bytecodeData),
		evalFunctions,
		bindingCount: bindings.length
	};
}

/**
 * Encode a single binding into variable-length bytecode entry
 * @param {object} binding - Binding descriptor
 * @param {StringTable} stringTable - String table
 * @param {object[]} evalFunctions - Array to push eval expressions to
 * @param {Map} evalMap - Map for eval deduplication
 * @returns {number[]} Variable-length array of values
 */
function encodeBinding(binding, stringTable, evalFunctions, evalMap, eventCounter) {
	const path = binding.path || [];

	// Start with type and path
	const entry = [binding.type, path.length, ...path];

	switch (binding.type) {
		case BIND_TYPE.TEXT:
			// Simple text binding: {{ propertyName }}
			entry.push(stringTable.indexOf(binding.properties[0]));
			break;

		case BIND_TYPE.TEXT_EVAL:
			// Expression text binding: {{ count + 1 }}
			entry.push(addEvalFunction(evalFunctions, evalMap, binding.expression, binding.properties));
			break;

		case BIND_TYPE.ATTR:
			// Simple attribute/directive: :class="activeClass"
			entry.push(stringTable.indexOf(binding.attrName));
			entry.push(stringTable.indexOf(binding.properties[0]));
			break;

		case BIND_TYPE.ATTR_EVAL:
			// Expression attribute/directive: :class="active ? 'on' : 'off'"
			entry.push(stringTable.indexOf(binding.attrName));
			entry.push(addEvalFunction(evalFunctions, evalMap, binding.expression, binding.properties));
			break;

		case BIND_TYPE.TWO_WAY:
			// Two-way binding: :bind="value"
			entry.push(stringTable.indexOf(binding.properties[0]));
			break;

		case BIND_TYPE.EVENT:
			// Event handler: @click="handler"
			entry.push(stringTable.indexOf(binding.eventName));
			entry.push(eventCounter.value++);
			break;

		case BIND_TYPE.PROP:
		case BIND_TYPE.PROP_SYNC:
			// Prop binding: same format as ATTR [propNameIdx, sourceKeyIdx]
			entry.push(stringTable.indexOf(binding.attrName));
			entry.push(stringTable.indexOf(binding.properties[0]));
			break;

		default:
			// Unknown binding type - skip
			return null;
	}

	return entry;
}

/**
 * Add an eval function with deduplication
 * @param {object[]} evalFunctions - Eval function array
 * @param {Map} evalMap - Map for deduplication (expression -> index)
 * @param {string} expression - The expression string
 * @param {string[]} properties - Properties referenced in expression
 * @returns {number} Index in eval function array
 */
function addEvalFunction(evalFunctions, evalMap, expression, properties) {
	// Check if we already have this expression
	if (evalMap.has(expression)) {
		return evalMap.get(expression);
	}

	// Add new eval function
	const index = evalFunctions.length;
	evalFunctions.push({
		expression,
		properties
	});
	evalMap.set(expression, index);

	return index;
}

/**
 * Decode a single bytecode entry at given offset
 * @param {Uint16Array} bytecode - The bytecode array
 * @param {number} offset - Byte offset to start reading
 * @param {string[]} strings - String table
 * @returns {object} Decoded binding info with 'length' indicating entry size
 */
export function decodeBytecodeEntry(bytecode, offset, strings) {
	const type = bytecode[offset];
	const pathLen = bytecode[offset + 1];

	// Extract path
	const path = [];
	for (let i = 0; i < pathLen; i++) {
		path.push(bytecode[offset + 2 + i]);
	}

	// Data starts after path
	const dataOffset = offset + 2 + pathLen;

	const result = {
		type,
		typeName: getTypeName(type),
		path,
		length: 0 // Will be set based on type
	};

	switch (type) {
		case BIND_TYPE.TEXT:
			result.refIdx = bytecode[dataOffset];
			result.property = strings[result.refIdx];
			result.length = 2 + pathLen + 1; // type + pathLen + path + refIdx
			break;

		case BIND_TYPE.TEXT_EVAL: {
			// Format: [type, pathLen, ...path, evalIdx, depsLen, ...depIndices]
			result.evalIdx = bytecode[dataOffset];
			const depsLen = bytecode[dataOffset + 1];
			result.depsLen = depsLen;
			result.deps = [];
			for (let i = 0; i < depsLen; i++) {
				const depIdx = bytecode[dataOffset + 2 + i];
				result.deps.push(strings[depIdx]);
			}
			result.length = 2 + pathLen + 2 + depsLen; // +2 for evalIdx, depsLen
			break;
		}

		case BIND_TYPE.ATTR:
			result.attrIdx = bytecode[dataOffset];
			result.attrName = strings[result.attrIdx];
			result.refIdx = bytecode[dataOffset + 1];
			result.property = strings[result.refIdx];
			result.length = 2 + pathLen + 2;
			break;

		case BIND_TYPE.ATTR_EVAL: {
			// Format: [type, pathLen, ...path, attrIdx, evalIdx, depsLen, ...depIndices]
			result.attrIdx = bytecode[dataOffset];
			result.attrName = strings[result.attrIdx];
			result.evalIdx = bytecode[dataOffset + 1];
			const depsLen = bytecode[dataOffset + 2];
			result.depsLen = depsLen;
			result.deps = [];
			for (let i = 0; i < depsLen; i++) {
				const depIdx = bytecode[dataOffset + 3 + i];
				result.deps.push(strings[depIdx]);
			}
			result.length = 2 + pathLen + 3 + depsLen; // +3 for attrIdx, evalIdx, depsLen
			break;
		}

		case BIND_TYPE.TWO_WAY:
			result.refIdx = bytecode[dataOffset];
			result.property = strings[result.refIdx];
			result.length = 2 + pathLen + 1;
			break;

		case BIND_TYPE.EVENT:
			result.eventIdx = bytecode[dataOffset];
			result.eventName = strings[result.eventIdx];
			result.eventConfigIdx = bytecode[dataOffset + 1];
			result.length = 2 + pathLen + 2;
			break;

		case BIND_TYPE.PROP:
		case BIND_TYPE.PROP_SYNC:
			result.attrIdx = bytecode[dataOffset];
			result.attrName = strings[result.attrIdx];
			result.refIdx = bytecode[dataOffset + 1];
			result.property = strings[result.refIdx];
			result.length = 2 + pathLen + 2;
			break;

		default:
			result.length = 2 + pathLen; // Minimum size for unknown types
	}

	return result;
}

/**
 * Iterate over all bytecode entries
 * @param {Uint16Array} bytecode - The bytecode array
 * @param {string[]} strings - String table
 * @param {function} callback - Called with (entry, offset) for each binding
 */
export function iterateBytecode(bytecode, strings, callback) {
	let offset = 0;
	while (offset < bytecode.length) {
		const entry = decodeBytecodeEntry(bytecode, offset, strings);
		callback(entry, offset);
		offset += entry.length;
	}
}

/**
 * Get human-readable type name
 */
function getTypeName(type) {
	const names = {
		[BIND_TYPE.TEXT]: 'TEXT',
		[BIND_TYPE.TEXT_EVAL]: 'TEXT_EVAL',
		[BIND_TYPE.ATTR]: 'ATTR',
		[BIND_TYPE.ATTR_EVAL]: 'ATTR_EVAL',
		[BIND_TYPE.TWO_WAY]: 'TWO_WAY',
		[BIND_TYPE.EVENT]: 'EVENT',
		[BIND_TYPE.PROP]: 'PROP',
		[BIND_TYPE.PROP_SYNC]: 'PROP_SYNC'
	};
	return names[type] || 'UNKNOWN';
}

/**
 * Get total size of bytecode in bytes
 */
export function getBytecodeSize(bytecode) {
	return bytecode.byteLength;
}

/**
 * Count bindings in bytecode by iterating through variable-length entries
 * @param {Uint16Array} bytecode - The bytecode array
 * @returns {number} Number of bindings
 */
export function getBindingCount(bytecode) {
	let count = 0;
	let offset = 0;
	while (offset < bytecode.length) {
		const type = bytecode[offset];
		const pathLen = bytecode[offset + 1];
		const dataOffset = offset + 2 + pathLen;

		// Calculate entry length based on type
		let entryLen;
		switch (type) {
			case BIND_TYPE.TEXT:
			case BIND_TYPE.TWO_WAY:
				entryLen = 2 + pathLen + 1;
				break;
			case BIND_TYPE.TEXT_EVAL: {
				const depsLen = bytecode[dataOffset + 1];
				entryLen = 2 + pathLen + 2 + depsLen;
				break;
			}
			case BIND_TYPE.ATTR:
			case BIND_TYPE.EVENT:
			case BIND_TYPE.PROP:
			case BIND_TYPE.PROP_SYNC:
				entryLen = 2 + pathLen + 2;
				break;
			case BIND_TYPE.ATTR_EVAL: {
				const depsLen = bytecode[dataOffset + 2];
				entryLen = 2 + pathLen + 3 + depsLen;
				break;
			}
			default:
				entryLen = 2 + pathLen + 1;
		}

		offset += entryLen;
		count++;
	}
	return count;
}

export default {
	buildBytecode,
	decodeBytecodeEntry,
	iterateBytecode,
	getBytecodeSize,
	getBindingCount
};
