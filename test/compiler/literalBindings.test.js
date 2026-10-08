/**
 * literalBindings.test.js — `true`, `false`, `null` and `undefined` in a binding are values.
 *
 * Regression guard: the compiler decided "plain data path or expression" with an identifier
 * regex, which those four words match. So `:showAdd="true"` on a component compiled to a prop
 * bound to a data property literally named `true` (always undefined), and `:disabled="false"`
 * on an element to an attribute bound to one named `false`. Nothing errored; the value simply
 * never arrived - a component's boolean options silently stayed off. Found passing
 * AccordionList its `showAdd`/`showEdit`/... switches from the CMS's Navigation manager.
 */
import { compileComponentToCode } from '../../src/compiler/library/main.js';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';

let failures = 0;
function check(name, cond) {
    if (cond) console.log(`  ok    ${name}`);
    else { failures++; console.error(`  FAIL  ${name}`); }
}

const src = `export default Deezul.Component({
    template: \`<div>
        <dz-component dz-type="kid" :on="true" :off="false" :none="null" :gone="undefined" :label="'x'" :bound="flag"></dz-component>
        <button :disabled="false" :hidden="true">b</button>
    </div>\`,
    data: () => ({ flag: 1 })
});`;

const dir = mkdtempSync(join(tmpdir(), 'dz-lit-'));
let def = null;
try {
    const file = join(dir, 'Lit.compiled.js');
    writeFileSync(file, compileComponentToCode(src, { componentName: 'Lit' }));
    def = (await import(pathToFileURL(file).href)).default;
} finally {
    rmSync(dir, { recursive: true, force: true });
}

const strings = (def && def.binding && def.binding.strings) || [];
const evals = ((def && def.eval) || []).map(fn => { try { return fn.call({ flag: 1 }); } catch { return '(threw)'; } });

check('`true` is never treated as a data property', !strings.includes('true'));
check('`false` is never treated as a data property', !strings.includes('false'));
check('`null` is never treated as a data property', !strings.includes('null'));
check('`undefined` is never treated as a data property', !strings.includes('undefined'));
check('a component prop of `true` evaluates to true', evals.includes(true));
check('a component prop of `false` evaluates to false', evals.includes(false));
check('a component prop of `null` evaluates to null', evals.includes(null));
check('a string literal prop still evaluates to its string', evals.includes('x'));
check('a real data path is still bound as a path', strings.includes('flag'));

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nall passed');
