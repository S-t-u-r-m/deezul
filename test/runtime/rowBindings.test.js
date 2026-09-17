/**
 * rowBindings.test.js — bindings that read a :for row's item must stay live:
 *
 *   A. a dotted :bind directly in a row (`<input :bind="row.name">`) renders, writes into
 *      the row's item, repaints on an in-place mutation, and after a keyed refetch shows
 *      and writes the NEW item — including a deeper target (`row.address.city`);
 *   B. text and attribute bindings inside an :if branch within a row repaint when the
 *      row's item is mutated in place — before and after the branch toggles, and after a
 *      keyed refetch (following the new item, no longer the old one);
 *   C. a branch inside a nested :for reads both iterators and follows both;
 *   D. a dotted :bind inside an :if branch within a row repaints in place and, after a
 *      keyed refetch, writes into the new item.
 *
 * Regression guards:
 *   - the compiler emitted a dotted :bind accessor in a row as `function() { return row; }`
 *     with `row` unbound (ReferenceError at render); row evals take the loop variables as
 *     parameters, and the accessor now does too;
 *   - bindings inside an :if branch subscribed to the scope's `row` key, which fires only
 *     when the whole item is replaced, never on `row.label = 'x'`.
 *
 * Uses the real compiler and the render primitives, as keyedRebind.test.js does.
 */

import { Window } from 'happy-dom';
import { writeFileSync, rmSync, mkdtempSync } from 'fs';
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
const { renderForLoop } = await import('../../src/runtime/render.js');
const { compileComponentToCode } = await import('../../src/compiler/library/main.js');

let failures = 0;
function check(name, cond) {
    if (cond) console.log(`  ok    ${name}`);
    else { failures++; console.error(`  FAIL  ${name}`); }
}

const tmp = mkdtempSync(join(tmpdir(), 'deezul-row-bindings-'));
let compiled = 0;
async function compileFor(template) {
    const src = `export default Deezul.Component({ template: \`${template}\`, data: () => ({}) });`;
    const file = join(tmp, `c${compiled++}.mjs`);
    writeFileSync(file, compileComponentToCode(src, { componentName: 'RowBindings' }));
    const mod = await import(pathToFileURL(file).href);
    const def = mod.default.dynamics.find((d) => d.type === 'for');
    return { ...def, instances: [] };
}

function mount(structure, data, key) {
    const { proxy } = createReactivity({ data, methods: {} });
    const container = document.createElement('div');
    const anchor = document.createComment('for');
    container.appendChild(anchor);
    document.body.appendChild(container);
    renderForLoop(structure, proxy[key], proxy, anchor);
    return { proxy, container };
}

function type(input, value) {
    input.value = value;
    input.dispatchEvent(new window.Event('input'));
    flushSync();
}

