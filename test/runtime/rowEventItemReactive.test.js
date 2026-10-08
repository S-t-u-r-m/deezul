/**
 * rowEventItemReactive.test.js — a :for row's item, handed to an event handler, is REACTIVE.
 *
 * Rows hold RAW items (identity-keyed reconcile compares them), and handler arguments used to
 * be those raw items. A handler that mutated its argument - `toggle(item)` doing
 * `item.open = !item.open`, or a nested row's `drill(g, c)` doing `g.view = c.children` -
 * wrote straight past reactivity and the page never updated. It only appeared to work for
 * lists that had been reassigned, because reassignment used to rebuild rows around proxies.
 */
import { Window } from 'happy-dom';

const window = new Window();
globalThis.window = window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.ShadowRoot = window.ShadowRoot;
globalThis.CustomEvent = window.CustomEvent;
globalThis.Event = window.Event;

const { default: createReactivity, addDynamicStructure } = await import('../../src/runtime/Reactivity.js');
const { flushSync } = await import('../../src/runtime/DataProxy.js');
const { renderForLoop, forLoopReconcile } = await import('../../src/runtime/render.js');

let failures = 0;
function check(name, cond) {
    if (cond) console.log(`  ok    ${name}`);
    else { failures++; console.error(`  FAIL  ${name}`); }
}
const TEXT_EVAL = 2;
function stamp(html) {
    const t = document.createElement('template');
    t.innerHTML = html;
    const f = document.createDocumentFragment();
    f.appendChild(t.content);
    return f;
}
const click = (el) => el.dispatchEvent(new window.Event('click', { bubbles: true }));

// 1-2. A flat list: <li><button @click="toggle(item)"></button><span>{{ item.on ? 'on' : 'off' }}</span></li>
{
    const { proxy } = createReactivity({
        data: { items: [{ on: false }, { on: false }] },
        methods: { toggle(item) { item.on = !item.on; } }
    });
    const container = document.createElement('div');
    const anchor = document.createComment('for');
    container.appendChild(anchor);
    document.body.appendChild(container);
    const structure = {
        template: '<li><button>x</button><span>x</span></li>',
        // EVENT on li>button [6, 2, 0,0, name 0, config 0]; TEXT_EVAL on li>span [2, 2, 0,1, eval 0, 1 dep, dep 1]
        binding: { strings: ['click', 'item.on'], code: new Uint16Array([6, 2, 0, 0, 0, 0, 2, 2, 0, 1, 0, 1, 1]) },
        eval: [function (item) { return item.on ? 'on' : 'off'; }],
        event: [['click', 'toggle', 'item']],
        iterator: 'item',
        dynamics: []
    };
    structure.updateFn = () => { if (Array.isArray(proxy.items)) forLoopReconcile(structure, proxy.items); };
    renderForLoop(structure, proxy.items, proxy, anchor);
    addDynamicStructure(proxy, 'items', structure);

    const states = () => [...container.querySelectorAll('span')].map(s => s.textContent).join(',');
    check('initial render', states() === 'off,off');
    click(container.querySelectorAll('button')[1]);
    flushSync();
    check('a handler mutating its row item updates that row (first-render rows)', states() === 'off,on');

    proxy.items = [{ on: true }, { on: false }, { on: false }];
    flushSync();
    check('reassigned list renders', states() === 'on,off,off');
    click(container.querySelectorAll('button')[2]);
    flushSync();
    check('...and a handler mutating its row item still updates that row', states() === 'on,off,on');

    proxy.items.sort((a, b) => Number(b.on) - Number(a.on));
    flushSync();
    click(container.querySelectorAll('button')[0]);
    flushSync();
    check('after a reorder the handler gets the row\'s CURRENT item, reactive', states() === 'off,on,off');
}

// 3. The drill-down menu: a nested row's handler reassigns properties of the OUTER row's item.
{
    let seen = null;
    const { proxy } = createReactivity({
        data: { groups: [] },
        methods: {
            drillInto(g, node) {
                seen = node;
                g.trail = g.trail.concat([node]);
                g.view = node.children;
            }
        }
    });
    const list = {
        type: 'for', iterator: 'c', source: 'g.view', sourceBase: 'g', markerPath: [0, 0],
        sourceFn: function () { return this.g.view; },
        template: '<li class="c"><span>x</span><button>d</button></li>',
        binding: { strings: ['c.n', 'click'], code: new Uint16Array([2, 2, 0, 0, 0, 1, 0, 6, 2, 0, 1, 1, 0]) },
        eval: [function (c) { return c.n; }],
        event: [['click', 'drillInto', 'g', 'c']],
        dynamics: []
    };
    const br = {
        type: 'if', markerPath: [0, 0],
        chain: [{
            condIdx: 0, _stamp: stamp('<ul class="lst"><!--list--></ul><b class="trail">x</b>'), _stampChildCount: 2,
            _descs: [{ type: TEXT_EVAL, path: [1], pathIdx: 1, evalFn: function () { return 'trail:' + this.g.trail.length; }, deps: ['g'] }],
            dynamics: [list]
        }],
        condEvals: [function () { return this.g.children.length; }],
        deps: ['g']
    };
    const host = document.createElement('div');
    const anchor = document.createComment('for');
    host.appendChild(anchor);
    document.body.appendChild(host);
    const outer = { iterator: 'g', _stamp: stamp('<div class="row"><!--br--></div>'), _stampChildCount: 1, _inPlaceSafe: false, dynamics: [br], _descs: [] };
    outer.updateFn = () => { if (Array.isArray(proxy.groups)) forLoopReconcile(outer, proxy.groups); };
    renderForLoop(outer, proxy.groups, proxy, anchor);
    addDynamicStructure(proxy, 'groups', outer);

    const tips = [{ n: 'Search Tips', children: [] }, { n: 'Forms', children: [] }];
    const children = [{ n: 'Property Search', children: tips }, { n: 'Hours', children: [] }];
    proxy.groups = [{ children, view: children, trail: [] }];   // loaded after mount, as the menu does
    flushSync();

    const shown = () => [...host.querySelectorAll('.c span')].map(s => s.textContent).join(', ');
    const trail = () => (host.querySelector('.trail') || {}).textContent;
    check('3: menu renders after load', shown() === 'Property Search, Hours' && trail() === 'trail:0');
    click(host.querySelector('.c button'));
    flushSync();
    check('3: a nested row\'s handler that reassigns the outer item\'s list swaps it', shown() === 'Search Tips, Forms');
    check('3: ...and the outer item\'s other bindings follow', trail() === 'trail:1');
    check('3: ...and the list it replaced is untouched', children.length === 2 && children[0].n === 'Property Search');
    check('3: the nested row\'s own item arrived reactive too', !!seen && seen.n === 'Property Search');
}

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nall passed');
