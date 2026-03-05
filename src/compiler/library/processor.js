/**
 * processor.js - Single-Pass AST Processor
 *
 * Optimized processor that combines:
 * - Binding detection
 * - Slot detection
 * - Dynamic detection
 * - String table building
 * - HTML generation
 *
 * All in a single AST traversal for maximum performance.
 */

import { BIND_TYPE, DYNAMIC_TYPE, HANDLER_TYPE } from './detector.js';

/** Regex patterns */
const SIMPLE_PATH_REGEX = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;
const METHOD_CALL_REGEX = /^([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(([^)]*)\)$/;

/** Keywords and globals to skip */
const KEYWORDS = new Set([
	'true', 'false', 'null', 'undefined', 'this',
	'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'return',
	'function', 'var', 'let', 'const', 'class', 'new', 'delete', 'typeof', 'instanceof',
	'in', 'of', 'try', 'catch', 'finally', 'throw', 'async', 'await', 'yield',
	'import', 'export', 'default', 'from'
]);

const GLOBALS = new Set([
	'Math', 'Date', 'JSON', 'Array', 'Object', 'String', 'Number', 'Boolean',
	'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'console', 'window', 'document',
	'RegExp', 'Error', 'Promise', 'Set', 'Map', 'WeakSet', 'WeakMap', 'Symbol',
	'Infinity', 'NaN', 'encodeURI', 'decodeURI', 'encodeURIComponent', 'decodeURIComponent'
]);

/** Void elements (self-closing) */
const VOID_ELEMENTS = new Set([
	'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
	'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

/** Reactive attribute prefixes to strip from HTML */
const REACTIVE_PREFIXES = [':', '@'];

/** Dynamic directives to strip */
const DYNAMIC_DIRECTIVES = new Set([':for', ':if', ':else-if', ':else']);

/**
 * Process AST in a single pass
 * Returns all compilation artifacts at once
 *
 * @param {object} ast - Parsed AST from parser.js
 * @param {Set} [loopVars] - Iterator/index variable names (for :for loop inner templates)
 * @returns {object} Complete processing result
 */
export function processAST(ast, loopVars) {
	const bindings = [];
	const dynamics = [];
	const slots = [];
	const refs = [];
	const htmlParts = [];

	// String table with inline building
	const strings = [];
	const stringMap = new Map();

	/**
	 * Add string to table, return index
	 */
	function addString(str) {
		if (str === null || str === undefined) return -1;
		const s = String(str);
		if (stringMap.has(s)) return stringMap.get(s);
		const idx = strings.length;
		strings.push(s);
		stringMap.set(s, idx);
		return idx;
	}

	/**
	 * Process a node recursively
	 * @param {object} node - AST node
	 * @param {number[]} path - Tree path from root to this node
	 */
	function processNode(node, path = [], pre = false) {
		if (node.type === 'root') {
			const children = node.children || [];
			if (children.length === 1 && children[0].type === 'element') {
				// Single root element: start with empty path.
				// Runtime root IS this element, so paths are relative to it.
				processNode(children[0], [], pre);
			} else {
				for (let i = 0; i < children.length; i++) {
					processNode(children[i], [i], pre);
				}
			}
			return;
		}

		switch (node.type) {
			case 'binding':
				if (pre) {
					// :pre mode — output {{ expression }} as literal text
					htmlParts.push('{{ ' + node.expression + ' }}');
				} else {
					processBindingNode(node, path);
				}
				break;

			case 'text':
				if (pre) {
					// In :pre mode, re-encode entities the parser decoded
					// and preserve whitespace (for <pre>/<code> blocks)
					htmlParts.push(escapeHTML(node.content));
				} else {
					// Collapse whitespace in text nodes
					htmlParts.push(node.content.replace(/\s+/g, ' '));
				}
				break;

			case 'element':
				processElementNode(node, path, pre);
				break;

			case 'comment':
				htmlParts.push(`<!--${node.content}-->`);
				break;
		}
	}

	/**
	 * Process text binding {{ expression }}
	 */
	function processBindingNode(node, path) {
		const expr = node.expression;
		let isEval = needsEvalFn(expr);
		const properties = extractPropertyPaths(expr);

		// In a :for loop, dotted iterator access (e.g. "user.name") must be TEXT_EVAL
		// because TEXT bindings only store the root identifier and lose the property path
		if (!isEval && loopVars) {
			const trimmed = expr.trim();
			const root = trimmed.split(/[.\[]/)[0];
			if (loopVars.has(root) && trimmed !== root) {
				isEval = true;
			}
		}

		// Add properties to string table
		for (const prop of properties) {
			addString(prop);
		}

		bindings.push({
			type: isEval ? BIND_TYPE.TEXT_EVAL : BIND_TYPE.TEXT,
			path,
			expression: expr,
			properties,
			isEval
		});

		// Wrap in <span> to prevent innerHTML text node merging.
		// Adjacent text + binding would merge into one text node otherwise,
		// making path-based access impossible.
		htmlParts.push('<span>\u200B</span>');
	}

	/**
	 * Process element node
	 */
	function processElementNode(node, path, pre = false) {
		const tag = node.tag;
		const attrs = node.attributes || {};
		const isComponent = tag.includes('-');

		// Check for :pre directive — skip all binding detection for this subtree
		if (attrs[':pre'] !== undefined) {
			pre = true;
		}

		// In :pre mode, output raw HTML without any binding processing
		if (pre) {
			const staticAttrs = [];
			for (const [name, value] of Object.entries(attrs)) {
				// Strip all Deezul directives and :pre itself
				if (name === ':pre') continue;
				if (name.startsWith(':') || name.startsWith('@')) continue;
				if (value === '' || value === true) {
					staticAttrs.push(name);
				} else {
					staticAttrs.push(`${name}="${escapeAttr(value)}"`);
				}
			}
			const attrStr = staticAttrs.length > 0 ? ' ' + staticAttrs.join(' ') : '';
			const isVoid = VOID_ELEMENTS.has(tag);
			const hasChildren = node.children && node.children.length > 0;

			if (isVoid && !hasChildren) {
				htmlParts.push(`<${tag}${attrStr} />`);
			} else {
				htmlParts.push(`<${tag}${attrStr}>`);
				const children = node.children || [];
				for (let i = 0; i < children.length; i++) {
					processNode(children[i], [...path, i], true);
				}
				htmlParts.push(`</${tag}>`);
			}
			return;
		}

		// Check for dynamic directives FIRST - these replace the element with a marker
		// :for - outputs marker, element becomes loop template
		if (attrs[':for'] !== undefined) {
			const value = attrs[':for'];
			const parsed = parseForExpression(value);
			dynamics.push({
				type: DYNAMIC_TYPE.FOR,
				path,
				node,
				...parsed
			});
			addString(parsed.iteratorVar);
			if (parsed.indexVar) addString(parsed.indexVar);
			addString(parsed.source);
			// Output comment marker instead of element
			htmlParts.push(`<!--for-->`);
			return; // Don't render element - it's the loop template
		}

		// :if - outputs marker, starts conditional chain
		if (attrs[':if'] !== undefined) {
			const value = attrs[':if'];
			const properties = extractPropertyPaths(value);
			dynamics.push({
				type: DYNAMIC_TYPE.IF,
				path,
				node,
				condition: value,
				properties
			});
			for (const prop of properties) addString(prop);
			// Output comment marker instead of element
			htmlParts.push(`<!--if-->`);
			return; // Don't render element - it's a conditional branch
		}

		// :else-if - no marker (shares marker with :if), adds to conditional chain
		if (attrs[':else-if'] !== undefined) {
			const value = attrs[':else-if'];
			const properties = extractPropertyPaths(value);
			dynamics.push({
				type: DYNAMIC_TYPE.ELSE_IF,
				path,
				node,
				condition: value,
				properties
			});
			for (const prop of properties) addString(prop);
			return; // Don't render - shares marker with preceding :if
		}

		// :else - no marker (shares marker with :if), ends conditional chain
		if (attrs[':else'] !== undefined) {
			dynamics.push({
				type: DYNAMIC_TYPE.ELSE,
				path,
				node
			});
			return; // Don't render - shares marker with preceding :if
		}

		// Check for slot element
		if (tag === 'slot') {
			const name = attrs.name || 'default';
			slots.push({
				name,
				path,
				hasFallback: node.children && node.children.length > 0
			});
		}

		// Process attributes for bindings
		const staticAttrs = [];

		for (const [name, value] of Object.entries(attrs)) {
			// Event binding @event="handler"
			if (name.startsWith('@')) {
				const eventName = name.slice(1);
				const handler = parseEventHandler(value);

				addString(eventName);
				if (handler.method) addString(handler.method);
				if (handler.args) addString(handler.args);

				bindings.push({
					type: BIND_TYPE.EVENT,
					path,
					eventName,
					handler
				});
				continue;
			}

			// Bound attribute :attr="expr"
			if (name.startsWith(':')) {
				const attrName = name.slice(1);

				// Two-way binding (:model="prop" on form elements)
				if (attrName === 'model' && isFormElement(tag)) {
					const properties = extractPropertyPaths(value);
					for (const prop of properties) addString(prop);

					bindings.push({
						type: BIND_TYPE.TWO_WAY,
						path,
						expression: value,
						properties
					});
					continue;
				}

				// Check for .sync modifier
				const isSync = attrName.endsWith('.sync');
				const cleanAttrName = isSync ? attrName.slice(0, -5) : attrName;

				addString(cleanAttrName);

				// Check for mixed content {{ }}
				const hasMixedContent = value.includes('{{') && value.includes('}}');

				if (hasMixedContent) {
					const { expression, properties } = parseMixedAttributeContent(value);
					for (const prop of properties) addString(prop);

					bindings.push({
						type: BIND_TYPE.ATTR_EVAL,
						path,
						attrName: cleanAttrName,
						expression,
						properties,
						isEval: true,
						isSync
					});
				} else {
					let isEval = needsEvalFn(value);
					const properties = extractPropertyPaths(value);
					for (const prop of properties) addString(prop);

					// In a :for loop, dotted iterator access must be ATTR_EVAL
					if (!isEval && loopVars) {
						const trimmed = value.trim();
						const root = trimmed.split(/[.\[]/)[0];
						if (loopVars.has(root) && trimmed !== root) {
							isEval = true;
						}
					}

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
						attrName: cleanAttrName,
						expression: value,
						properties,
						isEval,
						isSync
					});
				}
				continue;
			}

			// ref attribute - extract for $refs
			if (name === 'ref') {
				refs.push({ path: [...path], name: value });
				continue;
			}

			// Static attribute - keep for HTML output
			if (value === '' || value === true) {
				staticAttrs.push(name);
			} else {
				staticAttrs.push(`${name}="${escapeAttr(value)}"`);
			}
		}

		// Build opening tag
		const attrStr = staticAttrs.length > 0 ? ' ' + staticAttrs.join(' ') : '';
		const isVoid = VOID_ELEMENTS.has(tag);
		const hasChildren = node.children && node.children.length > 0;

		if (isVoid && !hasChildren) {
			// True void element with no children
			htmlParts.push(`<${tag}${attrStr} />`);
		} else {
			// Regular element - always process children if they exist
			htmlParts.push(`<${tag}${attrStr}>`);

			// Process children regardless of selfClosing flag
			// Use output-aware indexing: :else-if/:else produce no DOM output,
			// so they don't increment the child index.
			const children = node.children || [];
			let outputIndex = 0;
			for (let i = 0; i < children.length; i++) {
				const child = children[i];
				const attrs = child.type === 'element' ? (child.attributes || {}) : {};
				const skipsOutput = attrs[':else-if'] !== undefined || attrs[':else'] !== undefined;

				processNode(children[i], [...path, outputIndex]);

				if (!skipsOutput) {
					outputIndex++;
				}
			}

			htmlParts.push(`</${tag}>`);
		}
	}

	// Execute single-pass processing
	processNode(ast);

	return {
		bindings,
		dynamics,
		slots,
		refs,
		strings,
		stringMap,
		templateHTML: htmlParts.join('')
	};
}

// ============ Helper Functions ============

function isSimplePath(expr) {
	return SIMPLE_PATH_REGEX.test(expr.trim());
}

function needsEvalFn(expr) {
	const trimmed = expr.trim();
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

function extractPropertyPaths(expr) {
	const paths = new Set();

	// Remove string literals
	const noStrings = expr
		.replace(/'(?:[^'\\]|\\.)*'/g, '""')
		.replace(/"(?:[^"\\]|\\.)*"/g, '""')
		.replace(/`(?:[^`\\]|\\.)*`/g, '""');

	const propRegex = /\b([a-zA-Z_$][a-zA-Z0-9_$]*(?:\.[a-zA-Z_$][a-zA-Z0-9_$]*|\[[^\]]+\])*)\b/g;
	let match;

	while ((match = propRegex.exec(noStrings)) !== null) {
		const path = match[1];
		if (!KEYWORDS.has(path) && !GLOBALS.has(path)) {
			const root = path.split(/[.\[]/)[0];
			paths.add(root);
		}
	}

	return Array.from(paths);
}

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

function parseEventHandler(expr) {
	const trimmed = expr.trim();

	if (trimmed.includes('=>') || trimmed.includes(';')) {
		return { type: HANDLER_TYPE.INLINE, expression: trimmed };
	}

	const callMatch = trimmed.match(METHOD_CALL_REGEX);
	if (callMatch) {
		return {
			type: HANDLER_TYPE.CALL,
			method: callMatch[1],
			args: callMatch[2].trim()
		};
	}

	if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(trimmed)) {
		return { type: HANDLER_TYPE.METHOD, method: trimmed };
	}

	return { type: HANDLER_TYPE.INLINE, expression: trimmed };
}

function parseMixedAttributeContent(value) {
	const parts = [];
	const properties = new Set();
	let lastIndex = 0;

	const regex = /\{\{\s*(.+?)\s*\}\}/g;
	let match;

	while ((match = regex.exec(value)) !== null) {
		if (match.index > lastIndex) {
			const staticText = value.slice(lastIndex, match.index);
			if (staticText) parts.push(JSON.stringify(staticText));
		}

		const expr = match[1];
		parts.push(`(${expr})`);

		for (const prop of extractPropertyPaths(expr)) {
			properties.add(prop);
		}

		lastIndex = match.index + match[0].length;
	}

	if (lastIndex < value.length) {
		const staticText = value.slice(lastIndex);
		if (staticText) parts.push(JSON.stringify(staticText));
	}

	return {
		expression: parts.join(' + ') || '""',
		properties: Array.from(properties)
	};
}

function isFormElement(tag) {
	return tag === 'input' || tag === 'textarea' || tag === 'select';
}

function escapeAttr(value) {
	return String(value)
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

function escapeHTML(text) {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

export default {
	processAST
};
