/**
 * dom.test.js — Runtime DOM tests on happy-dom.
 *
 * Exercises the render layer (renderForLoop / renderConditional /
 * applyDescsToTree) against a real DOM implementation: keyed reconcile with
 * node identity + state preservation, surgical mutations, :if stamp caching,
 * checkbox two-way binding, and store-driven bindings across the flush.
 *
 * Tests target the render primitives directly (the same call shapes
 * DzComponent uses) rather than the custom-element lifecycle, so they stay
 * independent of happy-dom's custom-elements implementation details.
 */

import { Window } from 'happy-dom';

const window = new Window();
globalThis.window = window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.ShadowRoot = window.ShadowRoot;
globalThis.CustomEvent = window.CustomEvent;
globalThis.Event = window.Event;

// Import AFTER the DOM globals exist.
const { default: createReactivity, addDynamicStructure, addBinding } = await import('../../src/runtime/Reactivity.js');
const { flushSync } = await import('../../src/runtime/DataProxy.js');
const { renderForLoop, renderConditional, updateConditional, applyDescsToTree, decodeBindingDescs } = await import('../../src/runtime/render.js');
const { createModuleRegistry } = await import('../../src/runtime/ModuleRegistry.js');

let failures = 0;
function check(name, cond) {
    if (cond) console.log(`  ok    ${name}`);
    else { failures++; console.error(`  FAIL  ${name}`); }
}

function mountForLoop(items, extraStructure = {}) {
    const { proxy } = createReactivity({ data: { items } });
    const container = document.createElement('div');
    const anchor = document.createComment('for');
    container.appendChild(anchor);
    document.body.appendChild(container);

    const structure = {
        // TEXT binding on the <span> inside each <li>: [type=1, pathLen=2, path 0,0, propIdx=0]
        template: '<li><span>​</span></li>',
        binding: { strings: ['item'], code: new Uint16Array([1, 2, 0, 0, 0]) },
        eval: [],
        event: [],
        iterator: 'item',
        dynamics: [],
        ...extraStructure
    };
    structure.updateFn = (value) => {
        if (Array.isArray(value)) {
            // mirrors the runtime wiring in DzComponent.processDynamics
        }
    };
    renderForLoop(structure, proxy.items, proxy, anchor);
    return { proxy, container, structure };
}

const texts = (container) => [...container.querySelectorAll('li')].map(li => li.textContent);

// ── :for — initial render + surgical mutations ──
{
    const { proxy, container } = mountForLoop(['a', 'b', 'c']);
    check(':for initial render', texts(container).join('') === 'abc');

    proxy.items.push('d');
    flushSync();
    check(':for push appends', texts(container).join('') === 'abcd');

    proxy.items.splice(1, 1);
    flushSync();
    check(':for splice removes', texts(container).join('') === 'acd');

    proxy.items.unshift('z');
    flushSync();
    check(':for unshift prepends', texts(container).join('') === 'zacd');

    proxy.items[0] = 'y';
    flushSync();
    check(':for index set updates in place', texts(container).join('') === 'yacd');
}

// ── :for — keyed reconcile: node identity + state preservation ──
{
    const a = { id: 1, label: 'one' };
    const b = { id: 2, label: 'two' };
    const c = { id: 3, label: 'three' };
    const { proxy, container } = mountForLoop([a, b, c], {
        binding: { strings: ['item.label'], code: new Uint16Array([2, 2, 0, 0, 0, 1, 0]) },
        // TEXT_EVAL: [type=2, pathLen=2, path 0,0, evalIdx=0, depsLen=1, depIdx=0]
        eval: [function (item) { return item.label; }],
        keyFn: (item) => item.id
    });
    check('keyed initial render', texts(container).join(',') === 'one,two,three');

    // Mark row DOM state that reconcile must carry with the item
    const liOne = container.querySelectorAll('li')[0];
    liOne.setAttribute('data-marker', 'sticky');

    // Reorder via reassignment (filter/sort/refetch pattern)
    proxy.items = [c, a, b];
    flushSync();
    check('keyed reorder updates order', texts(container).join(',') === 'three,one,two');

    const lis = container.querySelectorAll('li');
    check('keyed reorder MOVES nodes (state follows item)', lis[1] === liOne && lis[1].getAttribute('data-marker') === 'sticky');

    // New objects, same keys — :key matches them to existing rows
    proxy.items = [{ id: 1, label: 'uno' }, { id: 3, label: 'tres' }];
    flushSync();
    const lis2 = container.querySelectorAll('li');
    check('keyed refetch reuses rows by :key', lis2.length === 2 && lis2[0] === liOne && texts(container).join(',') === 'uno,tres');

    // Sort mutation goes through the reorder path
    proxy.items.sort((x, y) => x.label.localeCompare(y.label));
    flushSync();
    check('keyed sort reorders DOM', texts(container).join(',') === 'tres,uno');

    // Clear via reassignment
    proxy.items = [];
    flushSync();
    check('keyed clear removes all rows', container.querySelectorAll('li').length === 0);
}

