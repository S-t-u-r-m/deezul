/**
 * forGatedByIf.test.js — :if and :for on the SAME element, where the condition is
 * decidable outside the loop, means "render this loop only when the condition holds".
 * The compiler lets that through (see test/compiler/forIfGuard.test.js); this checks it
 * actually RENDERS: the conditional owns the node and the loop is a dynamic nested in
 * its branch, so
 *
 *   <li :for="x in items" :if="show">   →   <!--if-->  branch: <li :for>…</li>
 *
 * must produce no rows at all when false, every row when true, an :else sibling in the
 * false case, and must follow both the flag and the array afterwards.
 *
 * Uses the real compiler and the render primitives, as rowBindings.test.js does.
 */

import { Window } from 'happy-dom';
import { writeFileSync, mkdtempSync } from 'fs';
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
const { renderConditional, updateConditional } = await import('../../src/runtime/render.js');
const { addDynamicStructure } = await import('../../src/runtime/Reactivity.js');
const { compileComponentToCode } = await import('../../src/compiler/library/main.js');

let failures = 0;
function check(name, cond, extra) {
    if (cond) console.log(`  ok    ${name}`);
    else { failures++; console.error(`  FAIL  ${name}${extra !== undefined ? '   [' + extra + ']' : ''}`); }
}

const tmp = mkdtempSync(join(tmpdir(), 'deezul-for-gated-'));
let compiled = 0;

async function compileConditional(template, data) {
    const src = `export default Deezul.Component({ template: \`${template}\`, data: () => (${data}) });`;
    const file = join(tmp, `c${compiled++}.mjs`);
    writeFileSync(file, compileComponentToCode(src, { componentName: 'ForGated' }));
    const mod = await import(pathToFileURL(file).href);
    return mod.default.dynamics.find((d) => d.type === 'if');
}

function mount(structure, data) {
    const { proxy } = createReactivity({ data, methods: {} });
    const container = document.createElement('div');
    const anchor = document.createComment('if');
    container.appendChild(anchor);
    document.body.appendChild(container);
    const live = { ...structure, activeInstance: null, activeBranchIndex: -1, parentProxy: proxy };
    live.updateFn = () => updateConditional(live, proxy);
    renderConditional(live, proxy, anchor);
    for (const dep of live.deps || []) addDynamicStructure(proxy, dep, live);
    return { proxy, container };
}

const ROWS = '{ show: true, items: [{ n: "a" }, { n: "b" }, { n: "c" }] }';

try {
    // ── The loop is nested inside the branch, not beside it ──
    {
        const structure = await compileConditional('<ul><li :for="x in items" :if="show">{{ x.n }}</li></ul>', ROWS);
        check('the conditional owns the node', !!structure, 'no if dynamic was emitted');
        const nested = structure && structure.chain[0] && (structure.chain[0].dynamics || []);
        check('...and the loop is compiled inside its branch',
              nested.length === 1 && nested[0].type === 'for',
              nested.map((d) => d.type).join(',') || 'none');
    }

    // ── True: every row. False: nothing at all. ──
    {
        const structure = await compileConditional('<ul><li :for="x in items" :if="show">{{ x.n }}</li></ul>', ROWS);
        const { proxy, container } = mount(structure, { show: true, items: [{ n: 'a' }, { n: 'b' }, { n: 'c' }] });
        const rows = () => [...container.querySelectorAll('li')].map((li) => li.textContent.trim()).join(',');
        check('renders every row while the condition holds', rows() === 'a,b,c', rows());

        proxy.show = false;
        flushSync();
        check('...and no rows at all once it does not', rows() === '', rows());

        proxy.show = true;
        flushSync();
        check('...and they come back', rows() === 'a,b,c', rows());

        proxy.items.push({ n: 'd' });
        flushSync();
        check('...with the loop still following the array', rows() === 'a,b,c,d', rows());
    }

    // ── Starting false, so the loop has never rendered ──
    {
        const structure = await compileConditional('<ul><li :for="x in items" :if="show">{{ x.n }}</li></ul>', ROWS);
        const { proxy, container } = mount(structure, { show: false, items: [{ n: 'a' }, { n: 'b' }] });
        check('a loop gated false from the start renders nothing', !container.querySelector('li'));
        proxy.show = true;
        flushSync();
        check('...and renders in full the first time it is let through',
              [...container.querySelectorAll('li')].map((li) => li.textContent.trim()).join(',') === 'a,b');
    }

    // ── An :else sibling takes over when the loop is gated out ──
    {
        const structure = await compileConditional(
            '<ul><li :for="x in items" :if="show">{{ x.n }}</li><li :else class="none">Nothing to show</li></ul>', ROWS);
        const { proxy, container } = mount(structure, { show: true, items: [{ n: 'a' }] });
        check('with the gate open the rows show and the :else does not',
              !!container.querySelector('li') && !container.querySelector('li.none'));
        proxy.show = false;
        flushSync();
        check('...and closing it swaps the whole loop for the :else',
              !!container.querySelector('li.none') && container.querySelectorAll('li').length === 1,
              container.innerHTML);
    }
} finally {
    if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
    else console.log('\nall :for-gated-by-:if checks passed');
}
