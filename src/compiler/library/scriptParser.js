/**
 * scriptParser.js - Deezul.Component Parser
 *
 * Parses full Deezul.Component({...}) JavaScript files and extracts:
 * - template: HTML template string
 * - data: Data factory function
 * - methods: Component methods object
 * - computed: Computed properties object
 * - static: Static/constant values
 * - watch: Property watchers
 * - styles: Component CSS
 *
 * Uses regex-based extraction to avoid full JS parsing overhead.
 * Handles template literals, regular strings, and object literals.
 */

/**
 * Parse a Deezul.Component file
 * @param {string} source - Full JavaScript source code
 * @returns {object} Parsed component sections
 */
export function parseComponent(source) {
	// Find the Deezul.Component({...}) call
	const componentMatch = source.match(/(?:export\s+default\s+)?Deezul\.Component\s*\(\s*\{/);
	if (!componentMatch) {
		throw new Error('Could not find Deezul.Component({ ... }) in source');
	}

	const startIndex = componentMatch.index + componentMatch[0].length - 1;
	const componentBody = extractBalanced(source, startIndex, '{', '}');

	if (!componentBody) {
		throw new Error('Could not extract component body');
	}

	// Extract each section
	const result = {
		template: null,
		data: null,
		method: null,
		computed: null,
		staticData: null,
		watcher: null,
		style: null,
		// Lifecycle hooks
		$created: null,
		$mounted: null,
		$updated: null,
		$unmounted: null,
		$error: null
	};

	// Template (required) — extract from original body
	result.template = extractStringProperty(componentBody, 'template');

	// Blank out template and styles strings so code examples inside them
	// don't get picked up as real methods/data/hooks/etc.
	const scriptBody = blankStringProperties(componentBody, ['template', 'styles']);

	// Data function
	result.data = extractFunctionProperty(scriptBody, 'data');

	// Methods object
	result.method = extractObjectProperty(scriptBody, 'methods');

	// Computed properties
	result.computed = extractObjectProperty(scriptBody, 'computed');

	// Static values
	result.staticData = extractObjectProperty(scriptBody, 'static');

	// Watchers
	result.watcher = extractObjectProperty(scriptBody, 'watch');

	// Styles — extract from original body (not blanked)
	result.style = extractStringProperty(componentBody, 'styles');

	// Lifecycle hooks
	result.$created = extractHookFunction(scriptBody, '\\$created');
	result.$mounted = extractHookFunction(scriptBody, '\\$mounted');
	result.$updated = extractHookFunction(scriptBody, '\\$updated');
	result.$unmounted = extractHookFunction(scriptBody, '\\$unmounted');
	result.$error = extractHookFunction(scriptBody, '\\$error');

	return result;
}

/**
 * Extract a string property (template literal or regular string)
 * @param {string} source - Component body
 * @param {string} propName - Property name to extract
 * @returns {string|null} Extracted string value
 */
function extractStringProperty(source, propName) {
	// Match: propName: `...` or propName: "..." or propName: '...'
	// Allow optional block comments (e.g. /*html*/) between colon and value
	const optComment = '(?:\\/\\*[\\s\\S]*?\\*\\/\\s*)?';
	const patterns = [
		// Template literal (with optional comment like /*html*/)
		new RegExp(`${propName}\\s*:\\s*${optComment}\``, 'g'),
		// Double-quoted string
		new RegExp(`${propName}\\s*:\\s*${optComment}"`, 'g'),
		// Single-quoted string
		new RegExp(`${propName}\\s*:\\s*${optComment}'`, 'g'),
		// html tagged template (html`...`)
		new RegExp(`${propName}\\s*:\\s*html\``, 'g')
	];

	for (const pattern of patterns) {
		const match = pattern.exec(source);
		if (match) {
			const startIndex = match.index + match[0].length - 1;
			const quoteChar = source[startIndex];

			if (quoteChar === '`') {
				return extractTemplateLiteral(source, startIndex);
			} else {
				return extractQuotedString(source, startIndex, quoteChar);
			}
		}
	}

	return null;
}

/**
 * Extract a function property (arrow function or regular function)
 * @param {string} source - Component body
 * @param {string} propName - Property name to extract
 * @returns {string|null} Function code as string
 */
function extractFunctionProperty(source, propName) {
	// Match: propName: () => ({...}) or propName: function() {...} or propName() {...}
	const patterns = [
		// Arrow function: data: () => ({...})
		new RegExp(`${propName}\\s*:\\s*\\(\\s*\\)\\s*=>\\s*\\(`, 'g'),
		// Arrow function returning object directly: data: () => {
		new RegExp(`${propName}\\s*:\\s*\\(\\s*\\)\\s*=>\\s*\\{`, 'g'),
		// Regular function: data: function() {
		new RegExp(`${propName}\\s*:\\s*function\\s*\\(`, 'g'),
		// Shorthand method: data() {
		new RegExp(`${propName}\\s*\\(\\s*\\)\\s*\\{`, 'g')
	];

	// Try arrow function with parenthesized return: () => ({...})
	const arrowParenMatch = source.match(new RegExp(`${propName}\\s*:\\s*(\\(\\s*\\)\\s*=>\\s*\\()`));
	if (arrowParenMatch) {
		const funcStart = arrowParenMatch.index + arrowParenMatch[0].length - 1;
		const body = extractBalanced(source, funcStart, '(', ')');
		if (body) {
			return `() => (${body})`;
		}
	}

	// Try arrow function with block: () => {...}
	const arrowBlockMatch = source.match(new RegExp(`${propName}\\s*:\\s*(\\(\\s*\\)\\s*=>\\s*\\{)`));
	if (arrowBlockMatch) {
		const funcStart = arrowBlockMatch.index + arrowBlockMatch[0].length - 1;
		const body = extractBalanced(source, funcStart, '{', '}');
		if (body) {
			return `() => {${body}}`;
		}
	}

	// Try regular function
	const funcMatch = source.match(new RegExp(`${propName}\\s*:\\s*function\\s*\\([^)]*\\)\\s*\\{`));
	if (funcMatch) {
		const braceStart = source.indexOf('{', funcMatch.index + funcMatch[0].length - 1);
		const body = extractBalanced(source, braceStart, '{', '}');
		if (body) {
			const params = funcMatch[0].match(/\([^)]*\)/)[0];
			return `function${params} {${body}}`;
		}
	}

	return null;
}

/**
 * Extract an object property (methods, computed, etc.)
 * @param {string} source - Component body
 * @param {string} propName - Property name to extract
 * @returns {string|null} Object literal as string
 */
function extractObjectProperty(source, propName) {
	// Match: propName: {
	const pattern = new RegExp(`${propName}\\s*:\\s*\\{`);
	const match = source.match(pattern);

	if (!match) {
		return null;
	}

	const braceStart = source.indexOf('{', match.index);
	const body = extractBalanced(source, braceStart, '{', '}');

	if (body) {
		return `{${body}}`;
	}

	return null;
}

/**
 * Extract a lifecycle hook function ($mounted, $updated, etc.)
 * Handles shorthand methods: $mounted() { ... }
 * And function properties: $mounted: function() { ... }
 * And arrow functions: $mounted: () => { ... }
 * @param {string} source - Component body
 * @param {string} hookName - Hook name with escaped $ (e.g., '\\$mounted')
 * @returns {string|null} Function code as string
 */
function extractHookFunction(source, hookName) {
	// Shorthand method: $mounted() { ... } or async $mounted() { ... }
	const shorthandMatch = source.match(new RegExp('(async\\s+)?' + hookName + '\\s*\\(([^)]*)\\)\\s*\\{'));
	if (shorthandMatch) {
		const isAsync = !!shorthandMatch[1];
		const params = shorthandMatch[2].trim();
		const braceStart = source.indexOf('{', shorthandMatch.index + shorthandMatch[0].length - 1);
		const body = extractBalanced(source, braceStart, '{', '}');
		if (body) {
			return `${isAsync ? 'async ' : ''}function(${params}) {${body}}`;
		}
	}

	// Function property: $mounted: function() { ... } or $mounted: async function() { ... }
	const funcMatch = source.match(new RegExp(hookName + '\\s*:\\s*(async\\s+)?function\\s*\\(([^)]*)\\)\\s*\\{'));
	if (funcMatch) {
		const isAsync = !!funcMatch[1];
		const params = funcMatch[2].trim();
		const braceStart = source.indexOf('{', funcMatch.index + funcMatch[0].length - 1);
		const body = extractBalanced(source, braceStart, '{', '}');
		if (body) {
			return `${isAsync ? 'async ' : ''}function(${params}) {${body}}`;
		}
	}

	// Arrow function: $mounted: () => { ... } or $mounted: async () => { ... }
	const arrowMatch = source.match(new RegExp(hookName + '\\s*:\\s*(async\\s+)?\\(([^)]*)\\)\\s*=>\\s*\\{'));
	if (arrowMatch) {
		const isAsync = !!arrowMatch[1];
		const params = arrowMatch[2].trim();
		const braceStart = source.indexOf('{', arrowMatch.index + arrowMatch[0].length - 1);
		const body = extractBalanced(source, braceStart, '{', '}');
		if (body) {
			return `${isAsync ? 'async ' : ''}function(${params}) {${body}}`;
		}
	}

	return null;
}

/**
 * Blank out string property values (template literals or quoted strings) so their
 * content doesn't interfere with regex extraction of other properties.
 * Replaces the string content with spaces while preserving the same length.
 * @param {string} source - Component body
 * @param {string[]} propNames - Property names to blank out
 * @returns {string} Source with string contents blanked
 */
function blankStringProperties(source, propNames) {
	let result = source;
	for (const propName of propNames) {
		const optComment = '(?:\\/\\*[\\s\\S]*?\\*\\/\\s*)?';
		const patterns = [
			new RegExp(`${propName}\\s*:\\s*${optComment}\``, 'g'),
			new RegExp(`${propName}\\s*:\\s*${optComment}"`, 'g'),
			new RegExp(`${propName}\\s*:\\s*${optComment}'`, 'g'),
			new RegExp(`${propName}\\s*:\\s*html\``, 'g')
		];

		for (const pattern of patterns) {
			const match = pattern.exec(result);
			if (match) {
				const contentStart = match.index + match[0].length;
				const quoteChar = result[contentStart - 1];
				let end = contentStart;

				if (quoteChar === '`') {
					// Find closing backtick (skip escaped ones)
					while (end < result.length) {
						if (result[end] === '`' && result[end - 1] !== '\\') break;
						end++;
					}
				} else {
					// Find closing quote
					while (end < result.length) {
						if (result[end] === quoteChar && result[end - 1] !== '\\') break;
						end++;
					}
				}

				// Replace content between quotes with spaces
				result = result.slice(0, contentStart) + ' '.repeat(end - contentStart) + result.slice(end);
				break; // Found this property, move to next
			}
		}
	}
	return result;
}

/**
 * Extract balanced content between delimiters
 * @param {string} source - Source string
 * @param {number} startIndex - Index of opening delimiter
 * @param {string} open - Opening delimiter
 * @param {string} close - Closing delimiter
 * @returns {string|null} Content between delimiters (excluding delimiters)
 */
function extractBalanced(source, startIndex, open, close) {
	if (source[startIndex] !== open) {
		return null;
	}

	let depth = 1;
	let i = startIndex + 1;
	let inString = false;
	let stringChar = '';
	let inTemplate = false;

	while (i < source.length && depth > 0) {
		const char = source[i];
		const prevChar = source[i - 1];

		// Handle string literals
		if (!inString && !inTemplate && (char === '"' || char === "'")) {
			inString = true;
			stringChar = char;
		} else if (inString && char === stringChar && prevChar !== '\\') {
			inString = false;
		}
		// Handle template literals
		else if (!inString && !inTemplate && char === '`') {
			inTemplate = true;
		} else if (inTemplate && char === '`' && prevChar !== '\\') {
			inTemplate = false;
		}
		// Track depth when not in string
		else if (!inString && !inTemplate) {
			if (char === open) {
				depth++;
			} else if (char === close) {
				depth--;
			}
		}

		i++;
	}

	if (depth === 0) {
		return source.slice(startIndex + 1, i - 1);
	}

	return null;
}

/**
 * Extract template literal content
 * @param {string} source - Source string
 * @param {number} startIndex - Index of opening backtick
 * @returns {string|null} Template content
 */
function extractTemplateLiteral(source, startIndex) {
	if (source[startIndex] !== '`') {
		return null;
	}

	let i = startIndex + 1;
	let result = '';

	while (i < source.length) {
		const char = source[i];
		const prevChar = source[i - 1];

		if (char === '`' && prevChar !== '\\') {
			return result;
		}

		// Handle ${...} expressions - just include as-is
		if (char === '$' && source[i + 1] === '{') {
			result += char;
		} else {
			result += char;
		}

		i++;
	}

	return null;
}

/**
 * Extract quoted string content
 * @param {string} source - Source string
 * @param {number} startIndex - Index of opening quote
 * @param {string} quoteChar - Quote character (' or ")
 * @returns {string|null} String content
 */
function extractQuotedString(source, startIndex, quoteChar) {
	if (source[startIndex] !== quoteChar) {
		return null;
	}

	let i = startIndex + 1;
	let result = '';

	while (i < source.length) {
		const char = source[i];
		const prevChar = source[i - 1];

		if (char === quoteChar && prevChar !== '\\') {
			// Unescape the string
			return result.replace(/\\(['"\\])/g, '$1');
		}

		result += char;
		i++;
	}

	return null;
}

/**
 * Parse component and return full compilation-ready structure
 * @param {string} source - Component source code
 * @param {string} componentName - Name for the component
 * @returns {object} Component definition ready for compilation
 */
export function parseComponentFile(source, componentName = 'Anonymous') {
	const parsed = parseComponent(source);

	return {
		componentName,
		template: parsed.template,
		data: parsed.data,
		method: parsed.method,
		computed: parsed.computed,
		staticData: parsed.staticData,
		watcher: parsed.watcher,
		style: parsed.style
	};
}

export default {
	parseComponent,
	parseComponentFile
};
