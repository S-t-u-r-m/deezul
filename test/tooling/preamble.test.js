/**
 * preamble.test.js (tooling) — a component file is ordinary JavaScript, and the parts of
 * it the compiler does not recognise survive compilation.
 *
 * Before this, only the recognised keys of the Deezul.Component({...}) object were kept.
 * Imports, module-level constants, helper functions and module state were discarded while
 * the method bodies using them were emitted verbatim -- so a component compiled cleanly
 * and threw ReferenceError on its first binding. That is the failure these guard.
 */

import { compileComponent } from '../../src/compiler/library/main.js';
import { isComponentSource } from '../../src/compiler/library/scriptParser.js';
import { generateCode } from '../../src/compiler/library/codegen.js';

let failures = 0;
function check(name, cond) {
    if (cond) console.log(`  ok    ${name}`);
    else { failures++; console.error(`  FAIL  ${name}`); }
}

const SOURCE = `import { shout } from './helpers.js';
import Other from '../Other.js';

const LIMIT = 10;
let callCount = 0;

function localHelper(n) { return n * 2; }

export default Deezul.Component({
    template: \`<p>{{ info }}</p>\`,
    data: () => ({ n: 3 }),
    computed: { info() { return localHelper(this.n) + LIMIT; } },
    methods: { tick() { callCount++; return shout(Other); } },
});`;

const code = generateCode(compileComponent(SOURCE, { componentName: 'Fixture' }));

check('named import survives', code.includes("import { shout } from './helpers.js';"));
check('default import survives', code.includes("import Other from '../Other.js';"));
check('const survives', code.includes('const LIMIT = 10;'));
check('let survives', code.includes('let callCount = 0;'));
check('function declaration survives', code.includes('function localHelper(n)'));
check('specifiers are not rewritten', code.includes("'./helpers.js'") && !code.includes('../src/'));
check('preamble precedes the export', code.indexOf('const LIMIT') < code.indexOf('export default'));
check('the export is still there', code.includes('export default {'));

// The bodies that use them were always emitted; the point is that now they resolve.
check('bodies still reference the preamble', code.includes('localHelper(this.n)') && code.includes('callCount++'));

// A component with nothing above the call must not gain a stray blank preamble.
{
    const bare = generateCode(compileComponent(
        'export default Deezul.Component({ template: `<p>x</p>` });',
        { componentName: 'Bare' },
    ));
    check('no preamble, no damage', bare.trimStart().startsWith('/**') && bare.includes('export default {'));
    check('nothing imported out of nowhere', !bare.includes('import '));
}

// What the build uses to tell a component from a helper module sitting beside it.
check('a component is recognised', isComponentSource(SOURCE));
check('a plain module is not', !isComponentSource('export function title(s) { return s; }'));
check('export default alone is not a component', !isComponentSource('export default { a: 1 };'));

if (failures > 0) {
    console.error(`\n  ${failures} failure(s)`);
    process.exit(1);
}