// ── :for — IDENTITY-keyed reconcile (no :key) ──
{
    const a = { label: 'one' };
    const b = { label: 'two' };
    const c = { label: 'three' };
    const { proxy, container } = mountForLoop([a, b, c], {
        binding: { strings: ['item.label'], code: new Uint16Array([2, 2, 0, 0, 0, 1, 0]) },
        eval: [function (item) { return item.label; }]
    });
    const liA = container.querySelectorAll('li')[0];
    liA.setAttribute('data-marker', 'sticky');

    // No :key — items key on reference identity (rows hold RAW items, so
    // initial-render rows must match reassigned raw arrays)
    proxy.items = [c, b, a];
    flushSync();
    const lis = container.querySelectorAll('li');
    check('identity-keyed reorder moves nodes', lis[2] === liA && lis[2].getAttribute('data-marker') === 'sticky');
    check('identity-keyed reorder content correct', texts(container).join(',') === 'three,two,one');

    // filter-then-assign removes the middle row, keeps the others' nodes
    proxy.items = [c, a];
    flushSync();
    const lis2 = container.querySelectorAll('li');
    check('identity-keyed filter keeps surviving rows', lis2.length === 2 && lis2[1] === liA);
}

// ── :if — toggling + stamp caching ──
{
    const { proxy } = createReactivity({ data: { show: true, msg: 'hello' } });
    const container = document.createElement('div');
    const anchor = document.createComment('if');
    container.appendChild(anchor);
    document.body.appendChild(container);

    const onItem = {
        condIdx: 0,
        template: '<p>​</p>',
        binding: { strings: ['msg'], code: new Uint16Array([1, 1, 0, 0]) },
        eval: [], event: [], dynamics: []
    };
    const offItem = {
        template: '<p>off</p>',
        binding: { strings: [], code: new Uint16Array(0) },
        eval: [], event: [], dynamics: []
    };
    const structure = {
        chain: [onItem, offItem],
        condEvals: [function () { return this.show; }],
        deps: ['show']
    };
    structure.updateFn = () => updateConditional(structure, proxy);
    renderConditional(structure, proxy, anchor);
    addDynamicStructure(proxy, 'show', structure);

    check(':if renders true branch', container.querySelector('p')?.textContent === 'hello');
    check(':if branch stamp is cached after first render', !!onItem._stamp && !!onItem._descs);
    const stampBefore = onItem._stamp;

    proxy.show = false;
    flushSync();
    check(':if swaps to else branch', container.querySelector('p')?.textContent === 'off');

    proxy.show = true;
    flushSync();
    check(':if swaps back', container.querySelector('p')?.textContent === 'hello');
    check(':if re-activation reuses cached stamp', onItem._stamp === stampBefore);

    proxy.msg = 'changed';
    flushSync();
    check(':if branch binding stays reactive after toggle', container.querySelector('p')?.textContent === 'changed');
}

// ── Two-way checkbox via applyDescsToTree ──
{
    const { proxy } = createReactivity({ data: { agreed: false } });
    const root = document.createElement('div');
    root.innerHTML = '<input type="checkbox">';
    document.body.appendChild(root);

    // TWO_WAY: [type=5, pathLen=1, path 0, refIdx=0, isDotted=0]
    const descs = decodeBindingDescs(
        { strings: ['agreed'], code: new Uint16Array([5, 1, 0, 0, 0]) },
        [], []
    );
    applyDescsToTree(root, descs, proxy);
    const input = root.querySelector('input');

    check('checkbox initial state from model', input.checked === false);

    proxy.agreed = true;
    flushSync();
    check('model → checkbox uses .checked', input.checked === true);

    input.checked = false;
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
    flushSync();
    check('checkbox → model reads .checked (not .value)', proxy.agreed === false);
}

