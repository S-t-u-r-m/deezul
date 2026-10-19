/**
 * componentTags.test.js (tooling) — a component's own tag renders it.
 *
 * Only `dz-component` is customElements.define()d, so composing one component inside
 * another used to mean writing the host element and naming the ref in an attribute:
 *
 *     <dz-component dz-type="selection-list"></dz-component>
 *
 * A bare `<selection-list>` had nothing to upgrade it and rendered as an inert unknown
 * element -- while checkTemplateTags validated exactly that bare form against the
 * manifest, so the compiler described a syntax the runtime did not implement. Across the
 * whole showcase not one component embedded another; the only cross-component tag in any
 * template was <router-component>, which is a real element.
 *
 * The compiler now rewrites a known ref into its host at compile time. The runtime is
 * untouched and one element still serves every component.
 */

import { compileComponent } from '../../src/compiler/library/main.js';
import { rewriteComponentTags } from '../../src/compiler/library/templateCheck.js';
import { parseTemplate } from '../../src/compiler/library/parser.js';

let failures = 0;
function check(name, cond) {
    if (cond) console.log(`  ok    ${name}`);
    else { failures++; console.error(`  FAIL  ${name}`); }
}

const REFS = ['selection-list', 'list-block', 'permissions-explorer'];

/** The whole compilation, with the project's refs known. */
function compiled(template, refs = REFS) {
    const original = console.warn;
    console.warn = () => {};
    try {
        return compileComponent(
            `export default Deezul.Component({ template: \`${template}\`, data: () => ({ blocks: [] }) });`,
            { componentName: 'Fixture', knownRefs: refs }
        );
    } finally {
        console.warn = original;
    }
}

/** Just its serialized template HTML, which is where a rewritten tag shows up. */
function html(template, refs = REFS) {
    return compiled(template, refs).templateHTML;
}

// ── The rewrite itself ───────────────────────────────────────────────────────
{
    const out = html('<selection-list></selection-list>');
    check('a known ref becomes the host element', out.includes('<dz-component'));
    check('and carries its ref in dz-type', out.includes('dz-type="selection-list"'));
    check('the original tag is gone', !out.includes('<selection-list'));

    const attrs = html('<list-block items="a" class="x"></list-block>');
    check('static attributes survive', attrs.includes('items="a"') && attrs.includes('class="x"'));

    const nested = html('<div><section><list-block></list-block></section></div>');
    check('it reaches nested tags', nested.includes('dz-type="list-block"'));

    const two = html('<list-block></list-block><selection-list></selection-list>');
    check('every occurrence is rewritten', !two.includes('<list-block') && !two.includes('<selection-list'));
}

// ── What it must leave alone ─────────────────────────────────────────────────
{
    const unknown = html('<some-widget></some-widget>');
    check('an unknown hyphenated tag is untouched', unknown.includes('<some-widget'));

    const builtin = html('<router-component></router-component>');
    check('a real element is untouched', builtin.includes('<router-component'));

    const explicit = html('<dz-component dz-type="list-block"></dz-component>');
    check('the host form written by hand is untouched', !explicit.includes('dz-type="dz-component"'));

    const plain = html('<div><p>text</p></div>');
    check('ordinary HTML is untouched', plain.includes('<div>') && !plain.includes('dz-component'));

    // :pre is literal markup -- the showcase prints deezul's own syntax as example code.
    const pre = html('<pre :pre><selection-list></selection-list></pre>');
    check('a :pre subtree is left as documentation', pre.includes('<selection-list'));

    // No ref list means no project to compare against: compiling a lone template cannot
    // tell a component from a custom element the page defines elsewhere.
    const ast = parseTemplate('<selection-list></selection-list>');
    check('no refs, no rewrite', rewriteComponentTags(ast, null).length === 0);
    check('and the tree is unchanged', ast.children[0].tag === 'selection-list');
}

// ── Bindings still work through the rewrite ──────────────────────────────────
{
    const bound = html('<selection-list :person-id="who" @select="pick"></selection-list>');
    check('the host keeps its dz-type', bound.includes('dz-type="selection-list"'));

    // A bound prop and an event are compiled into the bytecode, not left in the HTML,
    // so their absence from the markup is the correct result.
    check('a bound attribute is compiled away', !bound.includes(':person-id'));

    // A :for element is compiled into a dynamic block, so its markup lands in that
    // block's own template and the main one keeps only the marker.
    const loop = compiled('<list-block :for="b in blocks"></list-block>');
    check('the main template holds only the marker', loop.templateHTML === '<!--for-->');
    check(
        'and the looped component is rewritten in its block',
        loop.dynamics[0].compiled.templateHTML.includes('dz-type="list-block"')
    );

    const reported = rewriteComponentTags(parseTemplate('<list-block></list-block><selection-list></selection-list>'), REFS);
    check('it reports what it rewrote', String(reported) === 'list-block,selection-list');
}

if (failures > 0) {
    console.error(`\n  ${failures} failure(s)`);
    process.exit(1);
}
