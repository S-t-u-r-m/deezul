/**
 * lexicon.js - Shared JS lexical sets for the compiler.
 *
 * Single source of truth for identifiers that the compiler must NOT treat as
 * component properties (and therefore must not prefix with `this.` or wire up
 * for reactive dependency tracking).
 *
 * These were previously duplicated across codegen.js, detector.js, and
 * processor.js, with slow drift (e.g. `void`, `$event` only existing in one
 * copy). Centralising them removes that risk.
 */

/** JavaScript reserved words and literals. `this` is included — we never re-prefix it. */
export const KEYWORDS = new Set([
	'true', 'false', 'null', 'undefined', 'this',
	'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break', 'continue', 'return',
	'function', 'var', 'let', 'const', 'class', 'new', 'delete', 'typeof', 'instanceof',
	'in', 'of', 'try', 'catch', 'finally', 'throw', 'async', 'await', 'yield',
	'import', 'export', 'default', 'from', 'void'
]);

/**
 * Built-in globals that may legitimately appear in template expressions.
 * Includes `$event`, the inline event-handler parameter.
 */
export const GLOBALS = new Set([
	'Math', 'Date', 'JSON', 'Array', 'Object', 'String', 'Number', 'Boolean',
	'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'console', 'window', 'document',
	'RegExp', 'Error', 'Promise', 'Set', 'Map', 'WeakSet', 'WeakMap', 'Symbol',
	'Infinity', 'NaN', 'encodeURI', 'decodeURI', 'encodeURIComponent', 'decodeURIComponent',
	'$event'
]);
