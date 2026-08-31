/**
 * bytecodeFormatting.test.js — codegen.js's formatBytecodeArray (the pass that
 * chunks the flat compiled bytecode array into per-entry commented lines for the
 * output .compiled.js file) must consume exactly `bytecode.length` values overall,
 * or the emitted array desyncs and the compiled file silently loses trailing
 * bindings entirely.
 *
 * Regression guard: formatBytecodeArray grouped TWO_WAY with TEXT, both using
 * entryLen = 2 + pathLen + 1 (one data value). TWO_WAY actually carries two data
 * values (refIdx + isDotted flag) - the runtime decoder (render.js's
 * getBindingDataLength) already correctly groups it with ATTR/EVENT/PROP/
 * PROP_SYNC. Any :bind that wasn't the component's very last binding caused
 * formatBytecodeArray's re-derived walk to fall one element short at that entry.
 * For a small binding set the shortfall alone doesn't corrupt anything visible
 * (the chunk boundaries are wrong but every value still ends up written,
 * somewhere, in order) - it only becomes real DATA LOSS once the drift causes a
 * later EVAL-type entry (TEXT_EVAL/ATTR_EVAL/PROP_EVAL) to read its `depsLen`
 * from a misaligned position, producing a garbage entryLen that overshoots past
 * the end of the array and truncates the file mid-emission. That's exactly the
 * real-world shape that surfaced this (Tabulis's ListingDetailPage: two :bind
 * checkboxes, then several more PROP/EVENT/TEXT bindings, then a trailing
 * "Save"/"Cancel" button pair) - the compiled file silently dropped the last
 * event binding and corrupted the second-to-last one's eventConfigIdx, so
 * clicking Save actually invoked an unrelated, earlier-declared method.
 */
import { pathToFileURL } from 'node:url';

const { compile, compileComponentToCode } = await import('../../src/compiler/library/main.js');

let failures = 0;
function check(name, cond) {
    if (cond) console.log(`  ok    ${name}`);
    else { failures++; console.error(`  FAIL  ${name}`); }
}

/**
 * Count the numeric tokens actually present in the generated
 * `code: new Uint16Array([...])` source text (comments/whitespace stripped).
 */
function countEmittedBytecodeValues(componentSource) {
    const generated = compileComponentToCode(componentSource, { componentName: 'BcFmtCount' });
    const match = generated.match(/code: new Uint16Array\(\[([\s\S]*?)\]\)/);
    if (!match) throw new Error('Could not locate code: new Uint16Array([...]) in generated output');
    const body = match[1].replace(/\/\*[\s\S]*?\*\//g, ''); // strip /* N */ comments
    const tokens = body.split(',').map(t => t.trim()).filter(t => t.length > 0);
    return tokens.length;
}

// Shape modeled directly on the real-world component that surfaced this bug:
// two :bind checkboxes, an expression binding, a couple of prop/method-call
// events, then a trailing Save/Cancel button pair - enough bindings after the
// first non-final :bind for the drift to compound into real truncation.
const templates = {
    checkboxesThenEvalThenButtons: `
        <div>
            <input type="checkbox" :bind="flagA" />
            <input type="checkbox" :bind="flagB" />
            <span id="label">{{ flagA ? 'A' : 'B' }}</span>
            <dz-widget :count="n + 1"></dz-widget>
            <button id="extra" @click="extra">Extra</button>
            <button id="save" @click="save">Save</button>
            <button id="cancel" @click="cancel">Cancel</button>
        </div>
    `,
    // A second, differently-shaped case: three interleaved :bind fields with a
    // :for loop and more trailing events, closer to a full form.
    formWithMultipleBinds: `
        <div>
            <input :bind="name" />
            <input type="checkbox" :bind="active" />
            <textarea :bind="notes"></textarea>
            <ul><li :for="row in rows">{{ row.label }}</li></ul>
            <button id="submit" @click="submit">Submit</button>
            <button id="reset" @click="reset">Reset</button>
        </div>
    `
};

for (const [name, template] of Object.entries(templates)) {
    const source = `
        export default Deezul.Component({
            template: \`${template}\`,
            data: () => ({ flagA: false, flagB: false, n: 0, name: '', active: false, notes: '', rows: [] }),
            methods: { extra() {}, save() {}, cancel() {}, submit() {}, reset() {} }
        });
    `;

    const trueLength = compile(template, { componentName: name }).bytecode.length;
    const emittedCount = countEmittedBytecodeValues(source);
    check(`${name}: emitted bytecode value count (${emittedCount}) matches true length (${trueLength})`, emittedCount === trueLength);
}

if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
}
console.log('\nAll bytecodeFormatting checks passed');
