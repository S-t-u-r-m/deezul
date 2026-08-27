/**
 * propEval.test.js — a component prop bound to a literal or a computed
 * expression (`:title="'Department'"`, `:count="n + 1"`) must actually reach
 * the child component's reactive data, and must stay reactive when the
 * expression's dependencies change.
 *
 * Regression guard: detector.js's (and its real, duplicated counterpart in
 * processor.js's optimized single-pass path) PROP-vs-ATTR classification only
 * produced a PROP binding when the bound value was a simple identifier/member
 * path (`:items="entities"`). A quoted string literal or any other expression
 * failed `isSimplePath`, so `isComponent && !isEval` was false and the
 * binding fell through to ATTR_EVAL — applied via `element.setAttribute`,
 * which is inert on a <dz-component> custom element and never reaches the
 * child's `data` at all. This silently broke every literal prop passed this
 * way across the whole framework (list titles, form field labels, anything
 * passed as `:prop="'literal'"` or a non-trivial expression).
 *
 * Fixed by adding a PROP_EVAL binding type: same shape as ATTR_EVAL (a
 * compiled eval function + tracked deps) but applied as a push into the
 * child's `component.proxy[propName]` instead of a DOM attribute — covering
 * both the top-level/`:if`-branch path (applyDescsToTree) and a component
 * nested inside a `:for` loop (subscribeForRowEval).
 */
import { Window } from 'happy-dom';
import { writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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

const { compileComponentToCode } = await import('../../src/compiler/library/main.js');
const Deezul = (await import('../../src/runtime/Deezul.js')).default;

let failures = 0;
function check(name, cond) {
    if (cond) console.log(`  ok    ${name}`);
    else { failures++; console.error(`  FAIL  ${name}`); }
}

async function loadModule(code, name) {
    const tmpFile = join(tmpdir(), `deezul-propeval-test-${name}-${process.pid}.mjs`);
    await writeFile(tmpFile, code);
    const mod = await import(pathToFileURL(tmpFile).href);
    await rm(tmpFile, { force: true });
    return mod.default;
}

// ── Top-level: literal + reactive expression prop ──
{
    const childSource = `
        export default Deezul.Component({
            template: \`<span id="t">{{ title }}</span>\`,
            data: () => ({ title: '' })
        });
    `;
    const parentSource = `
        export default Deezul.Component({
            template: \`<div><dz-component dz-type="pe-child" :title="'Department'" id="c"></dz-component></div>\`,
            data: () => ({ n: 0 })
        });
    `;
    const childDef = await loadModule(compileComponentToCode(childSource, { componentName: 'PeChild' }), 'child1');
    const parentDef = await loadModule(compileComponentToCode(parentSource, { componentName: 'PeParent' }), 'parent1');

    const root = document.createElement('div');
    root.id = 'app1';
    document.body.appendChild(root);
    Deezul.init({
        rootElement: 'app1',
        component: 'pe-parent',
        modules: [{ ref: 'pe-parent', data: parentDef }, { ref: 'pe-child', data: childDef }]
    });
    await new Promise(r => setTimeout(r, 30));

    const parentDz = document.querySelector('#app1 dz-component[dz-type="pe-parent"]');
    const childDz = parentDz?.shadowRoot?.querySelector('dz-component[dz-type="pe-child"]');
    check('literal prop reaches child data', childDz?.component?.proxy?.title === 'Department');
    check('literal prop renders in child template', childDz?.shadowRoot?.querySelector('#t')?.textContent === 'Department');
}

// ── Top-level: reactive expression prop re-evaluates on dependency change ──
{
    const childSource = `
        export default Deezul.Component({
            template: \`<span id="c">{{ count }}</span>\`,
            data: () => ({ count: 0 })
        });
    `;
    const parentSource = `
        export default Deezul.Component({
            template: \`<dz-component dz-type="pe-child2" :count="n + 1"></dz-component>\`,
            data: () => ({ n: 0 })
        });
    `;
    const childDef = await loadModule(compileComponentToCode(childSource, { componentName: 'PeChild2' }), 'child2');
    const parentDef = await loadModule(compileComponentToCode(parentSource, { componentName: 'PeParent2' }), 'parent2');

    const root = document.createElement('div');
    root.id = 'app2';
    document.body.appendChild(root);
    Deezul.init({
        rootElement: 'app2',
        component: 'pe-parent2',
        modules: [{ ref: 'pe-parent2', data: parentDef }, { ref: 'pe-child2', data: childDef }]
    });
    await new Promise(r => setTimeout(r, 30));

    const parentDz = document.querySelector('#app2 dz-component[dz-type="pe-parent2"]');
    check('initial expression prop value', parentDz?.shadowRoot?.querySelector('dz-component[dz-type="pe-child2"]')?.component?.proxy?.count === 1);

    parentDz.component.proxy.n = 10;
    await new Promise(r => setTimeout(r, 30));
    const childDz = parentDz?.shadowRoot?.querySelector('dz-component[dz-type="pe-child2"]');
    check('expression prop re-evaluates after dependency changes', childDz?.component?.proxy?.count === 11);
    check('re-evaluated prop renders', childDz?.shadowRoot?.querySelector('#c')?.textContent === '11');
}

// ── Component nested in :for: expression prop reads the row item ──
{
    const childSource = `
        export default Deezul.Component({
            template: \`<span class="label">{{ label }}</span>\`,
            data: () => ({ label: '' })
        });
    `;
    const parentSource = `
        export default Deezul.Component({
            template: \`
                <ul>
                    <li :for="row in rows">
                        <dz-component dz-type="pe-rowchild" :label="'Row: ' + row.name"></dz-component>
                    </li>
                </ul>
            \`,
            data: () => ({ rows: [{ name: 'A' }, { name: 'B' }] })
        });
    `;
    const childDef = await loadModule(compileComponentToCode(childSource, { componentName: 'PeRowChild' }), 'rowchild');
    const parentDef = await loadModule(compileComponentToCode(parentSource, { componentName: 'PeRowParent' }), 'rowparent');

    const root = document.createElement('div');
    root.id = 'app3';
    document.body.appendChild(root);
    Deezul.init({
        rootElement: 'app3',
        component: 'pe-rowparent',
        modules: [{ ref: 'pe-rowparent', data: parentDef }, { ref: 'pe-rowchild', data: childDef }]
    });
    await new Promise(r => setTimeout(r, 30));

    const parentDz = document.querySelector('#app3 dz-component[dz-type="pe-rowparent"]');
    const rowChildren = () => [...(parentDz?.shadowRoot?.querySelectorAll('dz-component[dz-type="pe-rowchild"]') || [])];

    const initial = rowChildren();
    check(':for-row initial prop count', initial.length === 2);
    check(':for-row initial prop values', initial[0]?.component?.proxy?.label === 'Row: A' && initial[1]?.component?.proxy?.label === 'Row: B');

    parentDz.component.proxy.rows[0].name = 'Changed';
    await new Promise(r => setTimeout(r, 30));
    // The row's underlying item mutation can bubble into a :for reconcile that
    // replaces the row's DOM node - re-query rather than reuse the earlier
    // reference (see debug-row-propeval.mjs investigation this test replaces).
    const afterMutation = rowChildren();
    check(':for-row prop re-evaluates after item property mutation', afterMutation[0]?.component?.proxy?.label === 'Row: Changed');
    check(':for-row re-evaluated prop renders', afterMutation[0]?.shadowRoot?.querySelector('.label')?.textContent === 'Row: Changed');
}

if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
}
console.log('\nAll propEval checks passed');
