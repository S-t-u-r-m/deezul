/**
 * booleanAttrs.test.js — a boolean attribute is ON when it is PRESENT; its text is
 * ignored. So a binding that yields a string or null has to be applied by truthiness:
 *
 *     <input :disabled="locked ? 'disabled' : null">
 *
 * This is the idiom Vue, Alpine and Angular all take, and writing the value out instead
 * renders disabled="null" the moment the condition is false — which is still disabled,
 * for good, with nothing in the DOM that looks wrong. It shipped exactly once that we
 * know of: an alt-text field in the Deezul CMS that could never be typed in.
 *
 * The rule lives in setAttrMerged (constants.js), the sink every attribute write funnels
 * through, rather than in the six places that decide whether a value "looks boolean" —
 * those saw only the FIRST value a binding ever produced and cached their decision.
 *
 * The other half: null and undefined mean NO attribute, never the text "null". But false
 * on an ordinary attribute still writes "false", because aria-pressed="false" and
 * aria-expanded="false" mean something and must survive.
 */

import { Window } from 'happy-dom';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

const window = new Window();
globalThis.window = window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.CustomEvent = window.CustomEvent;
globalThis.Event = window.Event;

const { default: createReactivity } = await import('../../src/runtime/Reactivity.js');
const { flushSync } = await import('../../src/runtime/DataProxy.js');
const { applyDescsToTree, decodeBindingDescs } = await import('../../src/runtime/render.js');
const { compileComponentToCode } = await import('../../src/compiler/library/main.js');

let failures = 0;
function check(name, cond, extra) {
    if (cond) console.log(`  ok    ${name}`);
    else { failures++; console.error(`  FAIL  ${name}${extra !== undefined ? '   [' + extra + ']' : ''}`); }
}

const tmp = mkdtempSync(join(tmpdir(), 'deezul-bool-attrs-'));
let compiled = 0;

/** Compile a template, stamp it, and apply its bindings — the real path, no hand-built descs. */
async function mount(template, data) {
    const src = `export default Deezul.Component({ template: \`${template}\`, data: () => (${data}) });`;
    const file = join(tmp, `c${compiled++}.mjs`);
    writeFileSync(file, compileComponentToCode(src, { componentName: 'BoolAttrs' }));
    const def = (await import(pathToFileURL(file).href)).default;

    const { proxy } = createReactivity({ data: def.data(), methods: {} });
    const tpl = document.createElement('template');
    tpl.innerHTML = def.template;
    const root = document.createDocumentFragment();
    root.appendChild(tpl.content);
    applyDescsToTree(root, decodeBindingDescs(def.binding, def.eval, def.event), proxy);

    const host = document.createElement('div');
    host.appendChild(root);
    document.body.appendChild(host);
    return { proxy, host };
}

const has = (host, sel, attr) => host.querySelector(sel).hasAttribute(attr);
const val = (host, sel, attr) => host.querySelector(sel).getAttribute(attr);

try {
    // ── The string-or-null idiom ──
    {
        const { proxy, host } = await mount(
            '<input class="a" :disabled="locked ? \'disabled\' : null">', '{ locked: false }');
        check('a string-or-null binding is OFF when it yields null', !has(host, '.a', 'disabled'),
              'disabled=' + val(host, '.a', 'disabled'));
        proxy.locked = true;
        flushSync();
        check('...and ON when it yields the string', has(host, '.a', 'disabled'));
        proxy.locked = false;
        flushSync();
        check('...and OFF again — the decision is not frozen at the first value',
              !has(host, '.a', 'disabled'), 'disabled=' + val(host, '.a', 'disabled'));
    }

    // ── Starting from the string, so the first value seen is NOT a boolean ──
    {
        const { proxy, host } = await mount(
            '<input class="a" :disabled="locked ? \'disabled\' : null">', '{ locked: true }');
        check('starting ON works too', has(host, '.a', 'disabled'));
        proxy.locked = false;
        flushSync();
        check('...and still turns OFF', !has(host, '.a', 'disabled'), 'disabled=' + val(host, '.a', 'disabled'));
    }

    // ── A real boolean, which always worked ──
    {
        const { proxy, host } = await mount('<input class="b" :disabled="flag">', '{ flag: true }');
        check('a real boolean is ON when true', has(host, '.b', 'disabled'));
        proxy.flag = false;
        flushSync();
        check('...and OFF when false', !has(host, '.b', 'disabled'));
    }

    // ── Truthiness, consistently: '' is off, any other string is on ──
    {
        const { host } = await mount('<input type="checkbox" class="c" :checked="mark">', "{ mark: '' }");
        check('an empty string is OFF, like every other falsy value', !has(host, '.c', 'checked'));
    }
    {
        const { host } = await mount('<input type="checkbox" class="c" :checked="mark">', "{ mark: 'checked' }");
        check('...and a non-empty one is ON', has(host, '.c', 'checked'));
    }

    // ── What must NOT change: enumerated attributes carrying real strings ──
    {
        const { proxy, host } = await mount(
            '<button class="d" :aria-pressed="on ? \'true\' : \'false\'">x</button>', '{ on: false }');
        check('aria-pressed="false" survives — it is a value, not a presence',
              val(host, '.d', 'aria-pressed') === 'false', val(host, '.d', 'aria-pressed'));
        proxy.on = true;
        flushSync();
        check('...and still flips to "true"', val(host, '.d', 'aria-pressed') === 'true');
    }

    // ── No value means no attribute, for ordinary attributes too ──
    {
        const { proxy, host } = await mount('<a class="e" :title="tip">x</a>', '{ tip: null }');
        check('a null ordinary attribute is left off, not written as "null"',
              !has(host, '.e', 'title'), 'title=' + val(host, '.e', 'title'));
        proxy.tip = 'Open the file';
        flushSync();
        check('...and appears when there is something to say', val(host, '.e', 'title') === 'Open the file');
        proxy.tip = null;
        flushSync();
        check('...and goes away again', !has(host, '.e', 'title'), 'title=' + val(host, '.e', 'title'));
    }
} finally {
    if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
    else console.log('\nall boolean-attribute checks passed');
}
