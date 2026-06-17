/**
 * runtime-smoke.mjs — DOM-free smoke test for the reactivity data layer.
 * Run directly: node test/runtime-smoke.mjs
 * (Not part of test/run.js — exercises the proxy/computed/watcher core
 * without a browser; render.js/DzComponent.js require a real DOM.)
 */

import createReactivity, { batch } from '../../src/runtime/Reactivity.js';
import { flushSync } from '../../src/runtime/DataProxy.js';
// Register renderUpdates with Reactivity (no DOM access at import time) —
// applyMutation no-ops without it, exactly as in the browser before render.js loads.
import '../../src/runtime/render.js';

let failures = 0;
function check(name, cond) {
    if (cond) console.log(`  ok    ${name}`);
    else { failures++; console.error(`  FAIL  ${name}`); }
}

// ── Computed + watcher basics ──
{
    const calls = [];
    const { proxy } = createReactivity({
        data: { firstName: 'John', lastName: 'Doe', user: { name: 'Nested' }, items: [1, 2, 3] },
        computed: {
            fullName() { return this.firstName + ' ' + this.lastName; },
            greeting() { return 'Hi ' + this.fullName; },
            count() { return this.items.length; }
        },
        watch: {
            name(newVal, oldVal) { calls.push(['name', newVal, oldVal]); },
            firstName(newVal) { calls.push(['firstName', newVal]); }
        }
    });

    check('computed evaluates', proxy.fullName === 'John Doe');
    check('computed chains', proxy.greeting === 'Hi John Doe');
    check('computed over array length', proxy.count === 3);

    proxy.firstName = 'Jane';
    flushSync();
    check('computed invalidates on change', proxy.fullName === 'Jane Doe');
    check('watcher fired for top-level key', calls.some(c => c[0] === 'firstName' && c[1] === 'Jane'));

    // The regression this guards: a watcher on root-level `name` must NOT
    // fire when a nested target's same-named key changes.
    calls.length = 0;
    proxy.user.name = 'Changed';
    flushSync();
    check('nested same-named key does not fire root watcher', !calls.some(c => c[0] === 'name'));
    check('nested write landed', proxy.user.name === 'Changed');

    // Mutation → computed invalidation via the (deduplicated) parent walk
    proxy.items.push(4);
    proxy.items.push(5);
    flushSync();
    check('computed sees batched mutations after flush', proxy.count === 5);
}

// ── Method identity + batch ──
{
    const { proxy } = createReactivity({
        data: { n: 0 },
        methods: {
            inc() { this.n++; },
            get() { return this.n; }
        }
    });
    check('bound method identity is stable', proxy.inc === proxy.inc);
    batch(() => { proxy.inc(); proxy.inc(); });
    check('methods mutate through proxy', proxy.get() === 2);
}

// ── Map/Set handler caching still works through the proxy ──
{
    const { proxy } = createReactivity({
        data: { m: new Map([['a', 1]]), s: new Set([1, 2]) },
        computed: { mSize() { return this.m.size; } }
    });
    proxy.m.set('b', 2);
    proxy.s.add(3);
    flushSync();
    check('Map.set through proxy', proxy.m.get('b') === 2 && proxy.m.size === 2);
    check('Set.add through proxy', proxy.s.has(3));
    check('computed over Map size invalidated by mutation', proxy.mSize === 2);
}

// ── deepClone cycle safety ──
{
    const { deepClone } = await import('../../src/runtime/helpers.js');
    const a = { name: 'a' };
    a.self = a;
    const clone = deepClone(a);
    check('deepClone handles cycles', clone.self === clone && clone !== a);
}

// ── getCopy / cloneStore no longer crashes ──
{
    const { createModuleRegistry } = await import('../../src/runtime/ModuleRegistry.js');
    const reg = createModuleRegistry('smoke', { enableProxy: true });
    reg.register('store', { count: 1, nested: { x: 2 } });
    const copy = await reg.getCopy('store');
    check('getCopy returns a working proxy', copy.count === 1 && copy.nested.x === 2);
    copy.count = 99;
    const original = reg.getSync('store');
    check('getCopy is isolated from original', original.count === 1 && copy.count === 99);
}

