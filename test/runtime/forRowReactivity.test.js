/**
 * forRowReactivity.test.js — a :for row's eval binding (text/attr) must react to an
 * in-place mutation of an item PROPERTY it reads, for BOTH:
 *   - the row's own item  (direct iterator, a bare `item.prop`), and
 *   - an ENCLOSING iterator in a nested :for (`this.outer.prop`).
 *
 * Regression guard for the fix in render.js/subscribeForRowEval + extractParamDeps
 * (the row-binding analogue of addDynamicStructure). Structures are hand-built with
 * pre-set _stamp/_descs so real eval functions can be supplied without bytecode.
 */
import { Window } from 'happy-dom';

const window = new Window();
globalThis.window = window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.ShadowRoot = window.ShadowRoot;
globalThis.CustomEvent = window.CustomEvent;
globalThis.Event = window.Event;

const { default: createReactivity } = await import('../../src/runtime/Reactivity.js');
const { flushSync } = await import('../../src/runtime/DataProxy.js');
const { renderForLoop } = await import('../../src/runtime/render.js');

let failures = 0;
function check(name, cond) {
    if (cond) console.log(`  ok    ${name}`);
    else { failures++; console.error(`  FAIL  ${name}`); }
}

// Build a DocumentFragment stamp from HTML (what ensureForStamp caches as _stamp).
const cls = el => (el && el.getAttribute('class')) || '';

function stamp(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const frag = document.createDocumentFragment();
    frag.appendChild(tpl.content);
    return frag;
}
const ATTR_EVAL = 4;

// ── Test A: direct iterator — row <i> class reads item.active ──────────────────
(function directItemProp() {
    const { proxy } = createReactivity({ data: { items: [{ id: 1, active: false }, { id: 2, active: true }] } });
    const container = document.createElement('div');
    const anchor = document.createComment('for');
    container.appendChild(anchor);
    document.body.appendChild(container);

    const structure = {
        iterator: 'item',
        _stamp: stamp('<i></i>'),
        _stampChildCount: 1,
        _inPlaceSafe: false,
        dynamics: [],
        _descs: [{
            type: ATTR_EVAL, path: [0], pathIdx: 0, attr: 'class',
            evalFn: function (item) { return item.active ? 'active' : ''; },
            deps: ['item']
        }]
    };
    renderForLoop(structure, proxy.items, proxy, anchor);

    const rows = () => [...container.querySelectorAll('i')];
    check('A: initial class reflects item.active', cls(rows()[0]) === '' && cls(rows()[1]) === 'active');

    proxy.items[0].active = true;
    flushSync();
    check('A: mutating item.active updates the row class', cls(rows()[0]) === 'active');

    proxy.items[1].active = false;
    flushSync();
    check('A: clearing item.active removes the class', cls(rows()[1]) === '');
})();

// ── Test B: nested :for — inner chip class reads this.section.sel === chip.id ───
(function enclosingIteratorProp() {
    const { proxy } = createReactivity({
        data: { sections: [{ id: 'S', sel: 'a', chips: [{ id: 'a' }, { id: 'b' }] }] }
    });
    const container = document.createElement('div');
    const anchor = document.createComment('for');
    container.appendChild(anchor);
    document.body.appendChild(container);

    // Inner :for over section.chips; each chip <i> is "on" when section.sel === chip.id.
    const inner = {
        type: 'for', iterator: 'chip', source: 'section.chips', sourceBase: 'section',
        markerPath: [0, 0],           // the comment inside the row <div>
        sourceFn: function () { return this.section.chips; },
        _stamp: stamp('<i></i>'), _stampChildCount: 1, _inPlaceSafe: false, dynamics: [],
        _descs: [{
            type: ATTR_EVAL, path: [0], pathIdx: 0, attr: 'class',
            evalFn: function (chip) { return this.section.sel === chip.id ? 'on' : ''; },
            deps: ['section', 'chip']
        }]
    };
    const outer = {
        iterator: 'section',
        _stamp: stamp('<div><!--chips--></div>'),
        _stampChildCount: 1,
        _inPlaceSafe: false,
        dynamics: [inner],
        _descs: []
    };
    renderForLoop(outer, proxy.sections, proxy, anchor);

    const chips = () => [...container.querySelectorAll('i')];
    check('B: initial — chip "a" on, "b" off', cls(chips()[0]) === 'on' && cls(chips()[1]) === '');

    proxy.sections[0].sel = 'b';       // mutate the ENCLOSING iterator's prop in place
    flushSync();
    check('B: mutating section.sel re-highlights the nested chips',
        cls(chips()[0]) === '' && cls(chips()[1]) === 'on');
})();

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
else console.log('\nall for-row reactivity checks passed');
