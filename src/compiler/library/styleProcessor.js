/**
 * styleProcessor.js - CSS Processing with css-tree
 *
 * Handles style parsing, scoping, and optimization for component styles.
 * Uses css-tree for fast, spec-compliant CSS AST manipulation.
 */

import * as csstree from 'css-tree';

/**
 * Parse CSS string into AST
 * @param {string} css - CSS source
 * @returns {object} css-tree AST
 */
export function parse(css) {
	return csstree.parse(css, {
		parseCustomProperty: true
	});
}

/**
 * Generate CSS string from AST
 * @param {object} ast - css-tree AST
 * @param {boolean} minify - Whether to minify output
 * @returns {string} CSS string
 */
export function generate(ast, minify = false) {
	return csstree.generate(ast, {
		sourceMap: false
	});
}

/**
 * Scope all selectors with a component-specific attribute
 * Adds [data-s-{scopeId}] to each selector
 *
 * @param {string} css - CSS source
 * @param {string} scopeId - Unique component scope ID
 * @returns {string} Scoped CSS
 */
export function scopeStyles(css, scopeId) {
	const ast = parse(css);
	const scopeAttr = `data-s-${scopeId}`;

	csstree.walk(ast, {
		visit: 'Selector',
		enter(node) {
			// Create attribute selector node
			const attrSelector = {
				type: 'AttributeSelector',
				name: {
					type: 'Identifier',
					name: scopeAttr
				},
				matcher: null,
				value: null,
				flags: null
			};

			// Find first non-combinator to insert after
			// We want: .foo[data-s-xxx] not [data-s-xxx].foo
			const children = node.children;
			let insertIndex = 0;

			children.forEach((child, item, list) => {
				// Skip leading combinators or whitespace
				if (child.type === 'Combinator' || child.type === 'WhiteSpace') {
					return;
				}

				// Insert scope after first selector segment
				if (insertIndex === 0) {
					list.insert(list.createItem(attrSelector), item.next);
					insertIndex++;
				}
			});

			// If selector is empty or only combinators, prepend
			if (insertIndex === 0) {
				children.prepend(children.createItem(attrSelector));
			}
		}
	});

	return generate(ast);
}

/**
 * Extract and deduplicate CSS custom properties (variables)
 * @param {string} css - CSS source
 * @returns {object} { variables: Map, css: string }
 */
export function extractVariables(css) {
	const ast = parse(css);
	const variables = new Map();

	csstree.walk(ast, {
		visit: 'Declaration',
		enter(node) {
			if (node.property.startsWith('--')) {
				const value = csstree.generate(node.value);
				variables.set(node.property, value);
			}
		}
	});

	return { variables, ast };
}

/**
 * Minify CSS by removing whitespace and comments
 * @param {string} css - CSS source
 * @returns {string} Minified CSS
 */
export function minify(css) {
	const ast = parse(css);

	// Remove comments
	csstree.walk(ast, {
		visit: 'Comment',
		enter(node, item, list) {
			list.remove(item);
		}
	});

	return csstree.generate(ast);
}

/**
 * Validate CSS and return any errors found.
 *
 * Two severities:
 *  - `fatal: true`  — real syntax errors (parse failures). The stylesheet is broken.
 *  - no flag        — lexer lint findings (unknown property, value/type mismatch).
 *                     The CSS is syntactically fine and the browser may still
 *                     understand it, so callers should warn, not discard.
 *
 * @param {string} css - CSS source
 * @returns {object[]} Array of error objects ({ message, line, column?, property?, fatal? })
 */
export function validate(css) {
	const errors = [];

	try {
		const ast = csstree.parse(css, {
			parseCustomProperty: true,
			onParseError(error) {
				errors.push({
					message: error.message,
					line: error.line,
					column: error.column,
					fatal: true
				});
			}
		});

		// Additional validation via lexer (lint-level, non-fatal)
		csstree.walk(ast, {
			visit: 'Declaration',
			enter(node) {
				// Values containing var()/env() can expand to anything at runtime —
				// css-tree's lexer cannot match them BY DESIGN ("Matching for a tree
				// with var() is not supported") even though they are valid CSS.
				// Skip matching entirely for those declarations.
				let hasSubstitution = false;
				csstree.walk(node.value, (n) => {
					if (n.type === 'Function' && /^(var|env)$/i.test(n.name)) hasSubstitution = true;
				});
				if (hasSubstitution) return;

				const match = csstree.lexer.matchDeclaration(node);
				if (match.error) {
					// Belt-and-braces: if the lexer still trips on a substitution it
					// found deeper than our walk (e.g. inside Raw), ignore that too.
					if (/var\(\)/.test(match.error.message)) return;
					errors.push({
						message: match.error.message,
						property: node.property,
						line: node.loc?.start?.line
					});
				}
			}
		});
	} catch (e) {
		errors.push({
			message: e.message,
			line: e.line,
			column: e.column,
			fatal: true
		});
	}

	return errors;
}

