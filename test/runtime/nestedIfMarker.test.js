/**
 * nestedIfMarker.test.js — a :for row with MULTIPLE sibling :if's must resolve
 * every nested dynamic's marker anchor from the PRISTINE row template, not
 * from whatever the tree looks like after earlier dynamics in the same row
 * have already rendered.
 *
 * Regression guard: renderForLoopInstance used to call getNodeByPath(root,
 * markerPath) one dynamic at a time, interleaved with each dynamic's own
 * synchronous initial render. An earlier :if that rendered content shifted
 * the live child-node indices, so a LATER :if's marker path (still expressed
 * against the original template) could resolve to the earlier :if's rendered
 * (and later removable) content instead of its own permanent marker comment.
 * That mis-capture is invisible until the real owner removes its content —
 * at which point the later structure's insertBefore throws on a detached
 * node's null parentNode. Fixed by resolving all of a row's marker anchors
 * up front, before any of them render.
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

const emptyBinding = { strings: [], code: new Uint16Array(0) };

function ifDynamic(markerPath, condEval, deps, label, tag = 'button') {
    return {
        type: 'if',
        markerPath,
        chain: [{
            condIdx: 0,
            template: `<${tag}>${label}</${tag}>`,
            binding: emptyBinding, eval: [], event: [], dynamics: []
        }],
        condEvals: [condEval],
        deps
    };
}

// Mirrors:
//   <div class="row" :for="s in items">
//     <button :if="!armed">Move</button>
//     <button :if="!armed">Del</button>
//     <span :if="armed && armed.id !== s.id">After</span>
//   </div>
// Two root-only :if's (share the same anchor-shift risk) followed by a third
// :if mixing a root dep with an iterator dep — the shape that triggered the
// original crash, since the third's anchor was captured only after the first
// two had already inserted their own content.
{
    const { proxy } = createReactivity({
        data: { items: [{ id: 1 }, { id: 2 }, { id: 3 }], armed: null },
        methods: { arm() { this.armed = { id: 1 }; } }
    });

    const container = document.createElement('div');
    const anchor = document.createComment('for');
    container.appendChild(anchor);
    document.body.appendChild(container);

    const structure = {
        template: '<div class="row"><!--if--><!--if--><!--if--></div>',
        binding: emptyBinding, eval: [], event: [],
        iterator: 's',
        dynamics: [
            ifDynamic([0, 0], function () { return !this.armed; }, ['armed'], 'Move'),
            ifDynamic([0, 1], function () { return !this.armed; }, ['armed'], 'Del'),
            ifDynamic([0, 2], function () { return this.armed && this.armed.id !== this.s.id; }, ['armed', 's'], 'After', 'span')
        ]
    };

    renderForLoop(structure, proxy.items, proxy, anchor);
    check('initial render: both root-only :ifs show (armed is null)',
        container.querySelectorAll('button').length === 6 && container.querySelectorAll('span').length === 0);

    let threw = false;
    try {
        proxy.arm();
        flushSync();
    } catch (e) { threw = true; console.error(e); }

    check('arming does not throw (no stale-anchor insertBefore crash)', !threw);
    check('root-only :ifs hide once armed', container.querySelectorAll('button').length === 0);
    check('mixed-dep :if shows for the two non-matching rows', container.querySelectorAll('span').length === 2);
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
else console.log('\nall nested-if-marker checks passed');
