/**
 * templateCheck.js — catch names a template reads that the component never declares.
 *
 * A template is a string until the compiler reads it, so nothing else sees `{{ coutn }}`
 * or `@click="svae"`. TypeScript cannot: by the time it looks, the template is a quoted
 * literal. The compiler is the only thing that parses both halves, so the check belongs
 * here.
 *
 * It reuses the real parser and the real dependency extractor rather than scanning the
 * template again -- the same rule exprWalker's header gives for why transformExpression
 * and extractDeps share one tokeniser. What the template is reported to read is exactly
 * what the compiled component will read.
 *
 * SCOPE, in the order a name is looked for:
 *   - a `:for` iterator or index, for the subtree that declares it
 *   - a key of data(), methods, computed or static
 *   - a runtime member every component has ($refs, $emit, $route)
 * Anything left is reported.
 *
 * It only ever WARNS. A template may legitimately read a prop a parent passes, which the
 * runtime assigns into the data bag and which therefore has no declaration site unless
 * the author gives it one (a default in data() is the recommended way, and makes the
 * warning go away). Refusing to compile over that would be wrong.
 */

import { extractDeps } from './exprWalker.js';
import { extractBalanced } from './scriptParser.js';

/** Members the runtime puts on every component, declared by nobody. */
const RUNTIME_MEMBERS = new Set(['$refs', '$emit', '$route', '$el', '$props']);

/** Method modifiers that precede the real key: `async foo() {}`, `get bar() {}`. */
const MODIFIERS = new Set(['async', 'get', 'set', 'static']);

/** Attributes whose value is markup or a name, not an expression to evaluate. */
const NON_EXPRESSION_ATTRS = new Set([':key', ':ref', ':pre']);

/**
 * Top-level keys of an object literal written as source.
 * Walks at depth 1 only, so a nested `{ a: { b: 1 } }` yields `a` and not `b`, and skips
 * strings, template literals and comments so a `:` inside them is never read as a key.
 *
 * @param {string} src - source beginning at or before the opening brace
 * @returns {string[]}
 */
export function topLevelKeys(src) {
    if (!src) return [];
    const open = src.indexOf('{');
    if (open === -1) return [];

    // extractBalanced returns the contents without the braces.
    const inner = extractBalanced(src, open, '{', '}');
    if (!inner) return [];

    const keys = [];
    let depth = 0;
    let i = 0;

    while (i < inner.length) {
        const c = inner[i];

        // Skip anything that can contain a stray ':' or brace.
        if (c === '"' || c === "'" || c === '`') {
            const quote = c;
            i++;
            while (i < inner.length) {
                if (inner[i] === '\\') { i += 2; continue; }
                if (inner[i] === quote) { i++; break; }
                i++;
            }
            continue;
        }
        if (c === '/' && inner[i + 1] === '/') {
            while (i < inner.length && inner[i] !== '\n') i++;
            continue;
        }
        if (c === '/' && inner[i + 1] === '*') {
            i += 2;
            while (i < inner.length && !(inner[i] === '*' && inner[i + 1] === '/')) i++;
            i += 2;
            continue;
        }
        if (c === '{' || c === '[' || c === '(') { depth++; i++; continue; }
        if (c === '}' || c === ']' || c === ')') { depth--; i++; continue; }

        if (depth === 0 && /[A-Za-z_$]/.test(c)) {
            let j = i;
            while (j < inner.length && /[\w$]/.test(inner[j])) j++;
            const word = inner.slice(i, j);
            let k = j;
            while (k < inner.length && /\s/.test(inner[k])) k++;
            // `name:` is a property, `name(` is a method shorthand. A modifier --
            // async, get, set, static, or a generator star -- is followed by the real
            // name, so step over it rather than treating the whole entry as consumed.
            if (MODIFIERS.has(word) && /[*\s]/.test(inner[j] || '')) { i = j; continue; }
            if (inner[k] === ':' || inner[k] === '(') keys.push(word);
            i = j;
            // Skip to the end of this entry so its value contributes no keys.
            let guard = 0;
            while (i < inner.length && guard++ < inner.length) {
                const ch = inner[i];
                if (ch === '"' || ch === "'" || ch === '`') {
                    const quote = ch;
                    i++;
                    while (i < inner.length) {
                        if (inner[i] === '\\') { i += 2; continue; }
                        if (inner[i] === quote) { i++; break; }
                        i++;
                    }
                    continue;
                }
                if (ch === '{' || ch === '[' || ch === '(') { depth++; i++; continue; }
                if (ch === '}' || ch === ']' || ch === ')') { depth--; i++; continue; }
                if (ch === ',' && depth === 0) { i++; break; }
                i++;
            }
            continue;
        }
        i++;
    }
    return keys;
}

