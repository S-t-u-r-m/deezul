/**
 * detector.js - Binding Detection
 *
 * Walks the AST and detects all binding types:
 * - Text bindings: 'binding' nodes (already split by parser)
 * - Bound attributes: :attr="expression"
 * - Events: @event="handler"
 * - Two-way binding: :bind="value"
 * - Directives: :for, :if, :else-if, :else
 * - Refs: ref="name"
 * - Slots: slot="name", <slot>
 * - Components: <dz-component>
 *
 * NOTE: The parser already splits text on {{ }} interpolations,
 * so we receive 'binding' nodes directly - no regex scanning needed.
 *
 * Returns a flat array of binding descriptors with positions.
 */

import { walkAST } from './parser.js';

/**
 * Binding type constants - reactive bindings for Uint16Array bytecode
 *
 * Note: Custom directives are detected at runtime, not compile time.
 * ATTR/ATTR_EVAL handles both bound attributes and directives -
 * runtime checks if attrName is a registered directive.
 */
export const BIND_TYPE = {
	TEXT: 1,           // Simple property: {{ count }}
	TEXT_EVAL: 2,      // Expression: {{ count + 1 }}
	ATTR: 3,           // Simple attr/directive: :class="activeClass"
	ATTR_EVAL: 4,      // Expression attr/directive: :class="active ? 'on' : 'off'"
	TWO_WAY: 5,        // :bind="value"
	EVENT: 6,          // @click="handler"
	PROP: 7,           // One-way prop: :count="parentCount" on component
	PROP_SYNC: 8       // Two-way prop: :count.sync="parentCount" on component
};

/**
 * Dynamic structure types - handled separately, not in bytecode
 */
export const DYNAMIC_TYPE = {
	FOR: 1,            // :for
	IF: 2,             // :if
	ELSE_IF: 3,        // :else-if
	ELSE: 4            // :else
};

/**
 * Event handler type constants
 */
export const HANDLER_TYPE = {
	METHOD: 0,     // methodName
	CALL: 1,       // methodName(args)
	INLINE: 2      // () => expr or expr; expr
};

/**
 * Regex patterns
 */
