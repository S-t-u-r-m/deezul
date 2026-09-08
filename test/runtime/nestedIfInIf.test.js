/**
 * nestedIfInIf.test.js — an :if BRANCH containing several sibling :if's (some
 * nested deeper than others) must resolve every nested dynamic's marker anchor
 * from the PRISTINE branch template, not from the tree after earlier siblings
 * have already rendered.
 *
 * Regression guard: renderChainItem used to call getNodeByPath(root, markerPath)
 * one dynamic at a time, interleaved with each dynamic's synchronous initial
 * render — the same interleaving renderForLoopInstance had (see
 * nestedIfMarker.test.js). Real-world shape that exposed it: an alert banner
 *
 *   <div :if="!dismissed">
 *     <svg :if="level==='info'"/> <svg :if="level==='warning'"/>
 *     <p><b :if="title">…</b><span :if="message">…</span></p>
 *   </div>
 *
 * The svg :if's render first and shift the live child index of <p>, so the
 * <b>/<span> marker paths (still expressed against the template) resolved to
 * the wrong nodes — and the paragraph's content silently never rendered.
 * Fixed by resolving all of a branch's marker anchors up front.
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
const { renderConditional } = await import('../../src/runtime/render.js');

let failures = 0;
function check(name, cond) {
    if (cond) console.log(`  ok    ${name}`);
    else { failures++; console.error(`  FAIL  ${name}`); }
}

const emptyBinding = { strings: [], code: new Uint16Array(0) };

function ifDynamic(markerPath, condEval, deps, html) {
    return {
        type: 'if',
        markerPath,
        chain: [{ condIdx: 0, template: html, binding: emptyBinding, eval: [], event: [], dynamics: [] }],
        condEvals: [condEval],
        deps
    };
}

// Mirrors the alert banner: outer :if whose branch is
//   <div class="al"><!--if--><!--if--><p><!--if--><!--if--></p></div>
// The two svg-like :ifs (paths [0,0] / [0,1]) render BEFORE the paragraph's
// nested :ifs (paths [0,2,0] / [0,2,1]) are anchored. Once the first :if has
// inserted its node, index 2 under the branch root no longer points at <p>.
{
    const { proxy } = createReactivity({
        data: { shown: true, level: 'warning', title: 'Holiday closing.', message: 'Offices closed Monday.' },
        methods: {}
    });

    const container = document.createElement('div');
    const anchor = document.createComment('if');
    container.appendChild(anchor);
    document.body.appendChild(container);

    const outer = {
        type: 'if',
        anchor,
        chain: [{
            condIdx: 0,
            template: '<div class="al"><!--if--><!--if--><p class="al-p"><!--if--><!--if--></p></div>',
            binding: emptyBinding, eval: [], event: [],
            dynamics: [
                ifDynamic([0, 0], function () { return this.level === 'info'; }, ['level'], '<i class="ic-info">i</i>'),
                ifDynamic([0, 1], function () { return this.level === 'warning'; }, ['level'], '<i class="ic-warn">!</i>'),
                ifDynamic([0, 2, 0], function () { return !!this.title; }, ['title'], '<b>TITLE</b>'),
                ifDynamic([0, 2, 1], function () { return !!this.message; }, ['message'], '<span>MESSAGE</span>')
            ]
        }],
        condEvals: [function () { return this.shown; }],
        deps: ['shown'],
        activeInstance: null,
        activeBranchIndex: -1
    };
    outer.updateFn = () => { /* not exercised */ };

    renderConditional(outer, proxy, anchor);

    const p = container.querySelector('p.al-p');
    check('branch rendered with its paragraph', !!p);
    check('warning icon rendered, info icon not',
        container.querySelectorAll('.ic-warn').length === 1 && container.querySelectorAll('.ic-info').length === 0);
    check('<b :if="title"> rendered INSIDE the paragraph', !!(p && p.querySelector('b')));
    check('<span :if="message"> rendered INSIDE the paragraph', !!(p && p.querySelector('span')));
    check('nothing from the paragraph leaked outside it',
        container.querySelectorAll('b').length === 1 && container.querySelectorAll('span').length === 1
        && container.querySelector('.al > b') === null && container.querySelector('.al > span') === null);

    // Toggling a deeper :if must keep working against its own anchor.
    let threw = false;
    try { proxy.title = ''; flushSync(); } catch (e) { threw = true; console.error(e); }
    check('clearing title does not throw', !threw);
    check('<b> removed when title clears', !!(p && !p.querySelector('b')));
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
else console.log('\nall nested-if-in-if checks passed');