// ── :for — delegated events ──
{
    const picked = [];
    const a = { id: 1 }, b = { id: 2 }, c = { id: 3 };
    const { proxy } = createReactivity({
        data: { items: [a, b, c] },
        methods: { pick(item) { picked.push(item); } }
    });
    const container = document.createElement('div');
    const anchor = document.createComment('for');
    container.appendChild(anchor);
    document.body.appendChild(container);

    const structure = {
        template: '<li><button>x</button></li>',
        // EVENT on the <button>: [type=6, pathLen=2, path 0,0, eventNameIdx=0, configIdx=0]
        binding: { strings: ['click'], code: new Uint16Array([6, 2, 0, 0, 0, 0]) },
        eval: [],
        event: [['click', 'pick', 'item']],
        iterator: 'item',
        dynamics: []
    };
    renderForLoop(structure, proxy.items, proxy, anchor);

    const buttons = () => [...container.querySelectorAll('button')];
    check('delegation: rows carry entries, not listeners', !!buttons()[0]._dzEvents);

    buttons()[1].dispatchEvent(new window.Event('click', { bubbles: true }));
    check('delegated click resolves the row item', picked.length === 1 && picked[0] === b);

    // Rows created after the delegate was attached still fire
    const d = { id: 4 };
    proxy.items.push(d);
    flushSync();
    buttons()[3].dispatchEvent(new window.Event('click', { bubbles: true }));
    check('delegated click works for pushed rows', picked[1] === d);

    // After a reorder, handlers see the row's CURRENT item
    proxy.items = [d, c, b, a];
    flushSync();
    buttons()[0].dispatchEvent(new window.Event('click', { bubbles: true }));
    check('delegated click sees current item after reorder', picked[2] === d);
}

// ── Leave animations: unmounted directive returning a Promise defers removal ──
{
    const { registerDirective } = await import('../../src/runtime/Directives.js');
    let resolveLeave;
    const leaveDone = new Promise(r => { resolveLeave = r; });
    let unmountedCalls = 0;
    registerDirective('fade', {
        mounted() {},
        unmounted() { unmountedCalls++; return leaveDone; }
    });

    const { proxy, container } = mountForLoop(['a', 'b', 'c'], {
        // ATTR :fade="item" on the <li>: [type=3, pathLen=1, path 0, attrIdx=0, propIdx=1]
        binding: { strings: ['fade', 'item'], code: new Uint16Array([3, 1, 0, 0, 1]) }
    });
    check('leave: rows rendered with directive', container.querySelectorAll('li').length === 3);

    proxy.items.pop();
    flushSync();
    check('leave: unmounted hook fired at removal', unmountedCalls === 1);
    check('leave: node stays in DOM while promise pends', container.querySelectorAll('li').length === 3);

    resolveLeave();
    await new Promise(r => setTimeout(r, 0)); // let the allSettled chain run
    check('leave: node detaches after promise settles', container.querySelectorAll('li').length === 2);

    // Sync unmounted hooks (no promise) keep removing immediately
    registerDirective('snap', { mounted() {}, unmounted() {} });
    const second = mountForLoop(['x', 'y'], {
        binding: { strings: ['snap', 'item'], code: new Uint16Array([3, 1, 0, 0, 1]) }
    });
    second.proxy.items.pop();
    flushSync();
    check('leave: sync unmounted removes immediately', second.container.querySelectorAll('li').length === 1);
}

