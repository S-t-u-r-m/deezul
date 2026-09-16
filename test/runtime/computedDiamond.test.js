/**
 * computedDiamond.test.js — a computed that reads another computed both directly and through
 * a chain must see the chain's NEW value after a change, and must not be left stale.
 *
 * Regression guard: ComputedManager.invalidate re-evaluated dependents eagerly, in the order
 * it discovered them, and never processed one twice. With
 *
 *     list → pageCount → current → pageItems      and      list → pageItems
 *
 * a change to `list` queued pageCount and pageItems. pageItems ran before `current` had been
 * re-evaluated, so it sliced the new list with the OLD page (an empty page). When `current`
 * then changed, pageItems was already marked processed and was skipped, so it stayed empty
 * until something else touched it. Seen in DeezulComponents' document list: a search from
 * page 2 showed "No documents" while the count said 5 matched.
 *
 * Also guards what the fix must keep: a computed whose inputs did not change value is not
 * re-evaluated, and a watcher fires once with the final value (no intermediate glitch).
 */
import { Window } from 'happy-dom';

const window = new Window();
globalThis.window = window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.ShadowRoot = window.ShadowRoot;
globalThis.CustomEvent = window.CustomEvent;
globalThis.Event = window.Event;
globalThis.customElements = window.customElements;
globalThis.MutationObserver = window.MutationObserver;
globalThis.Node = window.Node;
globalThis.Text = window.Text;
globalThis.Comment = window.Comment;
globalThis.DocumentFragment = window.DocumentFragment;

import { writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { compileComponentToCode } = await import('../../src/compiler/library/main.js');
const Deezul = (await import('../../src/runtime/Deezul.js')).default;

let failures = 0;
function check(name, cond, detail) {
    if (cond) console.log(`  ok    ${name}`);
    else { failures++; console.error(`  FAIL  ${name}${detail === undefined ? '' : ' — got ' + JSON.stringify(detail)}`); }
}

globalThis.__diamond = { labelRuns: 0, watched: [] };

const source = `
export default Deezul.Component({
    template: \`
        <div>
            <p id="count">{{ pageCount }}</p>
            <span class="item" :for="item in pageItems" :key="item">{{ item }}</span>
            <p id="label">{{ label }}</p>
        </div>
    \`,
    data: () => ({
        n: 12,
        page: 2
    }),
    computed: {
        list() { return Array.from({ length: this.n }, (_, i) => i + 1); },
        pageCount() { return Math.max(1, Math.ceil(this.list.length / 5)); },
        current() { return Math.min(Math.max(1, this.page), this.pageCount); },
        pageItems() {
            const start = (this.current - 1) * 5;
            return this.list.slice(start, start + 5);
        },
        parity() { return this.n % 2; },
        label() { globalThis.__diamond.labelRuns++; return 'parity ' + this.parity; }
    },
    watch: {
        pageItems(value) { globalThis.__diamond.watched.push(value.join(',')); }
    }
});
`;

const code = compileComponentToCode(source, { componentName: 'ComputedDiamondTestComp' });
const tmpFile = join(tmpdir(), `deezul-computed-diamond-test-${process.pid}.mjs`);
await writeFile(tmpFile, code);
const moduleObj = await import(pathToFileURL(tmpFile).href);
await rm(tmpFile, { force: true });

const root = document.createElement('div');
root.id = 'app';
document.body.appendChild(root);

Deezul.init({
    rootElement: 'app',
    component: 'computed-diamond-test-comp',
    modules: [
        { ref: 'computed-diamond-test-comp', data: moduleObj.default }
    ]
});

const tick = () => new Promise(r => setTimeout(r, 20));
await tick();

const dz = document.querySelector('dz-component[dz-type="computed-diamond-test-comp"]');
const proxy = dz.component.proxy;
const shown = () => [...dz.shadowRoot.querySelectorAll('.item')].map(el => el.textContent.trim()).join(',');
const text = id => dz.shadowRoot.querySelector('#' + id).textContent.trim();

// Values start at 1: happy-dom renders textContent = 0 as an empty string (browsers show 0).
check('mounts on page 2', shown() === '6,7,8,9,10', shown());

// The bug: 12 → 3 items drops to one page; page 2 clamps to page 1.
globalThis.__diamond.watched.length = 0;
proxy.n = 3;
await tick();
check('pageItems reads the new current page (proxy)', proxy.pageItems.join(',') === '1,2,3', proxy.pageItems);
check('pageItems renders the new page', shown() === '1,2,3', shown());
check('pageCount renders', text('count') === '1', text('count'));
check('the watcher saw only the final value', JSON.stringify(globalThis.__diamond.watched) === '["1,2,3"]', globalThis.__diamond.watched);

// Back up: the page stays 2 in data, so page 2 comes back.
proxy.n = 12;
await tick();
check('growing again shows page 2', shown() === '6,7,8,9,10', shown());

// Cut-off: 12 → 14 keeps parity, so label must not run again.
const runs = globalThis.__diamond.labelRuns;
proxy.n = 14;
await tick();
check('an unchanged computed does not re-run its dependents', globalThis.__diamond.labelRuns === runs, globalThis.__diamond.labelRuns - runs);
check('its binding keeps the value', text('label') === 'parity 0', text('label'));
proxy.n = 13;
await tick();
check('a changed computed re-runs its dependents', text('label') === 'parity 1', text('label'));

// Two keys in one flush: the page and the list change together.
proxy.page = 3;
proxy.n = 6;
await tick();
check('two changes in one flush settle to the final page', shown() === '6' && text('count') === '2', [shown(), text('count')]);

if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
}
console.log('\nAll computedDiamond checks passed');