// ── Reactive stores: cross-component visibility ──
{
    const { createModuleRegistry } = await import('../../src/runtime/ModuleRegistry.js');
    const reg = createModuleRegistry('smoke2', { enableProxy: true });
    reg.register('cart', { total: 10, items: [1, 2] });
    const cart = reg.getSync('cart');

    // Two independent "components" share the store via their data
    const a = createReactivity({
        data: { cart },
        computed: { totalA() { return this.cart.total; } }
    });
    const b = createReactivity({
        data: { cart },
        computed: { totalB() { return this.cart.total * 2; } }
    });

    check('both components read shared store', a.proxy.totalA === 10 && b.proxy.totalB === 20);

    // Mutate through the store proxy directly (as a third party would)
    cart.total = 50;
    flushSync();
    check('computed in component A invalidated by store change', a.proxy.totalA === 50);
    check('computed in component B invalidated by store change', b.proxy.totalB === 100);

    // watch() fires through the flush
    const watched = [];
    reg.watch('cart', 'total', (v, old) => watched.push([v, old]));
    cart.total = 75;
    flushSync();
    check('store watch() fires on top-level change', watched.length === 1 && watched[0][0] === 75);

    // Collection mutation invalidates dependent computed via ancestor walk
    const c = createReactivity({
        data: { cart },
        computed: { count() { return this.cart.items.length; } }
    });
    check('computed over store collection', c.proxy.count === 2);
    cart.items.push(3);
    flushSync();
    check('store collection mutation invalidates computed', c.proxy.count === 3);
}

// ── Computed setters ──
{
    const { proxy } = createReactivity({
        data: { first: 'John', last: 'Doe' },
        computed: {
            fullName: {
                get() { return this.first + ' ' + this.last; },
                set(v) {
                    const parts = v.split(' ');
                    this.first = parts[0];
                    this.last = parts[1] || '';
                }
            }
        }
    });
    check('computed getter via object form', proxy.fullName === 'John Doe');
    proxy.fullName = 'Jane Smith';
    flushSync();
    check('computed setter writes through to data', proxy.first === 'Jane' && proxy.last === 'Smith');
    check('computed re-derives after setter', proxy.fullName === 'Jane Smith');
}

// ── nextTick resolves after the flush ──
{
    const { nextTick } = await import('../../src/runtime/DataProxy.js');
    const { proxy } = createReactivity({
        data: { n: 1 },
        computed: { double() { return this.n * 2; } }
    });
    void proxy.double; // prime cache
    proxy.n = 5;
    await nextTick();
    check('nextTick resolves after pending flush applied', proxy.double === 10);
    await nextTick(); // no pending flush — resolves on a microtask
    check('nextTick resolves with nothing pending', true);
}

// ── markRaw opts objects out of wrapping ──
{
    const { markRaw, toRaw, IS_PROXY } = await import('../../src/runtime/DataProxy.js');
    const big = markRaw({ rows: [1, 2, 3] });
    const { proxy } = createReactivity({ data: { big } });
    check('markRaw value returned unwrapped', proxy.big === big && !proxy.big[IS_PROXY]);
    check('toRaw unwraps proxies', toRaw(proxy) !== proxy && toRaw(big) === big);
}

// ── Deep change bubbling: ancestor change listeners fire ──
{
    const { proxy, dataProxy } = createReactivity({
        data: { user: { profile: { name: 'Ann' } } }
    });
    const { addChangeListener } = await import('../../src/runtime/Reactivity.js');
    const seen = [];
    addChangeListener(dataProxy, (key) => seen.push(key));
    proxy.user.profile.name = 'Bea';
    flushSync();
    check('deep change bubbles to root listeners', seen.includes('user'));
    check('deep write landed', proxy.user.profile.name === 'Bea');
}

if (failures > 0) {
    console.error(`\n${failures} smoke check(s) failed`);
    process.exit(1);
}
console.log('\nAll runtime smoke checks passed');