/**
 * Get all selectors from CSS
 * @param {string} css - CSS source
 * @returns {string[]} Array of selector strings
 */
export function getSelectors(css) {
	const ast = parse(css);
	const selectors = [];

	csstree.walk(ast, {
		visit: 'Selector',
		enter(node) {
			selectors.push(csstree.generate(node));
		}
	});

	return selectors;
}

/**
 * Check if CSS contains :host or ::slotted (Shadow DOM specific)
 * @param {string} css - CSS source
 * @returns {boolean}
 */
export function hasShadowSelectors(css) {
	const ast = parse(css);
	let found = false;

	csstree.walk(ast, {
		visit: 'PseudoClassSelector',
		enter(node) {
			if (node.name === 'host' || node.name === 'host-context') {
				found = true;
			}
		}
	});

	if (!found) {
		csstree.walk(ast, {
			visit: 'PseudoElementSelector',
			enter(node) {
				if (node.name === 'slotted') {
					found = true;
				}
			}
		});
	}

	return found;
}

/**
 * Transform :host selectors for scoped (non-Shadow DOM) usage
 * :host → [data-s-xxx]
 * :host(.foo) → [data-s-xxx].foo
 *
 * @param {string} css - CSS source
 * @param {string} scopeId - Component scope ID
 * @returns {string} Transformed CSS
 */
export function transformHostSelectors(css, scopeId) {
	const ast = parse(css);
	const scopeAttr = `data-s-${scopeId}`;

	csstree.walk(ast, {
		visit: 'PseudoClassSelector',
		enter(node, item, list) {
			if (node.name === 'host') {
				// Replace :host with [data-s-xxx]
				const replacement = {
					type: 'AttributeSelector',
					name: {
						type: 'Identifier',
						name: scopeAttr
					},
					matcher: null,
					value: null,
					flags: null
				};

				list.replace(item, list.createItem(replacement));
			}
		}
	});

	return generate(ast);
}

/**
 * Process component styles
 * Main entry point for style compilation
 *
 * @param {string} css - CSS source
 * @param {object} options - Processing options
 * @param {string} options.scopeId - Component scope ID (for non-Shadow DOM)
 * @param {boolean} options.shadow - Using Shadow DOM (skip scoping)
 * @param {boolean} options.minify - Minify output
 * @returns {object} { css: string, selectors: string[], errors: object[] }
 */
export function processStyles(css, options = {}) {
	const { scopeId, shadow = true, minify: shouldMinify = false } = options;

	// Validate first. Only genuine PARSE errors discard the stylesheet — lexer
	// lint findings (unknown property, value mismatch) are returned as warnings
	// alongside the processed CSS, never by silently dropping every rule.
	const errors = validate(css);
	const fatal = errors.filter(e => e.fatal);
	if (fatal.length > 0) {
		return { css: '', selectors: [], errors: fatal };
	}

	let processedCss = css;

	// If not using Shadow DOM, scope styles
	if (!shadow && scopeId) {
		// Transform :host to attribute selector
		if (hasShadowSelectors(processedCss)) {
			processedCss = transformHostSelectors(processedCss, scopeId);
		}
		// Scope all other selectors
		processedCss = scopeStyles(processedCss, scopeId);
	}

	// Minify if requested
	if (shouldMinify) {
		processedCss = minify(processedCss);
	}

	// Get selectors for debugging/analysis
	const selectors = getSelectors(processedCss);

	return {
		css: processedCss,
		selectors,
		errors   // non-fatal lint warnings (possibly empty)
	};
}

/**
 * Extract all element tags, class names, and IDs used in a template AST
 * Also extracts string literals from dynamic :class expressions
 *
 * @param {object} ast - Parsed template AST
 * @returns {object} { tags: Set, classes: Set, ids: Set }
 */