// ── Isolated props (bare :prop): objects auto-clone, one-way down ──
{
    const parentUser = { name: 'Ann', tags: ['x'] };
    const parent = createReactivity({ data: { user: parentUser, count: 1 } });
    const child = createReactivity({ data: { user: null, count: 0 } });

    const root = document.createElement('div');
    root.innerHTML = '<div></div>';
    document.body.appendChild(root);
    const el = root.querySelector('div');
    el.component = { isMounted: true, proxy: child.proxy };

    // PROP user←user and PROP count←count
    const descs = decodeBindingDescs(
        { strings: ['user', 'user', 'count', 'count'], code: new Uint16Array([7, 1, 0, 0, 1, 7, 1, 0, 2, 3]) },
        [], []
    );
    applyDescsToTree(root, descs, parent.proxy);
    flushSync();

    check('isolated object prop arrives as a clone', child.proxy.user !== parentUser && child.proxy.user.name === 'Ann');

    child.proxy.user.name = 'HACKED';
    flushSync();
    check('child mutation never reaches parent', parentUser.name === 'Ann');

    // Parent nested mutation pushes a FRESH clone down (via ancestor bubbling)
    parent.proxy.user.name = 'Bea';
    flushSync();
    check('parent nested mutation re-clones down', child.proxy.user.name === 'Bea' && child.proxy.user !== parentUser);

    // Primitives: down-only, child divergence stays local
    child.proxy.count = 99;
    flushSync();
    check('isolated primitive write stays local', parent.proxy.count === 1);
    check('bare prop registers no sync bridge', !el._syncProps);
}

// ── Shared props (.share): live both ways via the sync bridge ──
{
    const parent = createReactivity({ data: { count: 1 } });
    const child = createReactivity({ data: { count: 0 } });

    const root = document.createElement('div');
    root.innerHTML = '<div></div>'; // stand-in for the <dz-component> element
    document.body.appendChild(root);
    const el = root.querySelector('div');
    el.component = { isMounted: true, proxy: child.proxy };

    // Parent side: PROP_SYNC binding [type=8, pathLen=1, path 0, propNameIdx=0, sourceIdx=1]
    const descs = decodeBindingDescs(
        { strings: ['count', 'count'], code: new Uint16Array([8, 1, 0, 0, 1]) },
        [], []
    );
    applyDescsToTree(root, descs, parent.proxy);
    check('.share populates _syncProps', el._syncProps && el._syncProps.count === 'count');
    check('prop pushed to mounted child at bind', child.proxy.count === 1);

    // Settle the initial push before wiring the emitter — in the real
    // lifecycle the child's emit binding is registered at ITS mount, where
    // initial props are injected via _props without recording changes, so
    // no initial-push echo exists.
    flushSync();

    // Child side: replicate DzComponent mount step 2.5 — the sync-emit
    // binding it registers for every key in _syncProps.
    for (const propName of Object.keys(el._syncProps)) {
        addBinding(child.proxy, propName, el, {
            type: 'prop-sync-emit',
            propName,
            applyFn: (value, b) => {
                if (b.node._propUpdating) return;
                b.node.dispatchEvent(new window.CustomEvent('dz:prop-sync', {
                    detail: { prop: b.propName, value }, bubbles: false, composed: false
                }));
            }
        });
    }

    parent.proxy.count = 7;
    flushSync();
    check('.share parent → child primitive stays live', child.proxy.count === 7);

    child.proxy.count = 99;
    flushSync();
    flushSync(); // settle the echo round-trip (event → parent set → push back down)
    check('.share child → parent primitive flows up', parent.proxy.count === 99);
    check('.share bridge settles without oscillation', child.proxy.count === 99 && parent.proxy.count === 99);
}

// ── Store-driven binding across components ──
{
    const reg = createModuleRegistry('domtest', { enableProxy: true });
    reg.register('cart', { total: 10 });
    const cart = reg.getSync('cart');

    // Component A renders the store value
    const a = createReactivity({ data: { cart } });
    const root = document.createElement('div');
    root.innerHTML = '<span>​</span>';
    document.body.appendChild(root);

    // TEXT_EVAL: [type=2, pathLen=1, path 0, evalIdx=0, depsLen=1, depIdx=0]
    const descs = decodeBindingDescs(
        { strings: ['cart'], code: new Uint16Array([2, 1, 0, 0, 1, 0]) },
        [function () { return this.cart.total; }], []
    );
    applyDescsToTree(root, descs, a.proxy);
    check('store binding initial render', root.querySelector('span').textContent === '10');

    // Component B (any other code) mutates the store
    const b = createReactivity({ data: { cart } });
    b.proxy.cart.total = 42;
    flushSync();
    check('store change re-renders other component’s binding', root.querySelector('span').textContent === '42');
}

if (failures > 0) {
    console.error(`\n${failures} DOM check(s) failed`);
    process.exit(1);
}
console.log('\nAll runtime DOM checks passed');
