/**
 * ifBranchInForRow.test.js — bindings INSIDE an :if branch that sits in a :for row must react
 * to the row item they read: the branch's text, its attributes, and any :if nested inside it.
 *
 * Regression guard: renderChainItem bound a branch's contents against the row's iterator
 * scope, but subscribed every dependency on that scope as if it were component state. A
 * binding reading `this.g.here.label` has the dependency `g`, so it subscribed to a component
 * property literally named `g` - which never changes. The branch rendered correctly once and
 * then silently never updated again, whether the row item was mutated in place or its
 * property reassigned. The row's OWN direct :if/:for were unaffected: renderForLoopInstance
 * already routes iterator dependencies to the real item. The branch path did not, and said
 * so in a comment ("per-row reactivity routing for iter-scoped deps is handled in
 * renderForLoopInstance, not in chain branches").
 *
 * Real-world shape that exposed it - a drill-down navigation menu:
 *
 *   <div :for="g in groups">
 *     <ul :if="g.children.length">
 *       <li :if="g.trail.length"><button>Back to {{ g.backLabel }}</button></li>
 *       <li><a :href="g.here.href">{{ g.here.label }}</a></li>
 *     </ul>
 *   </div>
 *
 * Drilling in reassigned g.here and g.trail; the list swapped, but the link kept its old
 * label and address and the Back button never appeared.
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

const TEXT_EVAL = 2;
const ATTR_EVAL = 4;
const PROP_EVAL = 9;

const { proxy } = createReactivity({
    data: {
        suffix: '!',
        groups: [
            { children: [1], trail: [], backLabel: 'Auditor', here: { href: '/auditor', label: 'Auditor' } },
            { children: [1], trail: [], backLabel: 'Shelter', here: { href: '/shelter', label: 'Dog Shelter' } }
        ]
    }
});

const container = document.createElement('div');
const anchor = document.createComment('for');
container.appendChild(anchor);
document.body.appendChild(container);

// An :if nested INSIDE the branch: shown while the row has a trail.
const back = {
    type: 'if', markerPath: [3],
    chain: [{
        condIdx: 0,
        _stamp: stamp('<b class="back">x</b>'), _stampChildCount: 1,
        _descs: [{ type: TEXT_EVAL, path: [0], pathIdx: 0, evalFn: function () { return 'Back to ' + this.g.backLabel; }, deps: ['g'] }],
        dynamics: []
    }],
    condEvals: [function () { return this.g.trail.length; }],
    deps: ['g']
};

// The row's own :if. Its CONDITION already worked; its CONTENTS are what this test is about.
const branch = {
    type: 'if', markerPath: [0, 0],
    chain: [{
        condIdx: 0,
        _stamp: stamp('<a class="home">x</a><i class="sfx">x</i><u class="kid">x</u><!--back-->'), _stampChildCount: 4,
        _descs: [
            // Reads the row item.
            { type: TEXT_EVAL, path: [0], pathIdx: 0, evalFn: function () { return this.g.here.label; }, deps: ['g'] },
            { type: ATTR_EVAL, path: [0], pathIdx: 0, attr: 'href', evalFn: function () { return this.g.here.href; }, deps: ['g'] },
            // Reads ordinary component state - must keep working exactly as before.
            { type: TEXT_EVAL, path: [1], pathIdx: 1, evalFn: function () { return this.suffix; }, deps: ['suffix'] },
            // A prop handed to a child element, read from the row item.
            { type: PROP_EVAL, path: [2], pathIdx: 2, propName: 'label', evalFn: function () { return this.g.here.label; }, deps: ['g'] }
        ],
        dynamics: [back]
    }],
    condEvals: [function () { return this.g.children.length; }],
    deps: ['g']
};

const outer = {
    iterator: 'g',
    _stamp: stamp('<div class="row"><!--branch--></div>'),
    _stampChildCount: 1,
    _inPlaceSafe: false,
    dynamics: [branch],
    _descs: []
};
renderForLoop(outer, proxy.groups, proxy, anchor);

const row = (i) => container.querySelectorAll('.row')[i];
const home = (i) => row(i) && row(i).querySelector('.home');
const backEl = (i) => row(i) && row(i).querySelector('.back');
const kidProp = (i) => { const k = row(i) && row(i).querySelector('.kid'); return k && k._props ? k._props.label : undefined; };

check('initial render reads the row item', home(0).textContent === 'Auditor' && home(0).getAttribute('href') === '/auditor');
check('initial: no Back while the trail is empty', !backEl(0));

// 1. In-place mutation of a nested row-item property.
proxy.groups[0].here.label = 'Property Search';
flushSync();
check('branch text follows an IN-PLACE change to the row item', home(0).textContent === 'Property Search');

// 2. Reassigning the row-item property to a new object (what drill-down does).
proxy.groups[0].here = { href: '/property-search', label: 'Search' };
flushSync();
check('branch text follows a REASSIGNED row-item property', home(0).textContent === 'Search');
check('branch attribute follows it too', home(0).getAttribute('href') === '/property-search');
check('a prop passed to a child element follows it too', kidProp(0) === 'Search');

// 3. The :if nested inside the branch.
proxy.groups[0].trail = ['property-search'];
flushSync();
check('an :if nested INSIDE the branch reacts to the row item (reassigned array)', !!backEl(0));
check('...and renders its own row-item text', backEl(0) && backEl(0).textContent === 'Back to Auditor');

proxy.groups[0].backLabel = 'Property Search';
flushSync();
check('text inside the nested :if keeps reacting', backEl(0) && backEl(0).textContent === 'Back to Property Search');

proxy.groups[0].trail = [];
flushSync();
check('the nested :if hides again', !backEl(0));

proxy.groups[0].trail.push('x');
flushSync();
check('the nested :if reacts to an IN-PLACE array mutation', !!backEl(0));

// 4. Rows stay independent: the subscription is on the right item.
check('another row is untouched', home(1).textContent === 'Dog Shelter' && !backEl(1));
proxy.groups[1].here.label = 'Adopt';
flushSync();
check('the other row reacts to its OWN item', home(1).textContent === 'Adopt' && home(0).textContent === 'Search');

// 5. Component state read from inside the branch is not broken by the routing.
proxy.suffix = '?';
flushSync();
check('component-state bindings inside the branch still update', row(0).querySelector('.sfx').textContent === '?' && row(1).querySelector('.sfx').textContent === '?');

// 6. Toggle the branch off and on: a freshly mounted branch must be wired too, and the
//    torn-down one must not throw when the item changes underneath it.
proxy.groups[0].children = [];
flushSync();
check('the row :if still removes the branch', !home(0));
let threw = null;
try { proxy.groups[0].here.label = 'While hidden'; flushSync(); } catch (e) { threw = e; }
check('changing the item while the branch is gone is safe', threw === null);
proxy.groups[0].children = [1];
flushSync();
check('the branch comes back with current values', home(0) && home(0).textContent === 'While hidden');
proxy.groups[0].here = { href: '/again', label: 'Again' };
flushSync();
check('a re-mounted branch is wired to the item', home(0).textContent === 'Again' && home(0).getAttribute('href') === '/again');

// 7. A :for nested INSIDE the branch, whose source is a row-item property that gets swapped for
//    other arrays and then back to the one it started with. Shape: a drill-down menu, where
//    `view` starts as `children`, drilling swaps in a page's subpages, and reopening the menu
//    points `view` back at `children` - the very array the list first rendered.
(function nestedForSwappedBackToOriginal() {
    const A = [{ n: 'Property Search' }, { n: 'Hours' }];
    const { proxy: p2 } = createReactivity({ data: { groups: [{ children: A, view: A }] } });

    // The list sits inside an element in the branch (<ul><li :for>), like the real menu.
    const list = {
        type: 'for', iterator: 'c', source: 'g.view', sourceBase: 'g',
        markerPath: [0, 0],
        sourceFn: function () { return this.g.view; },
        _stamp: stamp('<span class="c">x</span>'), _stampChildCount: 1, _inPlaceSafe: false, dynamics: [],
        _descs: [{ type: TEXT_EVAL, path: [0], pathIdx: 0, evalFn: function (c) { return c.n; }, deps: ['c'] }]
    };
    const br = {
        type: 'if', markerPath: [0, 0],
        chain: [{ condIdx: 0, _stamp: stamp('<ul class="lst"><!--list--></ul>'), _stampChildCount: 1, _descs: [], dynamics: [list] }],
        condEvals: [function () { return this.g.children.length; }],
        deps: ['g']
    };
    const host = document.createElement('div');
    const a2 = document.createComment('for');
    host.appendChild(a2);
    document.body.appendChild(host);
    renderForLoop({
        iterator: 'g', _stamp: stamp('<div class="row2"><!--br--></div>'), _stampChildCount: 1,
        _inPlaceSafe: false, dynamics: [br], _descs: []
    }, p2.groups, p2, a2);

    const shown = () => [...host.querySelectorAll('.c')].map(s => s.textContent).join(', ');
    const g = p2.groups[0];
    check('7: nested :for renders its source', shown() === 'Property Search, Hours');
    g.view = [{ n: 'Search Tips' }, { n: 'Forms' }];
    flushSync();
    check('7: swapping the source re-renders the list', shown() === 'Search Tips, Forms');
    // Reassigning `view` must not touch the array it USED to hold. Here that array is also
    // `children`; overwriting it in place would silently destroy the group's own data.
    check('7: reassigning a property leaves the array it used to hold unchanged',
        p2.groups[0].children.map(x => x.n).join(', ') === 'Property Search, Hours' && A.length === 2 && A[0].n === 'Property Search');
    g.view = [{ n: 'Advanced' }];
    flushSync();
    check('7: ...and again', shown() === 'Advanced');
    g.view = g.children;
    flushSync();
    check('7: swapping BACK to the original array re-renders it', shown() === 'Property Search, Hours');
    g.view = [{ n: 'Search Tips' }, { n: 'Forms' }];
    flushSync();
    check('7: ...and the list keeps following after that', shown() === 'Search Tips, Forms');
    // The loop follows the array it now shows - not one it used to show.
    g.children.push({ n: 'Stale' });
    flushSync();
    check('7: pushing to an array the list no longer shows leaves the list alone', shown() === 'Search Tips, Forms');
    g.view.push({ n: 'Maps' });
    flushSync();
    check('7: pushing to the array it DOES show appends a row', shown() === 'Search Tips, Forms, Maps');
})();

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nall passed');