export function extractUsedSelectors(ast) {
	const tags = new Set();
	const classes = new Set();
	const ids = new Set();

	function walk(node) {
		if (!node) return;

		if (node.type === 'element') {
			tags.add(node.tag);

			const attrs = node.attributes || {};

			// Static class attribute
			if (attrs.class) {
				for (const cls of attrs.class.split(/\s+/)) {
					if (cls) classes.add(cls);
				}
			}

			// Dynamic :class — extract string literals from expression
			if (attrs[':class']) {
				const literals = extractStringLiterals(attrs[':class']);
				for (const lit of literals) {
					for (const cls of lit.split(/\s+/)) {
						if (cls) classes.add(cls);
					}
				}
			}

			// Static id attribute
			if (attrs.id) {
				ids.add(attrs.id);
			}

			// Walk children
			if (node.children) {
				for (const child of node.children) {
					walk(child);
				}
			}
		} else if (node.type === 'root') {
			if (node.children) {
				for (const child of node.children) {
					walk(child);
				}
			}
		}
	}

	walk(ast);
	return { tags, classes, ids };
}

/**
 * Extract string literals from a JavaScript expression
 * Handles single quotes, double quotes, and template literals
 *
 * @param {string} expr - JavaScript expression
 * @returns {string[]} Array of string literal values
 */
function extractStringLiterals(expr) {
	const literals = [];
	const regex = /(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|`([^`\\]*(?:\\.[^`\\]*)*)`)/g;
	let match;

	while ((match = regex.exec(expr)) !== null) {
		literals.push(match[1] || match[2] || match[3] || '');
	}

	return literals;
}

/**
 * Check if a CSS selector matches any of the used selectors from a template
 *
 * @param {object} selectorNode - css-tree Selector node
 * @param {object} used - { tags, classes, ids }
 * @returns {boolean}
 */
function selectorMatchesUsed(selectorNode, used) {
	let matches = false;

	csstree.walk(selectorNode, function(node) {
		switch (node.type) {
			case 'TypeSelector':
				if (used.tags.has(node.name)) matches = true;
				break;
			case 'ClassSelector':
				if (used.classes.has(node.name)) matches = true;
				break;
			case 'IdSelector':
				if (used.ids.has(node.name)) matches = true;
				break;
			case 'PseudoClassSelector':
				if (node.name === 'root' || node.name === 'host') matches = true;
				break;
			case 'UniversalSelector':
				matches = true;
				break;
		}
	});

	return matches;
}

/**
 * Extract only the CSS rules that match elements/classes/IDs used in a template
 *
 * Always includes:
 * - :root rules (CSS custom properties)
 * - * (universal) rules
 * - @keyframes, @font-face, @media (recursively filtered)
 * - Rules whose selectors reference tags, classes, or IDs found in the template
 *
 * @param {string} css - Full shared CSS string
 * @param {object} used - { tags: Set, classes: Set, ids: Set }
 * @param {boolean} shouldMinify - Whether to minify the output
 * @returns {string} Filtered CSS containing only matching rules
 */
export function extractMatchingRules(css, used, shouldMinify = true) {
	const ast = parse(css);
	const removals = [];

	csstree.walk(ast, {
		visit: 'Rule',
		enter(node, item, list) {
			// Check if any selector in the selector list matches
			let ruleMatches = false;

			csstree.walk(node.prelude, {
				visit: 'Selector',
				enter(selector) {
					if (selectorMatchesUsed(selector, used)) {
						ruleMatches = true;
					}
				}
			});

			if (!ruleMatches) {
				removals.push({ item, list });
			}
		}
	});

	// Remove non-matching rules (reverse to avoid index issues)
	for (const { item, list } of removals) {
		list.remove(item);
	}

	// Remove empty @media blocks
	const emptyAtRules = [];
	csstree.walk(ast, {
		visit: 'Atrule',
		enter(node, item, list) {
			if (node.block && node.block.children && node.block.children.isEmpty) {
				emptyAtRules.push({ item, list });
			}
		}
	});

	for (const { item, list } of emptyAtRules) {
		list.remove(item);
	}

	const result = csstree.generate(ast);

	if (shouldMinify && result) {
		return minify(result);
	}

	return result;
}

export default {
	parse,
	generate,
	scopeStyles,
	extractVariables,
	minify,
	validate,
	getSelectors,
	hasShadowSelectors,
	transformHostSelectors,
	processStyles,
	extractUsedSelectors,
	extractMatchingRules
};
