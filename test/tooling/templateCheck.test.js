/**
 * templateCheck.test.js (tooling) — the compiler reports names a template reads that the
 * component never declares.
 *
 * The value of this check is entirely in its false-positive rate: a warning anyone learns
 * to ignore is worse than no warning. So most of what is asserted here is what must NOT
 * be reported -- declared members, `:for` iterators, globals, runtime members, and the
 * documentation code samples inside `:pre`, which the showcase is full of.
 */

import { compileComponent } from '../../src/compiler/library/main.js';
import { topLevelKeys, dataKeys, checkTemplateTags } from '../../src/compiler/library/templateCheck.js';
import { parseTemplate } from '../../src/compiler/library/parser.js';

let failures = 0;
function check(name, cond) {
    if (cond) console.log(`  ok    ${name}`);
    else { failures++; console.error(`  FAIL  ${name}`); }
}

/** Compile quietly: the component under test warns on purpose. */
function warningsFor(source) {
    const original = console.warn;
    console.warn = () => {};
    try {
        return compileComponent(source, { componentName: 'Fixture' }).warnings.map((w) => w.name);
    } finally {
        console.warn = original;
    }
}

// ── Key extraction ───────────────────────────────────────────────────────────
check('object keys', String(topLevelKeys('{ a: 1, b() {} }')) === 'a,b');
check('nested keys do not leak', String(topLevelKeys('{ a: { b: 1 }, c: 2 }')) === 'a,c');
check('a colon inside a string is not a key', String(topLevelKeys("{ a: 'x:y', b: 1 }")) === 'a,b');
check('async and get precede the real key', String(topLevelKeys('{ async a() {}, get b() {} }')) === 'a,b');
check('arrow data factory', String(dataKeys('() => ({ x: 1, y: 2 })')) === 'x,y');
check('method data factory', String(dataKeys('data() { return { x: 1 }; }')) === 'x');

// ── What must be reported ────────────────────────────────────────────────────
{
    const w = warningsFor(`export default Deezul.Component({
        template: \`
            <p>{{ coutn }}</p>
            <button @click="svae">go</button>
            <span :class="actve ? 'on' : ''">x</span>
            <li :for="item in itms">{{ item }}</li>
        \`,
        data: () => ({ count: 0 }),
        methods: { async save() {} },
    });`);
    check('typo in an interpolation', w.includes('coutn'));
    check('typo in an event handler', w.includes('svae'));
    check('typo inside an attribute expression', w.includes('actve'));
    check('typo in the :for source', w.includes('itms'));
}

// ── What must NOT be reported ────────────────────────────────────────────────
{
    const w = warningsFor(`export default Deezul.Component({
        template: \`
            <b>{{ count }} {{ doubled }} {{ LABEL }}</b>
            <i @click="save">ok</i>
            <li :for="(item, i) in items">{{ item.name }} {{ i }}</li>
            <div :if="count > 0">{{ Math.max(count, 1) }}</div>
            <input :ref="box">
            <em @click="$emit('x')">{{ $refs.box }}</em>
            <pre :pre><code>{{ notARealThing }}</code></pre>
        \`,
        data: () => ({ count: 0, items: [] }),
        static: { LABEL: 'hi' },
        computed: { doubled() { return this.count * 2; } },
        methods: { async save() {} },
    });`);
    check('declared data is quiet', !w.includes('count'));
    check('declared computed is quiet', !w.includes('doubled'));
    check('declared method is quiet', !w.includes('save'));
    check('static values are quiet', !w.includes('LABEL'));
    check(':for iterator is quiet', !w.includes('item'));
    check(':for index is quiet', !w.includes('i'));
    check('globals are quiet', !w.includes('Math'));
    check('runtime members are quiet', !w.includes('$refs') && !w.includes('$emit'));
    check(':pre documentation is quiet', !w.includes('notARealThing'));
    check('nothing at all is reported here', w.length === 0);
}

// A component with no script sections at all must not report its own template back.
{
    const w = warningsFor('export default Deezul.Component({ template: `<p>hello</p>` });');
    check('a static template is quiet', w.length === 0);
}

// ── Comments inside values ───────────────────────────────────────────────────
// Found against a real component library: an apostrophe in a comment opened a string
// that swallowed the rest of the object, so every key after it went unseen and every
// name the template read from them was reported as undeclared.
{
    const apostrophe = String.fromCharCode(39);
    const src = [
        '{',
        '    first() { return 1; },',
        '    // hand the root element the slide' + apostrophe + 's flex rules',
        '    second() { return 2; },',
        '    /* a block comment with a stray } and , too */',
        '    third() { return 3; },',
        '}',
    ].join(String.fromCharCode(10));
    check('a comment cannot hide later keys', String(topLevelKeys(src)) === 'first,second,third');
}

// ── Regex literals inside values ──────────────────────────────────────
// The same shape as the comment bug: a delimiter the scanner did not know about,
// holding braces or quotes, swallowing every key after it. scriptParser already had
// isRegexStart for this, so the scanner uses that rather than guessing a second time.
{
    const q = String.fromCharCode(39);
    check('a regex holding a brace', String(topLevelKeys('{ a() { return /[}]/.test(x); }, b: 1 }')) === 'a,b');
    check('a regex holding an apostrophe', String(topLevelKeys('{ a() { return /don' + q + 't/.test(x); }, b: 1 }')) === 'a,b');
    check('division is not mistaken for a regex', String(topLevelKeys('{ a() { return x / y; }, b: 1 }')) === 'a,b');
}

// ── Unknown component tags ───────────────────────────────────────────────────
{
    const ast = parseTemplate(`
        <section>
            <h1>plain html</h1>
            <stat-tile></stat-tile>
            <stat-tyle></stat-tyle>
            <router-component></router-component>
            <pre :pre><code><made-up></made-up></code></pre>
        </section>
    `);
    const unknown = checkTemplateTags(ast, ['stat-tile']).map((t) => t.name);

    check('a registered tag is quiet', !unknown.includes('stat-tile'));
    check('a misspelled tag is reported', unknown.includes('stat-tyle'));
    check('a built-in is quiet', !unknown.includes('router-component'));
    check('plain HTML is quiet', !unknown.includes('section') && !unknown.includes('h1'));
    check('a tag inside :pre is quiet', !unknown.includes('made-up'));
    check('nothing else is reported', unknown.length === 1);

    // Without a ref list there is no project to compare against, so it says nothing
    // rather than reporting every component in the file.
    check('no refs means no claims', checkTemplateTags(ast, undefined).length === 0);
}

// ── Positions ────────────────────────────────────────────────────────────────
// A warning is worth much more when it says where. Lines are counted in the FILE,
// not the template, so they match what the editor shows.
{
    const original = console.warn;
    console.warn = () => {};
    let warnings;
    try {
        warnings = compileComponent([
            'export default Deezul.Component({',      // 1
            '    template: `',                        // 2
            '        <p>{{ good }}</p>',              // 3
            '        <p>{{ bad }}</p>',               // 4
            '    `,',                                 // 5
            '    data: () => ({ good: 1 }),',         // 6
            '});',                                    // 7
        ].join(String.fromCharCode(10)), { componentName: 'Positioned' }).warnings;
    } finally {
        console.warn = original;
    }

    check('one warning', warnings.length === 1);
    check('it is the right one', warnings[0].name === 'bad');
    check('it carries a line', typeof warnings[0].line === 'number');
    check('the line is the one in the FILE', warnings[0].line === 4);
}

if (failures > 0) {
    console.error(`\n  ${failures} failure(s)`);
    process.exit(1);
}
