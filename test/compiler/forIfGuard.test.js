/**
 * forIfGuard.test.js — :for and :if on the SAME element is a footgun (the :if never
 * runs per-iteration), so the compiler must reject it with actionable guidance rather
 * than silently emitting two competing structural dynamics. :for and :if on SEPARATE
 * elements must still compile.
 */
import { compileComponentToCode } from '../../src/compiler/library/main.js';

let failures = 0;
function check(name, cond) {
    if (cond) console.log(`  ok    ${name}`);
    else { failures++; console.error(`  FAIL  ${name}`); }
}

const wrap = (tpl) => `export default Deezul.Component({ template: \`${tpl}\`, data: () => ({ items: [], show: true }) });`;

// :for + :if on one element → throws with guidance.
let threw = null;
try { compileComponentToCode(wrap('<ul><li :for="x in items" :if="x.ok">{{ x.n }}</li></ul>'), { componentName: 'T' }); }
catch (e) { threw = e.message; }
check('rejects :for + :if on the same element', threw !== null);
check('error names both directives', threw !== null && /:for and :if/.test(threw));
check('error suggests the computed-filter fix', threw !== null && /computed|wrapping/.test(threw));

// :for alone still compiles.
let ok1 = true;
try { compileComponentToCode(wrap('<ul><li :for="x in items">{{ x.n }}</li></ul>'), { componentName: 'T' }); }
catch { ok1 = false; }
check(':for alone still compiles', ok1);

// :for and :if on SEPARATE (nested) elements compiles.
let ok2 = true;
try { compileComponentToCode(wrap('<ul><li :for="x in items"><span :if="x.ok">{{ x.n }}</span></li></ul>'), { componentName: 'T' }); }
catch { ok2 = false; }
check(':for and :if on separate elements compiles', ok2);

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
else console.log('\nall :for/:if guard checks passed');
