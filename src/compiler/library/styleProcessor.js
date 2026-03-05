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
 * Validate CSS and return any syntax errors
 * @param {string} css - CSS source
 * @returns {object[]} Array of error objects
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
					column: error.column
				});
			}
		});

		// Additional validation via lexer
		csstree.walk(ast, {
			visit: 'Declaration',
			enter(node) {
				const match = csstree.lexer.matchDeclaration(node);
				if (match.error) {
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
			column: e.column
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

	// Validate first
	const errors = validate(css);
	if (errors.length > 0) {
		return { css: '', selectors: [], errors };
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
		errors: []
	};
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
	processStyles
};
