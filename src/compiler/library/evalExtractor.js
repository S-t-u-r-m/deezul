/**
 * evalExtractor.js - Eval Function Generator
 *
 * Generates JavaScript functions for evaluating expressions at runtime.
 * These functions are called when reactive properties change.
 *
 * Input: Array of { expression, properties } from bytecodeBuilder
 * Output: Array of function strings that can be compiled at runtime
 *
 * Each function receives (data) and returns the evaluated expression.
 * Properties are accessed as data.propertyName.
 */

/**
 * Generate eval function code from expressions
 * @param {object[]} evalFunctions - Array of { expression, properties }
 * @returns {string[]} Array of function body strings
 */
export function generateEvalFunctions(evalFunctions) {
	return evalFunctions.map(({ expression }) => {
		return generateSingleEval(expression);
	});
}

/**
 * Generate a single eval function body
 * @param {string} expression - The expression to evaluate
 * @returns {string} Function body code
 */
function generateSingleEval(expression) {
	// The expression is evaluated with `data` as the context
	// Properties like `count` become `data.count`
	return transformExpression(expression);
}

/**
 * Transform expression to access properties through data object
 * @param {string} expression - Original expression
 * @returns {string} Transformed expression
 */
function transformExpression(expression) {
	// We need to prefix property accesses with "data."
	// But avoid transforming:
	// - String literals
	// - Number literals
	// - Keywords (true, false, null, undefined, etc.)
	// - Already prefixed paths (data.x)
	// - Global objects (Math, Date, etc.)
	// - Object property access after dot (obj.prop - don't transform prop)

	const keywords = new Set([
		'true', 'false', 'null', 'undefined', 'this',
		'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'return',
		'function', 'var', 'let', 'const', 'class', 'new', 'delete', 'typeof', 'instanceof',
		'in', 'of', 'try', 'catch', 'finally', 'throw', 'async', 'await', 'yield',
		'import', 'export', 'default', 'from', 'void'
	]);

	const globals = new Set([
		'Math', 'Date', 'JSON', 'Array', 'Object', 'String', 'Number', 'Boolean',
		'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'console', 'window', 'document',
		'RegExp', 'Error', 'Promise', 'Set', 'Map', 'WeakSet', 'WeakMap', 'Symbol',
		'Infinity', 'NaN', 'encodeURI', 'decodeURI', 'encodeURIComponent', 'decodeURIComponent'
	]);

	let result = '';
	let i = 0;

	while (i < expression.length) {
		const char = expression[i];

		// Handle string literals
		if (char === '"' || char === "'" || char === '`') {
			const quote = char;
			result += char;
			i++;

			while (i < expression.length) {
				const c = expression[i];
				result += c;
				if (c === quote && expression[i - 1] !== '\\') {
					i++;
					break;
				}
				i++;
			}
			continue;
		}

		// Handle identifiers
		if (isIdentifierStart(char)) {
			let identifier = '';
			const identStart = i;

			while (i < expression.length && isIdentifierChar(expression[i])) {
				identifier += expression[i];
				i++;
			}

			// Check if this is after a dot (property access)
			const beforeIdent = result.trimEnd();
			const isAfterDot = beforeIdent.endsWith('.');

			// Check if followed by a dot (could be method call on global)
			const afterIdent = expression.slice(i).trimStart();
			const isBeforeParen = afterIdent.startsWith('(');

			if (isAfterDot) {
				// After a dot - don't transform
				result += identifier;
			} else if (keywords.has(identifier)) {
				// JavaScript keyword - don't transform
				result += identifier;
			} else if (globals.has(identifier)) {
				// Global object - don't transform
				result += identifier;
			} else if (identifier === 'data') {
				// Already referencing data - don't transform
				result += identifier;
			} else {
				// Regular identifier - prefix with data.
				result += 'data.' + identifier;
			}
			continue;
		}

		// Handle numbers
		if (isDigit(char)) {
			while (i < expression.length && (isDigit(expression[i]) || expression[i] === '.')) {
				result += expression[i];
				i++;
			}
			continue;
		}

		// All other characters pass through
		result += char;
		i++;
	}

	return result;
}

/**
 * Check if character can start an identifier
 */
function isIdentifierStart(char) {
	return /[a-zA-Z_$]/.test(char);
}

/**
 * Check if character can be part of an identifier
 */
function isIdentifierChar(char) {
	return /[a-zA-Z0-9_$]/.test(char);
}

/**
 * Check if character is a digit
 */
function isDigit(char) {
	return /[0-9]/.test(char);
}

/**
 * Generate the full eval functions array as code
 * @param {object[]} evalFunctions - Array of { expression, properties }
 * @returns {string} JavaScript code for eval functions array
 */
export function generateEvalCode(evalFunctions) {
	if (evalFunctions.length === 0) {
		return '[]';
	}

	const fnStrings = generateEvalFunctions(evalFunctions);
	const lines = fnStrings.map((body, i) => {
		return `\t(data) => ${body}`;
	});

	return `[\n${lines.join(',\n')}\n]`;
}

/**
 * Generate event handler function code
 * @param {object} handler - Handler descriptor from detector
 * @param {string[]} strings - String table
 * @returns {string} Handler function code
 */
export function generateEventHandler(handler, strings) {
	const { type, method, args, expression } = handler;

	switch (type) {
		case 0: // METHOD - simple method reference
			return `(e) => this.${method}(e)`;

		case 1: // CALL - method with args
			// Transform args expression
			const transformedArgs = transformExpression(args || '');
			return `(e) => this.${method}(${transformedArgs || 'e'})`;

		case 2: // INLINE - inline expression
			const transformedExpr = transformExpression(expression);
			return `(e) => { ${transformedExpr} }`;

		default:
			return `(e) => {}`;
	}
}

export default {
	generateEvalFunctions,
	generateEvalCode,
	generateEventHandler,
	transformExpression
};