/**
 * Keys of the object a `data` factory returns.
 * Handles `data: () => ({...})`, `data() { return {...} }` and `data: function () {...}`.
 *
 * @param {string} src
 * @returns {string[]}
 */
export function dataKeys(src) {
    if (!src) return [];
    const ret = src.indexOf('return');
    // An arrow returning an object has no `return`; its first brace after `=>` is the
    // object. With a `return`, the object is the first brace after it.
    const from = ret !== -1 ? src.slice(ret) : src.slice(src.indexOf('=>') + 1);
    return topLevelKeys(from);
}

/** Parse `item in items` / `(item, i) in items` into the names it introduces. */
function forVars(expression) {
    const m = String(expression || '').match(/^\s*\(?\s*(\w+)(?:\s*,\s*(\w+))?\s*\)?\s+(?:in|of)\s+/);
    if (!m) return [];
    return [m[1], m[2]].filter(Boolean);
}

/**
 * Every name the template reads, paired with where it was read, with `:for` iterators
 * removed in the subtree that declares them.
 *
 * @param {Object} ast - the parsed template
 * @returns {Array<{name: string, where: string}>}
 */
export function templateReads(ast) {
    const found = [];

    function walk(node, scope) {
        if (!node) return;

        if (node.type === 'binding') {
            for (const dep of extractDeps(node.expression, scope)) {
                found.push({ name: dep, where: `{{ ${node.expression.trim()} }}` });
            }
        }

        if (node.type === 'element') {
            const attrs = node.attributes || {};

            // `:pre` turns the subtree into literal markup -- processor.js skips all
            // binding detection inside it, so the names in there are documentation,
            // not reads. The showcase is full of them: its pages print deezul's own
            // syntax as example code.
            if (attrs[':pre'] !== undefined) return;

            // A :for introduces its names for this element and everything under it, and
            // its own right-hand side is evaluated in the OUTER scope.
            let inner = scope;
            if (attrs[':for']) {
                for (const dep of extractDeps(attrs[':for'].replace(/^.*?\s+(?:in|of)\s+/, ''), scope)) {
                    found.push({ name: dep, where: `:for="${attrs[':for']}"` });
                }
                const vars = forVars(attrs[':for']);
                if (vars.length) {
                    inner = new Set(scope);
                    for (const v of vars) inner.add(v);
                }
            }

            for (const [attr, value] of Object.entries(attrs)) {
                if (attr === ':for') continue;
                const isBound = attr.startsWith(':') || attr.startsWith('@');
                if (!isBound || NON_EXPRESSION_ATTRS.has(attr)) continue;
                if (!value) continue;
                for (const dep of extractDeps(value, inner)) {
                    found.push({ name: dep, where: `${attr}="${value}"` });
                }
            }

            for (const child of node.children || []) walk(child, inner);
            return;
        }

        for (const child of node.children || []) walk(child, scope);
    }

    walk(ast, new Set());
    return found;
}

/**
 * Names the template reads that the component does not declare.
 *
 * @param {Object} ast - parsed template
 * @param {Object} parsed - the parseComponent result (raw source per section)
 * @returns {Array<{name: string, where: string}>} one entry per distinct name
 */
export function checkTemplateBindings(ast, parsed) {
    const declared = new Set([
        ...dataKeys(parsed.data),
        ...topLevelKeys(parsed.method),
        ...topLevelKeys(parsed.computed),
        ...topLevelKeys(parsed.staticData),
        ...RUNTIME_MEMBERS,
    ]);

    const seen = new Set();
    const unknown = [];
    for (const read of templateReads(ast)) {
        if (declared.has(read.name) || seen.has(read.name)) continue;
        seen.add(read.name);
        unknown.push(read);
    }
    return unknown;
}
