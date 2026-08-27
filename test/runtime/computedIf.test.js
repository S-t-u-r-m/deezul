/**
 * computedIf.test.js — a top-level `:if="someComputed"` must reactively
 * re-render when the computed's underlying data changes AFTER mount, not
 * just reflect whatever it evaluated to at initial render.
 *
 * Regression guard: DzComponent.processDynamics built `dataKeySet` from
 * `Object.keys(this.component.data)` only, then skipped registering a `:if`
 * dependency with addDynamicStructure unless it was a member of that set.
 * A dependency that's a COMPUTED property name (e.g. `:if="hasSelectedEntity"`
 * where `hasSelectedEntity(){ return !!this.selectedEntityId }`) is never a
 * data key, so it silently never got registered at all — the block rendered
 * correctly once at mount and then never updated again, no matter how many
 * times its computed's value actually changed. `:for`'s equivalent
 * registration has no such filter, and this exact case round-trips fine when
 * the low-level render primitives are driven directly (see dom.test.js's
 * ":if — toggling" case, which uses a plain data dep) — the gap was specific
 * to DzComponent's top-level `:if` wiring for computed deps.
 *
 * Goes through the real compiler + <dz-component> custom-element mount
 * (not the low-level render.js primitives other :if tests use) since the
 * bug lived in DzComponent.processDynamics itself.
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
function check(name, cond) {
    if (cond) console.log(`  ok    ${name}`);
    else { failures++; console.error(`  FAIL  ${name}`); }
}

const source = `
export default Deezul.Component({
    template: \`
        <div>
            <div :if="hasSelectedEntity" id="gated">shown</div>
        </div>
    \`,
    data: () => ({
        selectedEntityId: null
    }),
    computed: {
        hasSelectedEntity() {
            return !!this.selectedEntityId;
        }
    }
});
`;

const code = compileComponentToCode(source, { componentName: 'ComputedIfTestComp' });
const tmpFile = join(tmpdir(), `deezul-computed-if-test-${process.pid}.mjs`);
await writeFile(tmpFile, code);
const moduleObj = await import(pathToFileURL(tmpFile).href);
await rm(tmpFile, { force: true });

const root = document.createElement('div');
root.id = 'app';
document.body.appendChild(root);

Deezul.init({
    rootElement: 'app',
    component: 'computed-if-test-comp',
    modules: [
        { ref: 'computed-if-test-comp', data: moduleObj.default }
    ]
});

await new Promise(r => setTimeout(r, 20));

function gatedPresent() {
    const dz = document.querySelector('dz-component[dz-type="computed-if-test-comp"]');
    return !!dz?.shadowRoot?.querySelector('#gated');
}

check(':if="computed" hidden at mount when computed is false', !gatedPresent());

const dz = document.querySelector('dz-component[dz-type="computed-if-test-comp"]');
dz.component.proxy.selectedEntityId = 5;
await new Promise(r => setTimeout(r, 20));

check(':if="computed" appears once its dependency changes post-mount', gatedPresent());

dz.component.proxy.selectedEntityId = null;
await new Promise(r => setTimeout(r, 20));

check(':if="computed" disappears again when the dependency reverts', !gatedPresent());

if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
}
console.log('\nAll computedIf checks passed');
