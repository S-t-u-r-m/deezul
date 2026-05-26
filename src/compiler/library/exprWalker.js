/**
 * exprWalker.js - Shared expression tokeniser.
 *
 * One char-by-char tokeniser powers both:
 *   - transformExpression: rewrites bare identifiers to `this.identifier`
 *   - extractDeps: returns the set of identifiers that would be prefixed
 *
 * Doing both through the same walker guarantees that "what the compiled
 * function actually reads from the proxy" matches "what we tell reactivity
 * to subscribe to" — there is no second regex that might drift.
 *
 * The walker correctly skips identifiers that appear inside string literals,
 * after a `.` (property access), or as the keyword/global/skip-var sets.
 */

import { KEYWORDS, GLOBALS } from './lexicon.js';

function isIdentStart(char) {
	return /[a-zA-Z_$]/.test(char);
}

function isIdentChar(char) {
	return /[a-zA-Z0-9_$]/.test(char);
}

function isDigit(char) {
	return /[0-9]/.test(char);
}

/**
 * Walk `expression`, producing a transformed string and/or collecting deps.
 *
 * @param {string} expression
 * @param {Set<string>|null} skipVars  Identifiers to leave alone (e.g. :for iterator/index).
 * @param {Set<string>|null} depCollector  If provided, every "real" identifier is added here.
 * @param {boolean} buildString  When false, skips the transformed-string concat (deps-only fast path).
 * @returns {string} The transformed expression (empty string when buildString is false).
 */
function walk(expression, skipVars, depCollector, buildString) {
	let result = '';
	let i = 0;
	const len = expression.length;

	while (i < len) {
		const char = expression[i];

		// String literals — copy through, no identifier extraction inside
		if (char === '"' || char === "'" || char === '`') {
			const quote = char;
			if (buildString) result += char;
			i++;
			while (i < len) {
				const c = expression[i];
				if (buildString) result += c;
				if (c === quote && expression[i - 1] !== '\\') {
					i++;
					break;
				}
				i++;
			}
			continue;
		}

		// Identifiers
		if (isIdentStart(char)) {
			let identifier = '';
			while (i < len && isIdentChar(expression[i])) {
				identifier += expression[i];
				i++;
			}

			// "Is this a property access?" — look back at the last non-space output char.
			// In buildString mode we read `result`; in deps-only mode we scan back through
			// `expression`.
			let isAfterDot;
			if (buildString) {
				const trimmed = result.trimEnd();
				isAfterDot = trimmed.endsWith('.');
			} else {
				let j = i - identifier.length - 1;
				while (j >= 0 && (expression[j] === ' ' || expression[j] === '\t')) j--;
				isAfterDot = j >= 0 && expression[j] === '.';
			}

			if (isAfterDot) {
				if (buildString) result += identifier;
			} else if (KEYWORDS.has(identifier) || GLOBALS.has(identifier)) {
				if (buildString) result += identifier;
			} else if (skipVars && skipVars.has(identifier)) {
				if (buildString) result += identifier;
			} else {
				// Real component-property reference
				if (buildString) result += 'this.' + identifier;
				if (depCollector) depCollector.add(identifier);
			}
			continue;
		}

		// Numbers — copy through, skipping interior dots so they don't trigger property-access logic
		if (isDigit(char)) {
			while (i < len && (isDigit(expression[i]) || expression[i] === '.')) {
				if (buildString) result += expression[i];
				i++;
			}
			continue;
		}

		if (buildString) result += char;
		i++;
	}

	return result;
}

/**
 * Transform an expression so bare identifiers reach component state through `this`
 * (e.g. `count + 1` → `this.count + 1`). Identifiers inside strings, after a dot,
 * or in `skipVars` are left alone. If `depCollector` is provided, every prefixed
 * identifier is added to it.
 */
export function transformExpression(expression, skipVars, depCollector) {
	return walk(expression, skipVars || null, depCollector || null, true);
}

/**
 * Return the set of identifiers that `transformExpression` would prefix with `this.`.
 * Cheaper than transformExpression — no string is built. Result is an array, not a Set,
 * to match the legacy `extractPropertyPaths` shape.
 */
export function extractDeps(expression, skipVars) {
	const out = new Set();
	walk(expression, skipVars || null, out, false);
	return Array.from(out);
}
