/**
 * schemaInputs.test.js (tooling) — `schema.inputs` is the component's props, and saying
 * so once is enough.
 *
 * Every block in the county CMS declared each input twice: once in schema.inputs with the
 * default the page builder offers, and again in data() with the same value. Two places
 * holding one fact, free to drift, with the editor believing one and the running
 * component the other.
 *
 * Now the runtime seeds data from those defaults, and the compiler counts the names as
 * declared -- so a component may state an input once and the template that reads it stays
 * quiet.
 */

import { compileComponent } from '../../src/compiler/library/main.js';
import { schemaInputNames } from '../../src/compiler/library/templateCheck.js';
import { schemaDefaults } from '../../src/runtime/helpers.js';

let failures = 0;
function check(name, cond) {
    if (cond) console.log(`  ok    ${name}`);
    else { failures++; console.error(`  FAIL  ${name}`); }
}

function warningsFor(source) {
    const original = console.warn;
    console.warn = () => {};
    try {
        return compileComponent(source, { componentName: 'Fixture' }).warnings.map((w) => w.name);
    } finally {
        console.warn = original;
    }
}

// ── The defaults the runtime seeds ───────────────────────────────────────────
{
    const seeded = schemaDefaults({
        inputs: {
            level: { type: 'enum', options: ['info', 'warning'], default: 'info' },
            title: { type: 'string', default: '' },
            count: { type: 'number', default: 0 },
            flag: { type: 'boolean', default: false },
            noDefault: { type: 'string' },
        },
    });

    check('a default is seeded', seeded.level === 'info');
    check('an empty string is kept, not skipped', seeded.title === '');
    check('zero is kept', seeded.count === 0);
    check('false is kept', seeded.flag === false);
    check('an input without a default still exists', 'noDefault' in seeded);
    check('and is undefined rather than missing', seeded.noDefault === undefined);

    check('no schema is harmless', Object.keys(schemaDefaults(undefined)).length === 0);
    check('no inputs is harmless', Object.keys(schemaDefaults({ slots: [] })).length === 0);
    check('a malformed input does not throw', schemaDefaults({ inputs: { x: null } }).x === undefined);
}

// ── Names the compiler reads out of it ───────────────────────────────────────
{
    const src = "{ inputs: { level: { type: 'enum', default: 'info' }, title: { type: 'string' } } }";
    check('input names are found', String(schemaInputNames(src)) === 'level,title');
    check('only inputs, not the schema keys', !schemaInputNames("{ slots: ['body'], inputs: { a: {} } }").includes('slots'));
    check('no schema, no names', schemaInputNames(null).length === 0);
}

// ── Declared once is enough ──────────────────────────────────────────────────
{
    const once = warningsFor(`export default Deezul.Component({
        schema: { inputs: { heading: { type: 'string', default: '' }, tone: { type: 'enum', default: 'calm' } } },
        template: \`<h1 :class="tone">{{ heading }}</h1>\`,
    });`);
    check('an input read by the template is quiet', once.length === 0);

    // The old style still works: declaring both is harmless, data() simply wins.
    const both = warningsFor(`export default Deezul.Component({
        schema: { inputs: { heading: { type: 'string', default: '' } } },
        template: \`<h1>{{ heading }}</h1>\`,
        data: () => ({ heading: 'from data' }),
    });`);
    check('declaring both is still quiet', both.length === 0);

    // And a genuine typo is still caught.
    const typo = warningsFor(`export default Deezul.Component({
        schema: { inputs: { heading: { type: 'string', default: '' } } },
        template: \`<h1>{{ headingg }}</h1>\`,
    });`);
    check('a typo is still reported', typo.includes('headingg'));
}

if (failures > 0) {
    console.error(`\n  ${failures} failure(s)`);
    process.exit(1);
}
