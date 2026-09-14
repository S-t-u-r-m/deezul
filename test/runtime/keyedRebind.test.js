/**
 * keyedRebind.test.js — a keyed :for row reused for a NEW item object (a refetch, or a
 * computed that rebuilds its rows) must follow that object everywhere, not just in the
 * row's own top-level bindings:
 *
 *   A. row bindings' item-property subscriptions move to the new item, so an in-place
 *      mutation after the refetch still repaints the row;
 *   B. a nested :if re-evaluates against the new item, keeps its branch DOM when the
 *      branch doesn't change (so focus/input state survives), re-applies the branch's
 *      bindings, hands branch events the new item, and keeps reacting to in-place
 *      condition changes;
 *   C. a nested :for follows the new item's collection (including later pushes to it),
 *      and inner rows that read the enclosing item re-subscribe to the new one;
 *   D. a branch that itself holds nested dynamics still renders the new item's values;
 *   E. behaviour without a refetch is unchanged.
 *
 * Regression guard: forLoopReconcile's keyed path called updateInstanceBindings, which
 * re-applied only instance.bindings — nested :if/:for structures kept an iteration scope
 * closed over the FIRST item, and every subscription stayed on that stale object.
 *
 * Uses the real compiler for templates with nested dynamics, driving the render
 * primitives directly (the same call shapes DzComponent uses).
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

const tmp = mkdtempSync(join(tmpdir(), 'deezul-keyed-rebind-'));
let compiled = 0;
async function compileFor(template) {
    const src = `export default Deezul.Component({ template: \`${template}\`, data: () => ({}) });`;
    const file = join(tmp, `c${compiled++}.mjs`);
    writeFileSync(file, compileComponentToCode(src, { componentName: 'KeyedRebind' }));
    const mod = await import(pathToFileURL(file).href);
    const def = mod.default.dynamics.find((d) => d.type === 'for');
    return { ...def, instances: [] };
}

function mount(structure, data, key, methods) {
    const { proxy } = createReactivity({ data, methods });
    const container = document.createElement('div');
    const anchor = document.createComment('for');
    container.appendChild(anchor);
    document.body.appendChild(container);
    renderForLoop(structure, proxy[key], proxy, anchor);
    return { proxy, container };
}

try {
    // ── A: row-level item-property subscription follows the new item ──
    {
        const structure = {
            template: '<li><span>x</span></li>',
            // TEXT_EVAL: [type=2, pathLen=2, path 0,0, evalIdx=0, depsLen=1, depIdx=0]
            binding: { strings: ['item.label'], code: new Uint16Array([2, 2, 0, 0, 0, 1, 0]) },
            eval: [function (item) { return item.label; }],
            event: [], iterator: 'item', dynamics: [],
            keyFn: (item) => item.id
        };
        const { proxy, container } = mount(structure, { items: [{ id: 1, label: 'one' }, { id: 2, label: 'two' }] }, 'items');
        const texts = () => [...container.querySelectorAll('li')].map((li) => li.textContent).join(',');

        const li0 = container.querySelector('li');
        proxy.items = [{ id: 1, label: 'uno' }, { id: 2, label: 'dos' }];
        flushSync();
        check('A: keyed refetch reuses the row and repaints', container.querySelector('li') === li0 && texts() === 'uno,dos');

        proxy.items[0].label = 'UNO';
        flushSync();
        check('A: in-place mutation AFTER the refetch repaints', texts() === 'UNO,dos');
    }

    // ── B: nested :if inside a keyed row ──
    {
        const picked = [];
        const structure = await compileFor('<ul><li :for="row in rows" :key="row.id"><b :if="row.on" @click="pick(row)">{{ row.label }}</b></li></ul>');
        const { proxy, container } = mount(structure,
            { rows: [{ id: 1, on: true, label: 'one' }, { id: 2, on: false, label: 'two' }] }, 'rows',
            { pick(row) { picked.push(row.label); } });
        const bold = () => [...container.querySelectorAll('li')].map((li) => { const b = li.querySelector('b'); return b ? b.textContent : '-'; }).join(',');
        check('B: initial render', bold() === 'one,-');

        const li0 = container.querySelector('li');
        const b0 = li0.querySelector('b');
        proxy.rows = [{ id: 1, on: true, label: 'uno' }, { id: 2, on: false, label: 'dos' }];
        flushSync();
        check('B: refetch reuses the row', container.querySelector('li') === li0);
        check('B: nested branch shows the NEW item', bold() === 'uno,-');
        check('B: unchanged branch keeps its DOM node (focus/input state survives)', li0.querySelector('b') === b0);

        li0.querySelector('b').click();
        check('B: branch event receives the NEW item', picked.length === 1 && picked[0] === 'uno');

        proxy.rows = [{ id: 1, on: false, label: 'uno' }, { id: 2, on: true, label: 'dos' }];
        flushSync();
        check('B: refetch with flipped conditions switches branches', bold() === '-,dos');

        proxy.rows[0].on = true;
        flushSync();
        check('B: in-place condition change AFTER the refetch toggles the branch', bold() === 'uno,dos');
    }

    // ── C: nested :for inside a keyed row ──
    {
        const structure = await compileFor('<ul><li :for="sec in secs" :key="sec.id"><i :for="chip in sec.chips" :key="chip.id" :class="sec.sel === chip.id ? \'on\' : \'\'">{{ chip.id }}</i></li></ul>');
        const { proxy, container } = mount(structure,
            { secs: [{ id: 'S', sel: 'a', chips: [{ id: 'a' }, { id: 'b' }] }] }, 'secs');
        const chips = () => [...container.querySelectorAll('i')].map((i) => i.textContent + (i.className === 'on' ? '*' : '')).join(',');
        check('C: initial render', chips() === 'a*,b');

        const oldChips = proxy.secs[0].chips;
        const li0 = container.querySelector('li');
        proxy.secs = [{ id: 'S', sel: 'c', chips: [{ id: 'a' }, { id: 'c' }] }];
        flushSync();
        check('C: refetch reuses the outer row', container.querySelector('li') === li0);
        check('C: inner rows follow the new collection and the new enclosing item', chips() === 'a,c*');

        proxy.secs[0].chips.push({ id: 'd' });
        flushSync();
        check('C: a push to the NEW collection renders', chips() === 'a,c*,d');

        oldChips.push({ id: 'zz' });
        flushSync();
        check('C: a push to the OLD collection no longer renders', chips() === 'a,c*,d');

        proxy.secs[0].sel = 'a';
        flushSync();
        check('C: in-place change to the NEW enclosing item re-highlights inner rows', chips() === 'a*,c,d');
    }

    // ── D: branch that itself holds a nested dynamic ──
    {
        const structure = await compileFor('<ul><li :for="row in rows" :key="row.id"><p :if="row.on"><b :if="row.hot">{{ row.label }}</b></p></li></ul>');
        const { proxy, container } = mount(structure, { rows: [{ id: 1, on: true, hot: true, label: 'one' }] }, 'rows');
        const out = () => { const b = container.querySelector('b'); return container.querySelector('p') ? (b ? b.textContent : 'p') : '-'; };
        check('D: initial render', out() === 'one');

        proxy.rows = [{ id: 1, on: true, hot: true, label: 'uno' }];
        flushSync();
        check('D: nested-in-branch dynamic shows the new item', out() === 'uno');

        proxy.rows = [{ id: 1, on: true, hot: false, label: 'uno' }];
        flushSync();
        check('D: nested-in-branch condition follows the new item', out() === 'p');
    }

    // ── E: no refetch — in-place condition changes still work ──
    {
        const structure = await compileFor('<ul><li :for="row in rows" :key="row.id"><b :if="row.on">{{ row.label }}</b></li></ul>');
        const { proxy, container } = mount(structure, { rows: [{ id: 1, on: false, label: 'one' }] }, 'rows');
        const bold = () => { const b = container.querySelector('b'); return b ? b.textContent : '-'; };
        check('E: initial render', bold() === '-');
        proxy.rows[0].on = true;
        flushSync();
        check('E: in-place condition change toggles the branch', bold() === 'one');
    }
} finally {
    await window.happyDOM.abort();
    rmSync(tmp, { recursive: true, force: true });
}

if (failures > 0) {
    console.error(`\n${failures} keyed rebind check(s) failed`);
    process.exit(1);
}
console.log('\nAll keyed rebind checks passed');
process.exit(0);
