/**
 * forIfGuard.test.js — :for and :if on the SAME element mean one of two things, and which
 * one is decidable from the condition:
 *
 *   :if="show"   known before the loop runs → it GATES the loop. Compiles: the conditional
 *                owns the node, the loop is nested in its branch, and an :else-if / :else
 *                sibling takes over when it is false.
 *   :if="x.ok"   per ITERATION. One element cannot be both the loop and a per-row test —
 *                the loop would win and the :if would never run — so this is refused, with
 *                guidance naming the variable that gave it away.
 */
import { compileComponentToCode } from '../../src/compiler/library/main.js';

let failures = 0;
function check(name, cond, extra) {
    if (cond) console.log(`  ok    ${name}`);
    else { failures++; console.error(`  FAIL  ${name}${extra !== undefined ? '   [' + extra + ']' : ''}`); }
}

const wrap = (tpl) => `export default Deezul.Component({ template: \`${tpl}\`, `
    + `data: () => ({ items: [], show: true, obj: { x: 1 }, limit: 2 }) });`;
const compiles = (tpl) => {
    try { compileComponentToCode(wrap(tpl), { componentName: 'T' }); return ''; }
    catch (e) { return e.message; }
};

// ── A condition the loop variables have nothing to do with: gates the loop. ─────────────
check('a loop-independent :if compiles on the :for element',
      compiles('<ul><li :for="x in items" :if="show">{{ x.n }}</li></ul>') === '',
      compiles('<ul><li :for="x in items" :if="show">{{ x.n }}</li></ul>'));
check('...with an :else sibling to take over',
      compiles('<ul><li :for="x in items" :if="show">{{ x.n }}</li><li :else>None</li></ul>') === '',
      compiles('<ul><li :for="x in items" :if="show">{{ x.n }}</li><li :else>None</li></ul>'));
check('...and an expression over state, not just a flag',
      compiles('<ul><li :for="x in items" :if="items.length > limit">{{ x.n }}</li></ul>') === '');
check('a property that merely SHARES the loop variable\'s name is not a use of it',
      compiles('<ul><li :for="x in items" :if="obj.x">{{ x.n }}</li></ul>') === '',
      compiles('<ul><li :for="x in items" :if="obj.x">{{ x.n }}</li></ul>'));
check('...nor is the name inside a string',
      compiles('<ul><li :for="x in items" :if="show && \'x\' !== \'y\'">{{ x.n }}</li></ul>') === '');

// ── A condition that reads the loop variable: still refused, and says why. ──────────────
const perRow = compiles('<ul><li :for="x in items" :if="x.ok">{{ x.n }}</li></ul>');
check('a per-iteration :if is refused', perRow !== '');
check('...naming the variable that gave it away', /`x`/.test(perRow), perRow);
check('...and saying what to do instead', /computed|wrapping element/.test(perRow), perRow);
check('the index variable counts too',
      compiles('<ul><li :for="x, i in items" :if="i < 3">{{ x.n }}</li></ul>') !== '');
check(':else-if is checked the same way',
      compiles('<ul><li :if="show">a</li><li :for="x in items" :else-if="x.ok">{{ x.n }}</li></ul>') !== '');

// ── The shapes that always worked, still work. ──────────────────────────────────────────
check(':for alone still compiles', compiles('<ul><li :for="x in items">{{ x.n }}</li></ul>') === '');
check(':for and :if on separate elements compiles',
      compiles('<ul><li :for="x in items"><span :if="x.ok">{{ x.n }}</span></li></ul>') === '');
check(':if alone still compiles', compiles('<div :if="show">a</div>') === '');

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
else console.log('\nall :for/:if checks passed');