const SIMPLE_PATH_REGEX = /^[a-zA-Z_$][a-zA-Z0-9_$]*(\.[a-zA-Z_$][a-zA-Z0-9_$]*|\[[^\]]+\])*$/;
const METHOD_CALL_REGEX = /^([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(([^)]*)\)$/;

/**
 * Check if an expression is a simple property path (no operators/calls)
 * e.g., "count", "item.name", "items[0].active"
 */
function isSimplePath(expr) {
	return SIMPLE_PATH_REGEX.test(expr.trim());
}

/**
 * Check if expression needs eval function (has operators, ternary, etc.)
 */
function needsEvalFn(expr) {
	const trimmed = expr.trim();
	// Has operators, ternary, function calls, etc.
	return !isSimplePath(trimmed) ||
		trimmed.includes('?') ||
		trimmed.includes('+') ||
		trimmed.includes('-') ||
		trimmed.includes('*') ||
		trimmed.includes('/') ||
		trimmed.includes('!') ||
		trimmed.includes('&&') ||
		trimmed.includes('||') ||
		trimmed.includes('(');
}

/**
 * Extract property paths from an expression
 * Returns all standalone property references (skipping string literals)
 */
function extractPropertyPaths(expr) {
	const paths = new Set();

	// First, remove string literals to avoid matching identifiers inside them
	// Replace 'string', "string", and `template` with empty placeholders
	const noStrings = expr
		.replace(/'(?:[^'\\]|\\.)*'/g, '""')
		.replace(/"(?:[^"\\]|\\.)*"/g, '""')
		.replace(/`(?:[^`\\]|\\.)*`/g, '""');

	// Match property access patterns
	// Matches: identifier, identifier.path, identifier[index]
	const propRegex = /\b([a-zA-Z_$][a-zA-Z0-9_$]*(?:\.[a-zA-Z_$][a-zA-Z0-9_$]*|\[[^\]]+\])*)\b/g;
	let match;

	while ((match = propRegex.exec(noStrings)) !== null) {
		const path = match[1];
		// Skip keywords and globals
		if (!isKeyword(path) && !isGlobal(path)) {
			// Get root property (first segment)
			const root = path.split(/[.\[]/)[0];
			paths.add(root);
		}
	}

	return Array.from(paths);
}

/**
 * Check if identifier is a global object (shouldn't be tracked as reactive)
 */
function isGlobal(str) {
	const globals = new Set([
		'Math', 'Date', 'JSON', 'Array', 'Object', 'String', 'Number', 'Boolean',
		'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'console', 'window', 'document',
		'RegExp', 'Error', 'Promise', 'Set', 'Map', 'WeakSet', 'WeakMap', 'Symbol',
		'Infinity', 'NaN', 'encodeURI', 'decodeURI', 'encodeURIComponent', 'decodeURIComponent'
	]);
	return globals.has(str);
}

/**
 * Check if a string is a JavaScript keyword
 */
function isKeyword(str) {
	const keywords = new Set([
		'true', 'false', 'null', 'undefined', 'this',
		'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'return',
		'function', 'var', 'let', 'const', 'class', 'new', 'delete', 'typeof', 'instanceof',
		'in', 'of', 'try', 'catch', 'finally', 'throw', 'async', 'await', 'yield',
		'import', 'export', 'default', 'from'
	]);
	return keywords.has(str);
}

/**
 * Parse :for expression
 * Supports: "item in items", "(item, index) in items"
 */
function parseForExpression(expr) {
	const match = expr.match(/^\s*(?:\(?\s*(\w+)(?:\s*,\s*(\w+))?\s*\)?)\s+(?:in|of)\s+(.+)\s*$/);
	if (!match) {
		throw new Error(`Invalid :for expression: "${expr}"`);
	}
	return {
		iteratorVar: match[1],
		indexVar: match[2] || null,
		source: match[3].trim()
	};
}

/**
 * Parse mixed attribute content with {{ }} interpolations
 * Converts: "red {{ isRed ? 'green' : 'blue' }} {{ otherClass }}"
 * Into: "'red ' + (isRed ? 'green' : 'blue') + ' ' + otherClass"
 *
 * @param {string} value - Attribute value with interpolations
 * @returns {object} { expression: string, properties: string[] }
 */
function parseMixedAttributeContent(value) {
	const parts = [];
	const properties = new Set();
	let lastIndex = 0;

	// Match {{ expression }} patterns
	const regex = /\{\{\s*(.+?)\s*\}\}/g;
	let match;

	while ((match = regex.exec(value)) !== null) {
		// Add static text before this match
		if (match.index > lastIndex) {
			const staticText = value.slice(lastIndex, match.index);
			if (staticText) {
				parts.push(JSON.stringify(staticText));
			}
		}

		// Add the expression (wrapped in parens for safety)
		const expr = match[1];
		parts.push(`(${expr})`);

		// Extract properties from this expression
		for (const prop of extractPropertyPaths(expr)) {
			properties.add(prop);
		}

		lastIndex = match.index + match[0].length;
	}

	// Add any remaining static text
	if (lastIndex < value.length) {
		const staticText = value.slice(lastIndex);
		if (staticText) {
			parts.push(JSON.stringify(staticText));
		}
	}

	// Join all parts with +
	const expression = parts.join(' + ') || '""';

	return {
		expression,
		properties: Array.from(properties)
	};
}

/**
 * Parse event handler expression
 */
function parseEventHandler(expr) {
	const trimmed = expr.trim();

	// Inline: has => or multiple statements
	if (trimmed.includes('=>') || trimmed.includes(';')) {
		return { type: HANDLER_TYPE.INLINE, expression: trimmed };
	}

	// Method call: handler(args)
	const callMatch = trimmed.match(METHOD_CALL_REGEX);
	if (callMatch) {
		return {
			type: HANDLER_TYPE.CALL,
			method: callMatch[1],
			args: callMatch[2].trim()
		};
	}

	// Simple method reference: handler
	if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(trimmed)) {
		return { type: HANDLER_TYPE.METHOD, method: trimmed };
	}

	// Complex expression
	return { type: HANDLER_TYPE.INLINE, expression: trimmed };
}

/**
 * Calculate tree path from root to node
 * Path is array of childNodes indices: [0, 2, 1] means root.childNodes[0].childNodes[2].childNodes[1]
 * @param {object} node - AST node
 * @param {object} parent - Parent AST node
 * @param {number} indexInParent - Node's index in parent.children
 * @param {Map} pathMap - Map of node to its path array
 * @returns {number[]} Path array
 */
function calculatePath(node, parent, indexInParent, pathMap) {
	if (!parent || parent.type === 'root') {
		// Direct child of root
		return [indexInParent];
	}

	const parentPath = pathMap.get(parent) || [];
	return [...parentPath, indexInParent];
}

/**
 * Detect all bindings in an AST
 * @param {object} ast - Parsed AST from parser.js
 * @returns {object} Detection result with bindings and metadata
 */
export function detectBindings(ast) {
	const bindings = [];
	const dynamics = [];
	const slots = [];
	const pathMap = new Map(); // node -> tree path

	walkAST(ast, (node, parent, indexInParent) => {
		if (node.type === 'root') return;

		// Calculate tree path for this node
		const path = calculatePath(node, parent, indexInParent, pathMap);
		pathMap.set(node, path);

		// Binding node (text interpolation, already split by parser)
		if (node.type === 'binding') {
			detectBindingNode(node, path, bindings);
			return;
		}

		// Text node - static, no bindings needed
		if (node.type === 'text') {
			return;
		}

		// Element node
		if (node.type === 'element') {
			// Check for <slot> element
			if (node.tag === 'slot') {
				detectSlotElement(node, path, slots);
			}
			detectElementBindings(node, path, bindings, dynamics);
		}
	});

	return { bindings, dynamics, slots };
}

/**
 * Detect <slot> element
 * Slots define insertion points for parent-provided content
 * @param {object} node - Slot element AST node
 * @param {number[]} path - Tree path to node
 * @param {object[]} slots - Array to push slot definitions to
 */
function detectSlotElement(node, path, slots) {
	const attrs = node.attributes || {};
	const name = attrs.name || 'default';

	slots.push({
		name,
		path,
		position: node.start,
		// If slot has fallback content (children), mark it
		hasFallback: node.children && node.children.length > 0
	});
}

/**
 * Detect binding from a 'binding' AST node (already split by parser)
 * These are the {{ expression }} interpolations
 */
function detectBindingNode(node, path, bindings) {
	const expr = node.expression;
	const isEval = needsEvalFn(expr);

	bindings.push({
		type: isEval ? BIND_TYPE.TEXT_EVAL : BIND_TYPE.TEXT,
		path,
		position: node.start,
		expression: expr,
		properties: extractPropertyPaths(expr),
		isEval
	});
}

/**
 * Detect element bindings (attributes, events, directives)
 */
function detectElementBindings(node, path, bindings, dynamics) {
	const attrs = node.attributes || {};
	const isComponent = node.tag.includes('-');

	// Process each attribute
	for (const [name, value] of Object.entries(attrs)) {

		// :for directive
		if (name === ':for') {
			const parsed = parseForExpression(value);
			dynamics.push({
				type: DYNAMIC_TYPE.FOR,
				path,
				position: node.start,
				node,
				...parsed
			});
			continue;
		}

		// :if directive
		if (name === ':if') {
			dynamics.push({
				type: DYNAMIC_TYPE.IF,
				path,
				position: node.start,
				node,
				condition: value,
				properties: extractPropertyPaths(value)
			});
			continue;
		}

		// :else-if directive
		if (name === ':else-if') {
			dynamics.push({
				type: DYNAMIC_TYPE.ELSE_IF,
				path,
				position: node.start,
				node,
				condition: value,
				properties: extractPropertyPaths(value)
			});
			continue;
		}

		// :else directive
		if (name === ':else') {
			dynamics.push({
				type: DYNAMIC_TYPE.ELSE,
				path,
				position: node.start,
				node
			});
			continue;
		}

		// Event binding: @event="handler"
		if (name.startsWith('@')) {
			const eventName = name.slice(1);
			const handler = parseEventHandler(value);

			bindings.push({
				type: BIND_TYPE.EVENT,
				path,
				position: node.start,
				eventName,
				handler
			});
			continue;
		}

		// Bound attribute: :attr="expr"
		if (name.startsWith(':')) {
			const attrName = name.slice(1);

			// Two-way binding: :bind on form elements
			if (attrName === 'bind' && isFormElement(node.tag)) {
				bindings.push({
					type: BIND_TYPE.TWO_WAY,
					path,
					position: node.start,
					expression: value,
					properties: extractPropertyPaths(value)
				});
				continue;
			}

			// Check for .sync modifier
			const isSync = attrName.endsWith('.sync');
			const cleanAttrName = isSync ? attrName.slice(0, -5) : attrName;

			// Check for mixed content with {{ }} interpolations
			const hasMixedContent = value.includes('{{') && value.includes('}}');

			if (hasMixedContent) {
				// Parse mixed content into a single concatenation expression
				const { expression, properties } = parseMixedAttributeContent(value);
				bindings.push({
					type: BIND_TYPE.ATTR_EVAL,
					path,
					position: node.start,
					attrName: cleanAttrName,
					expression,
					properties,
					isEval: true,
					isSync
				});
			} else {
				const isEval = needsEvalFn(value);

				// Component + simple path = PROP or PROP_SYNC
				let type;
				if (isComponent && !isEval) {
					type = isSync ? BIND_TYPE.PROP_SYNC : BIND_TYPE.PROP;
				} else {
					type = isEval ? BIND_TYPE.ATTR_EVAL : BIND_TYPE.ATTR;
				}

				bindings.push({
					type,
					path,
					position: node.start,
					attrName: cleanAttrName,
					expression: value,
					properties: extractPropertyPaths(value),
					isEval,
					isSync
				});
			}
			continue;
		}
	}
}

/**
 * Check if tag is a form element (for two-way binding)
 */
function isFormElement(tag) {
	return tag === 'input' || tag === 'textarea' || tag === 'select';
}

export default {
	BIND_TYPE,
	HANDLER_TYPE,
	detectBindings,
	parseForExpression,
	parseEventHandler,
	extractPropertyPaths,
	needsEvalFn,
	isSimplePath,
	DYNAMIC_TYPE
};
