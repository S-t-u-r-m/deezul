/**
 * modulePaths.test.js — `{ ref, src }` module entries: the resolver's path rules,
 * its config errors, and that both registration sites (Deezul.init and
 * registry.registerAll) actually load from the resolved compiled path.
 */

import { Window } from 'happy-dom';

const window = new Window({ url: 'http://localhost/' });
globalThis.window = window;
globalThis.document = window.document;
globalThis.customElements = window.customElements;
globalThis.HTMLElement = window.HTMLElement;
globalThis.CustomEvent = window.CustomEvent;
globalThis.localStorage = window.localStorage;

const { compiledPath, modulePath } = await import('../../src/runtime/modulePaths.js');
const { createModuleRegistry } = await import('../../src/runtime/ModuleRegistry.js');

let failures = 0;
function check(name, cond) {
    if (cond) console.log(`  ok    ${name}`);
    else { failures++; console.error(`  FAIL  ${name}`); }
}
function throws(fn, pattern) {
    try { fn(); return false; } catch (e) { return pattern.test(e.message); }
}

// ── compiledPath: source file under src/ → compiled module path ──
{
    const want = './compiled/component/Button.compiled.js';
    check('subdirectory mirrored', compiledPath('component/Button.js') === want);
    check('.js is optional', compiledPath('component/Button') === want);
    check('leading ./ is optional', compiledPath('./component/Button.js') === want);
    check('leading src/ is optional', compiledPath('src/component/Button.js') === want);
    check('top-level file', compiledPath('App.js') === './compiled/App.compiled.js');
    check('only a trailing .js is stripped', compiledPath('lib.js/Thing.js') === './compiled/lib.js/Thing.compiled.js');
}

// ── modulePath: which path an entry loads from ──
{
    check('path passes through unchanged', modulePath({ ref: 'a', path: './x/A.compiled.js' }) === './x/A.compiled.js');
    check('src resolves', modulePath({ ref: 'b', src: 'view/B.js' }) === './compiled/view/B.compiled.js');
    check('inline data has no path', modulePath({ ref: 'c', data: { template: '' } }) === undefined);
    check('data store with path passes through', modulePath({ ref: 's', type: 'data', path: './s.js' }) === './s.js');

    check('src + path is rejected', throws(() => modulePath({ ref: 'd', src: 'D.js', path: './D.js' }), /both 'src' and 'path'/));
    check('empty src is rejected', throws(() => modulePath({ ref: 'e', src: '' }), /invalid 'src'/));
    check('non-string src is rejected', throws(() => modulePath({ ref: 'f', src: 42 }), /invalid 'src'/));
    check('src on a data store is rejected', throws(() => modulePath({ ref: 'g', type: 'data', src: 'G.js' }), /only components are compiled/));
}

// Loading a src entry must import the resolved compiled path. The file does not exist,
// so the import fails — and the failure names the URL that was attempted, resolved
// against the runtime module (src/runtime/), exactly as the browser resolves it
// against deezul.esm.js.
async function attemptedImport(load) {
    const logged = [];
    const orig = console.error;
    console.error = (...args) => logged.push(args.map(a => (a && a.message) || String(a)).join(' '));
    try { await load(); } finally { console.error = orig; }
    return logged.join('\n').replace(/\\/g, '/');
}

// ── registry.registerAll ──
{
    const registry = createModuleRegistry('test');
    registry.registerAll([
        { ref: 'probe-src', src: 'component/Probe.js' },
        { ref: 'probe-inline', data: { template: '<p></p>' } }
    ]);
    check('registerAll registers src entry', registry.has('probe-src'));

    const log = await attemptedImport(() => registry.get('probe-src'));
    check('registerAll loads from resolved compiled path', log.includes('/src/runtime/compiled/component/Probe.compiled.js'));

    const inline = await registry.get('probe-inline');
    check('registerAll inline data still registers as loaded', inline && inline.template === '<p></p>');

    check('registerAll surfaces config errors',
        throws(() => registry.registerAll([{ ref: 'bad', src: 'X.js', path: './X.js' }]), /both 'src' and 'path'/));
}

// ── Deezul.init ──
{
    const root = document.createElement('div');
    root.id = 'app';
    document.body.appendChild(root);

    const { default: Deezul } = await import('../../src/runtime/Deezul.js');
    const { componentRegistry } = await import('../../src/runtime/registries.js');

    Deezul.init({
        rootElement: 'app',
        logging: { level: 'ERROR' },
        modules: [{ ref: 'init-probe', src: 'layout/InitProbe.js' }]
    });
    check('init registers src entry', componentRegistry.has('init-probe'));

    const log = await attemptedImport(() => componentRegistry.get('init-probe'));
    check('init loads from resolved compiled path', log.includes('/src/runtime/compiled/layout/InitProbe.compiled.js'));
}

await window.happyDOM.abort();

if (failures > 0) {
    console.error(`\n${failures} module path check(s) failed`);
    process.exit(1);
}
console.log('\nAll module path checks passed');
process.exit(0);