try {
    // ── A: dotted :bind directly in a row ──
    {
        const structure = await compileFor('<ul><li :for="row in rows" :key="row.id"><input class="name" :bind="row.name"><input class="city" :bind="row.address.city"></li></ul>');
        let mounted = null;
        try {
            mounted = mount(structure, { rows: [
                { id: 1, name: 'a', address: { city: 'Riverton' } },
                { id: 2, name: 'b', address: { city: 'Granville' } }
            ] }, 'rows');
        } catch (e) {
            check('A: renders (threw: ' + e.message + ')', false);
        }
        if (mounted) {
            const { proxy, container } = mounted;
            const values = (cls) => [...container.querySelectorAll('input.' + cls)].map((i) => i.value).join(',');
            check('A: renders the items\' values', values('name') === 'a,b' && values('city') === 'Riverton,Granville');

            type(container.querySelector('input.name'), 'typed');
            check('A: typing writes into the row item', proxy.rows[0].name === 'typed');
            type(container.querySelector('input.city'), 'Newark');
            check('A: a deeper target writes into the nested object', proxy.rows[0].address.city === 'Newark');

            proxy.rows[1].name = 'B';
            proxy.rows[1].address.city = 'Dover';
            flushSync();
            check('A: an in-place mutation repaints the input', values('name') === 'typed,B' && values('city') === 'Newark,Dover');

            const oldFirst = proxy.rows[0];
            const input0 = container.querySelector('input.name');
            proxy.rows = [
                { id: 1, name: 'fresh', address: { city: 'Hebron' } },
                { id: 2, name: 'B', address: { city: 'Dover' } }
            ];
            flushSync();
            check('A: keyed refetch reuses the row and shows the new item', container.querySelector('input.name') === input0 && values('name') === 'fresh,B' && values('city') === 'Hebron,Dover');

            type(input0, 'after');
            type(container.querySelector('input.city'), 'Utica');
            check('A: after the refetch, typing writes into the NEW item', proxy.rows[0].name === 'after' && proxy.rows[0].address.city === 'Utica');
            check('A: ...and not into the old one', oldFirst.name === 'typed' && oldFirst.address.city === 'Newark');

            proxy.rows[0].name = 'again';
            flushSync();
            check('A: an in-place mutation of the new item repaints', values('name') === 'again,B');
            oldFirst.name = 'stale';
            flushSync();
            check('A: mutating the old item no longer repaints', values('name') === 'again,B');
        }
    }

    // ── B: text and attribute bindings inside an :if in a row ──
    {
        const structure = await compileFor('<ul><li :for="row in rows" :key="row.id"><b :if="row.on" :title="row.label + \'!\'">{{ row.label }}</b></li></ul>');
        const { proxy, container } = mount(structure, { rows: [{ id: 1, on: true, label: 'one' }, { id: 2, on: true, label: 'two' }] }, 'rows');
        const out = () => [...container.querySelectorAll('li')].map((li) => { const b = li.querySelector('b'); return b ? b.textContent + '|' + b.getAttribute('title') : '-'; }).join(',');
        check('B: initial render', out() === 'one|one!,two|two!');

        proxy.rows[0].label = 'ONE';
        flushSync();
        check('B: in-place mutation repaints text and attribute', out() === 'ONE|ONE!,two|two!');

        proxy.rows[0].on = false;
        flushSync();
        proxy.rows[0].on = true;
        flushSync();
        proxy.rows[0].label = 'uno';
        flushSync();
        check('B: still live after the branch closes and reopens', out() === 'uno|uno!,two|two!');

        const oldSecond = proxy.rows[1];
        proxy.rows = [{ id: 1, on: true, label: 'uno' }, { id: 2, on: true, label: 'dos' }];
        flushSync();
        check('B: keyed refetch shows the new item', out() === 'uno|uno!,dos|dos!');
        proxy.rows[1].label = 'DOS';
        flushSync();
        check('B: after the refetch, mutating the NEW item repaints', out() === 'uno|uno!,DOS|DOS!');
        oldSecond.label = 'stale';
        flushSync();
        check('B: ...and mutating the old item does not', out() === 'uno|uno!,DOS|DOS!');
    }

    // ── C: a branch inside a nested :for reads both iterators ──
    {
        const structure = await compileFor('<ul><li :for="sec in secs" :key="sec.id"><i :for="chip in sec.chips" :key="chip.id"><b :if="chip.on">{{ sec.title }}:{{ chip.label }}</b></i></li></ul>');
        const { proxy, container } = mount(structure, { secs: [{ id: 'S', title: 'Roads', chips: [{ id: 'a', on: true, label: 'Paving' }] }] }, 'secs');
        const out = () => [...container.querySelectorAll('b')].map((b) => b.textContent).join(',');
        check('C: initial render', out() === 'Roads:Paving');
        proxy.secs[0].chips[0].label = 'Striping';
        flushSync();
        check('C: mutating the inner item repaints the branch', out() === 'Roads:Striping');
        proxy.secs[0].title = 'Streets';
        flushSync();
        check('C: mutating the OUTER item repaints the branch', out() === 'Streets:Striping');
    }

    // ── D: dotted :bind inside an :if in a row ──
    {
        const structure = await compileFor('<ul><li :for="row in rows" :key="row.id"><p :if="row.on"><input :bind="row.name"></p></li></ul>');
        const { proxy, container } = mount(structure, { rows: [{ id: 1, on: true, name: 'a' }] }, 'rows');
        const input = () => container.querySelector('input');
        check('D: initial render', input() && input().value === 'a');

        proxy.rows[0].name = 'A';
        flushSync();
        check('D: in-place mutation repaints the input', input().value === 'A');

        const old = proxy.rows[0];
        const input0 = input();
        proxy.rows = [{ id: 1, on: true, name: 'new' }];
        flushSync();
        check('D: keyed refetch keeps the input and shows the new item', input() === input0 && input0.value === 'new');
        type(input0, 'typed');
        check('D: after the refetch, typing writes into the NEW item', proxy.rows[0].name === 'typed' && old.name === 'A');
        proxy.rows[0].name = 'again';
        flushSync();
        check('D: mutating the new item repaints', input0.value === 'again');
    }
} finally {
    await window.happyDOM.abort();
    rmSync(tmp, { recursive: true, force: true });
}

if (failures > 0) {
    console.error(`\n${failures} row binding check(s) failed`);
    process.exit(1);
}
console.log('\nAll row binding checks passed');
process.exit(0);
