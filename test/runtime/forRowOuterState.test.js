/**
 * forRowOuterState.test.js — a :for row's PLAIN (non-eval) TEXT/ATTR binding that
 * reads OUTER component state (not the row item) must react when that state changes.
 *
 * Regression guard: renderForLoopInstance's BindingType.TEXT and the non-directive
 * branch of BindingType.ATTR only ever pushed a plain bookkeeping object into the
 * row's local `bindings` array - they never called addBinding (or subscribeForRowEval,
 * used correctly by the *_EVAL sibling cases just below them in the same switch). That
 * bookkeeping object is never wired into Reactivity.js's dataBindMap, so the initial
 * render was correct but the DOM silently never updated again.
 *
 * This is reachable for any bare (non-dotted) identifier bound inside a :for loop that
 * ISN'T the iterator/index var - which, per processor.js's loopVars check forcing any
 * DOTTED access to the iterator into TEXT_EVAL, can only be a reference to outer
 * component data or a computed. The concrete real-world case that surfaced this:
 * DropdownC.js's `<li :for="item in filteredItems" :class="hiddenClass">` - opening a
 * dropdown (isHidden -> false) never actually revealed the options, because the
 * computed `hiddenClass`'s re-evaluation never reached the <li>'s class attribute.
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

function stamp(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const frag = document.createDocumentFragment();
    frag.appendChild(tpl.content);
    return frag;
}

const TEXT = 1;
const ATTR = 3;
const cls = el => (el && el.getAttribute('class')) || '';

// ── Test A: plain :class="hiddenClass" (a COMPUTED) inside a :for row - the exact
//    DropdownC.js shape (isHidden data -> hiddenClass computed -> per-option class) ──
(function attrBoundToOuterComputed() {
    const { proxy } = createReactivity({
        data: { items: [{ key: 'a' }, { key: 'b' }], isHidden: true },
        computed: { hiddenClass() { return this.isHidden ? 'hidden' : ''; } }
    });
    const container = document.createElement('div');
    const anchor = document.createComment('for');
    container.appendChild(anchor);
    document.body.appendChild(container);

    const structure = {
        iterator: 'item',
        _stamp: stamp('<li></li>'),
        _stampChildCount: 1,
        _inPlaceSafe: false,
        dynamics: [],
        _descs: [{ type: ATTR, path: [0], pathIdx: 0, attr: 'class', prop: 'hiddenClass' }]
    };
    renderForLoop(structure, proxy.items, proxy, anchor);

    const rows = () => [...container.querySelectorAll('li')];
    check('A: initial class reflects the computed (isHidden=true)',
        cls(rows()[0]) === 'hidden' && cls(rows()[1]) === 'hidden');

    proxy.isHidden = false;
    flushSync();
    check('A: toggling isHidden updates every row\'s class via the computed',
        cls(rows()[0]) === '' && cls(rows()[1]) === '');

    proxy.isHidden = true;
    flushSync();
    check('A: toggling back re-applies the class', cls(rows()[0]) === 'hidden' && cls(rows()[1]) === 'hidden');
})();

// ── Test B: plain {{ label }} (bare OUTER DATA property, not a computed) inside a
//    :for row text binding ──
(function textBoundToOuterData() {
    const { proxy } = createReactivity({
        data: { items: [{ key: 'a' }, { key: 'b' }], label: 'Loading' }
    });
    const container = document.createElement('div');
    const anchor = document.createComment('for');
    container.appendChild(anchor);
    document.body.appendChild(container);

    const structure = {
        iterator: 'item',
        _stamp: stamp('<span></span>'),
        _stampChildCount: 1,
        _inPlaceSafe: false,
        dynamics: [],
        _descs: [{ type: TEXT, path: [0], pathIdx: 0, prop: 'label' }]
    };
    renderForLoop(structure, proxy.items, proxy, anchor);

    const rows = () => [...container.querySelectorAll('span')];
    check('B: initial text reflects outer data', rows()[0].textContent === 'Loading' && rows()[1].textContent === 'Loading');

    proxy.label = 'Ready';
    flushSync();
    check('B: changing outer data updates every row\'s text', rows()[0].textContent === 'Ready' && rows()[1].textContent === 'Ready');
})();

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
else console.log('\nall for-row outer-state (non-eval) checks passed');
