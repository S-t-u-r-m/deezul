/**
 * parser.js - HTML Template Parser
 *
 * Wraps htmlparser2 to parse template strings into a simple AST.
 * Uses SAX-style streaming for efficiency.
 *
 * IMPORTANT: Text nodes with interpolations {{ expr }} are split into
 * multiple nodes - static text nodes and dynamic binding nodes.
 * This allows direct textContent updates without string manipulation.
 *
 * Example: "Hello {{ name }}!" becomes:
 *   - { type: 'text', content: 'Hello ' }
 *   - { type: 'binding', expression: 'name' }
 *   - { type: 'text', content: '!' }
 *
 * Output AST node format:
 * {
 *   type: 'element' | 'text' | 'binding' | 'comment',
 *   tag: 'div',
 *   attributes: { class: 'foo', ':bind': 'value', '@click': 'handler' },
 *   children: [...],
 *   start: 0,        // position in source
 *   end: 50,         // position in source
 *   content: '',     // for text nodes
 *   expression: ''   // for binding nodes
 * }
 */

import { Parser } from 'htmlparser2';

/**
 * Regex to match interpolations {{ expression }}
 */
const INTERPOLATION_REGEX = /\{\{\s*([\s\S]*?)\s*\}\}/g;

/**
 * Split text content into static and binding segments
 * @param {string} text - Text content that may contain {{ }}
 * @param {number} baseStart - Starting position in source
 * @returns {object[]} Array of text and binding nodes
 */
function splitTextOnBindings(text, baseStart) {
	const segments = [];
	let lastIndex = 0;
	let match;

	INTERPOLATION_REGEX.lastIndex = 0;

	while ((match = INTERPOLATION_REGEX.exec(text)) !== null) {
		// Static text before the interpolation
		if (match.index > lastIndex) {
			const staticContent = text.slice(lastIndex, match.index);
			segments.push({
				type: 'text',
				content: staticContent,
				start: baseStart + lastIndex,
				end: baseStart + match.index
			});
		}

		// The binding itself
		const expression = match[1].trim();
		segments.push({
			type: 'binding',
			expression,
			start: baseStart + match.index,
			end: baseStart + match.index + match[0].length
		});

		lastIndex = match.index + match[0].length;
	}

	// Remaining static text after last interpolation
	if (lastIndex < text.length) {
		segments.push({
			type: 'text',
			content: text.slice(lastIndex),
			start: baseStart + lastIndex,
			end: baseStart + text.length
		});
	}

	return segments;
}

/**
 * Check if text contains any interpolations
 */
function hasInterpolations(text) {
	INTERPOLATION_REGEX.lastIndex = 0;
	return INTERPOLATION_REGEX.test(text);
}

/**
 * Parse an HTML template string into an AST
 * @param {string} html - Template HTML string
 * @returns {object} Root AST node with children
 */
export function parseTemplate(html) {
	const root = { type: 'root', children: [] };
	const stack = [root];
	let currentPos = 0;

	// Track positions by finding tags in source
	function findTagStart(tagName, fromPos) {
		// Find opening < for this tag
		const searchPattern = new RegExp(`<${tagName}(?=[\\s>/])`, 'gi');
		searchPattern.lastIndex = fromPos;
		const match = searchPattern.exec(html);
		return match ? match.index : fromPos;
	}

	function findTagEnd(fromPos) {
		// Find closing > from position
		const closeIdx = html.indexOf('>', fromPos);
		return closeIdx !== -1 ? closeIdx + 1 : fromPos;
	}

	function findCloseTagEnd(tagName, fromPos) {
		// Find </tagName>
		const searchPattern = new RegExp(`</${tagName}\\s*>`, 'gi');
		searchPattern.lastIndex = fromPos;
		const match = searchPattern.exec(html);
		return match ? match.index + match[0].length : fromPos;
	}

	const parser = new Parser({
		onopentag(name, attributes) {
			const start = findTagStart(name, currentPos);
			const tagEnd = findTagEnd(start);

			const node = {
				type: 'element',
				tag: name,
				attributes: { ...attributes },
				children: [],
				start,
				end: tagEnd, // Will be updated on close for non-void elements
				selfClosing: false
			};

			stack[stack.length - 1].children.push(node);
			stack.push(node);
			currentPos = tagEnd;
		},

		onclosetag(name, isImplied) {
			const node = stack.pop();
			if (node && node.type === 'element') {
				if (!isImplied) {
					// Find actual closing tag position
					node.end = findCloseTagEnd(name, currentPos);
					currentPos = node.end;
				}
				// Check if it was self-closing
				const openingTag = html.slice(node.start, node.end);
				if (openingTag.includes('/>')) {
					node.selfClosing = true;
				}
			}
		},

		ontext(text) {
			// Skip pure whitespace between tags
			if (!text.trim()) return;

			// Find text position in source
			const textStart = html.indexOf(text, currentPos);
			const start = textStart !== -1 ? textStart : currentPos;
			const end = start + text.length;

			const parent = stack[stack.length - 1];

			// Check for interpolations and split if needed
			if (hasInterpolations(text)) {
				const segments = splitTextOnBindings(text, start);
				for (const segment of segments) {
					parent.children.push(segment);
				}
			} else {
				// Plain text node, no bindings
				parent.children.push({
					type: 'text',
					content: text,
					start,
					end
				});
			}

			currentPos = end;
		},

		oncomment(text) {
			const commentStart = html.indexOf('<!--', currentPos);
			const commentEnd = html.indexOf('-->', commentStart) + 3;

			const node = {
				type: 'comment',
				content: text,
				start: commentStart !== -1 ? commentStart : currentPos,
				end: commentEnd !== -1 ? commentEnd : currentPos
			};

			stack[stack.length - 1].children.push(node);
			currentPos = node.end;
		}
	}, {
		lowerCaseTags: true,
		lowerCaseAttributeNames: false, // Preserve :bind, @click casing
		recognizeSelfClosing: true
	});

	parser.write(html);
	parser.end();

	return root;
}

/**
 * Walk an AST depth-first, calling visitor for each node
 * @param {object} ast - AST root node
 * @param {function} visitor - Called with (node, parent, index)
 */
export function walkAST(ast, visitor) {
	function walk(node, parent = null, index = 0) {
		visitor(node, parent, index);

		if (node.children) {
			for (let i = 0; i < node.children.length; i++) {
				walk(node.children[i], node, i);
			}
		}
	}
	walk(ast);
}

/**
 * Find all nodes matching a predicate
 * @param {object} ast - AST root node
 * @param {function} predicate - Returns true for matching nodes
 * @returns {object[]} Array of matching nodes
 */
export function findNodes(ast, predicate) {
	const results = [];
	walkAST(ast, (node) => {
		if (predicate(node)) {
			results.push(node);
		}
	});
	return results;
}

/**
 * Get all element nodes in document order
 * @param {object} ast - AST root node
 * @returns {object[]} Array of element nodes
 */
export function getElements(ast) {
	return findNodes(ast, node => node.type === 'element');
}

/**
 * Get all text nodes in document order
 * @param {object} ast - AST root node
 * @returns {object[]} Array of text nodes
 */
export function getTextNodes(ast) {
	return findNodes(ast, node => node.type === 'text');
}

/**
 * Get all binding nodes (text interpolations) in document order
 * @param {object} ast - AST root node
 * @returns {object[]} Array of binding nodes
 */
export function getBindingNodes(ast) {
	return findNodes(ast, node => node.type === 'binding');
}

export default {
	parseTemplate,
	walkAST,
	findNodes,
	getElements,
	getTextNodes,
	getBindingNodes
};
