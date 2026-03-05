/**
 * stringTable.js - String Table Builder
 *
 * Builds a deduplicated string table for the bytecode.
 * All strings (property names, attribute names, event names, etc.)
 * are stored once and referenced by index.
 *
 * This keeps the Uint16Array clean - only numbers, no string refs.
 */

/**
 * StringTable class - builds and manages string indices
 */
export class StringTable {
	constructor() {
		/** @type {string[]} */
		this.strings = [];
		/** @type {Map<string, number>} */
		this.indexMap = new Map();
	}

	/**
	 * Add a string and return its index
	 * If string already exists, returns existing index
	 * @param {string} str - String to add
	 * @returns {number} Index in string table
	 */
	add(str) {
		if (str === null || str === undefined) {
			return -1;
		}

		const strValue = String(str);

		if (this.indexMap.has(strValue)) {
			return this.indexMap.get(strValue);
		}

		const index = this.strings.length;
		this.strings.push(strValue);
		this.indexMap.set(strValue, index);
		return index;
	}

	/**
	 * Add multiple strings at once
	 * @param {string[]} strs - Strings to add
	 * @returns {number[]} Array of indices
	 */
	addAll(strs) {
		return strs.map(s => this.add(s));
	}

	/**
	 * Get index of an existing string
	 * @param {string} str - String to find
	 * @returns {number} Index or -1 if not found
	 */
	indexOf(str) {
		return this.indexMap.get(String(str)) ?? -1;
	}

	/**
	 * Get string at index
	 * @param {number} index - Index in table
	 * @returns {string|undefined} String at index
	 */
	get(index) {
		return this.strings[index];
	}

	/**
	 * Check if string exists in table
	 * @param {string} str - String to check
	 * @returns {boolean}
	 */
	has(str) {
		return this.indexMap.has(String(str));
	}

	/**
	 * Get the number of strings in table
	 * @returns {number}
	 */
	get size() {
		return this.strings.length;
	}

	/**
	 * Get the final string array
	 * @returns {string[]}
	 */
	toArray() {
		return [...this.strings];
	}

	/**
	 * Serialize to JSON-compatible object
	 * @returns {string[]}
	 */
	toJSON() {
		return this.strings;
	}

	/**
	 * Create from existing string array
	 * @param {string[]} strings - Existing strings
	 * @returns {StringTable}
	 */
	static from(strings) {
		const table = new StringTable();
		for (const str of strings) {
			table.add(str);
		}
		return table;
	}
}

/**
 * Build a string table from detected bindings
 * Extracts all strings that need to be in the table
 * @param {object} detection - Result from detector.detectBindings
 * @returns {StringTable}
 */
export function buildStringTable(detection) {
	const table = new StringTable();
	const { bindings, dynamics } = detection;

	// Process bindings
	for (const binding of bindings) {
		// Properties (data keys) - the primary watch targets
		if (binding.properties) {
			for (const prop of binding.properties) {
				table.add(prop);
			}
		}

		// Attribute names
		if (binding.attrName) {
			table.add(binding.attrName);
		}

		// Event names
		if (binding.eventName) {
			table.add(binding.eventName);
		}

		// Handler method names
		if (binding.handler?.method) {
			table.add(binding.handler.method);
		}

		// Handler args (for method calls)
		if (binding.handler?.args) {
			table.add(binding.handler.args);
		}

		// Ref names
		if (binding.refName) {
			table.add(binding.refName);
		}

		// Slot names
		if (binding.slotName) {
			table.add(binding.slotName);
		}

		// Component type
		if (binding.componentType) {
			table.add(binding.componentType);
		}

		// Note: Expressions are NOT added to string table
		// They go directly to the eval array
	}

	// Process dynamics
	for (const dynamic of dynamics) {
		// :for variables
		if (dynamic.iteratorVar) {
			table.add(dynamic.iteratorVar);
		}
		if (dynamic.indexVar) {
			table.add(dynamic.indexVar);
		}
		if (dynamic.source) {
			table.add(dynamic.source);
		}

		// :if conditions
		if (dynamic.condition) {
			table.add(dynamic.condition);
		}

		// Properties
		if (dynamic.properties) {
			for (const prop of dynamic.properties) {
				table.add(prop);
			}
		}
	}

	return table;
}

export default {
	StringTable,
	buildStringTable
};
