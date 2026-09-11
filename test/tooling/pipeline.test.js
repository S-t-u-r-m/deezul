/**
 * pipeline.test.js — the build pipeline shared by deezul-build and `deezul-dev --dist`:
 *
 *   1. deezul-build ships every file the app references (followed transitively) and
 *      nothing it doesn't, and warns about references to files that don't exist.
 *   2. `deezul-dev --dist` serves dist/, and each save pushes only what changed:
 *      a component recompiles alone, a new import ships, a dropped import is removed,
 *      a deleted component disappears, and a compile error reports instead of crashing.
 *
 * Runs the real bin scripts against throwaway fixture apps.
 */

import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { createServer } from 'net';
import http from 'http';

const exec = promisify(execFile);
const PKG = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let failures = 0;
function check(name, cond) {
    if (cond) console.log(`  ok    ${name}`);
    else { failures++; console.error(`  FAIL  ${name}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function writeTree(root, files) {
    for (const [rel, content] of Object.entries(files)) {
        const file = join(root, rel);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, content);
    }
}

const component = (msg) => `export default Deezul.Component({
    template: \`<p>{{ msg }}</p>\`,
    data: () => ({ msg: '${msg}' })
});
`;

// ── 1. deezul-build follows references ───────────────────────────────────────
{
    const app = await mkdtemp(join(tmpdir(), 'deezul-pipeline-build-'));
    try {
        await writeTree(app, {
            'index.html': `<!DOCTYPE html>
<html><head>
<link rel="stylesheet" href="/styles/site.css">
<link rel="preconnect" href="https://fonts.example.com">
</head><body>
<img src="img/logo.svg" alt="">
<script type="module" src="/main.js"></script>
<script type="module">import './inline-dep.js';</script>
<script>if (!location.search.includes('noreload')) new EventSource('/__reload').onmessage = () => location.reload();</script>
</body></html>
`,
            'second.html': `<!DOCTYPE html><script type="module" src="second.js"></script>`,
            'main.js': `import Deezul from './deezul.esm.js';
import {
    a,
    b
} from './lib/a.js';
import './side.js';
export { c } from './reexport.js';
// import './ghost-line.js';
/* import './ghost-block.js'; */
import pkg from 'some-package';
const lazy = () => import('./lazy.js');
const url = 'https://example.com/not-a-file.js';
const accept = 'image/*';
import './missing.js';
`,
            'lib/a.js': `import shared from '../shared.js';\nexport const a = 1, b = 2;\n`,
            'shared.js': 'export default 1;\n',
            'side.js': '',
            'reexport.js': 'export const c = 3;\n',
            'lazy.js': 'export default 4;\n',
            'inline-dep.js': '',
            'second.js': '',
            'styles/site.css': 'body{}\n',
            'img/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
            'app.config.js': 'export default {};\n',
            'unreferenced.js': '',
            'ghost-line.js': '',
            'ghost-block.js': '',
            'assets/tokens.css': ':root{}\n',
            'public/robots.txt': 'User-agent: *\n',
            'src/component/Widget.js': component('widget')
        });

        const { stderr } = await exec('node', [join(PKG, 'src/build/index.js')], { cwd: app });
        const dist = (p) => existsSync(join(app, 'dist', p));

        for (const p of ['index.html', 'second.html', 'main.js', 'app.config.js', 'deezul.esm.js',
                         'compiled/component/Widget.compiled.js', 'assets/tokens.css', 'robots.txt']) {
            check(`build ships ${p} (fixed member)`, dist(p));
        }
        for (const p of ['lib/a.js', 'shared.js', 'side.js', 'reexport.js', 'lazy.js',
                         'inline-dep.js', 'second.js', 'styles/site.css', 'img/logo.svg']) {
            check(`build follows reference to ${p}`, dist(p));
        }
        for (const p of ['unreferenced.js', 'ghost-line.js', 'ghost-block.js', 'src/component/Widget.js']) {
            check(`build does not ship ${p}`, !dist(p));
        }

        const html = await readFile(join(app, 'dist/index.html'), 'utf-8');
        check('build strips the live-reload line', !html.includes('__reload') && html.includes('src="/main.js"'));
        check('build warns about a missing import', /main\.js references \.\/missing\.js, which does not exist/.test(stderr));
    } finally {
        await rm(app, { recursive: true, force: true });
    }
}

// ── 2. deezul-dev --dist pushes only what changed ────────────────────────────

const freePort = () => new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

async function waitFor(cond, what, ms = 8000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
        if (await cond()) return true;
        await sleep(50);
    }
    console.error(`        timed out waiting for: ${what}`);
    return false;
}

{
    const app = await mkdtemp(join(tmpdir(), 'deezul-pipeline-dev-'));
    const port = await freePort();
    const base = `http://localhost:${port}`;
    let dev = null;
    let sse = null;
    const out = (p) => join(app, 'dist', p);
    const mtime = async (p) => (await stat(out(p))).mtimeMs;

    try {
        await writeTree(app, {
            'index.html': '<!DOCTYPE html><html><body><div id="app"></div><script type="module" src="/main.js"></script></body></html>',
            'main.js': `import './a.js';\n`,
            'a.js': '',
            'src/component/One.js': component('one'),
            'src/component/Two.js': component('two')
        });

        dev = spawn('node', [join(PKG, 'src/dev-server/index.js'), '--dist'], {
            cwd: app,
            env: { ...process.env, PORT: String(port) }
        });
        let devErr = '';
        dev.stderr.on('data', (d) => { devErr += d; });
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('dev server did not start')), 10000);
            dev.stdout.on('data', (d) => { if (String(d).includes('running at')) { clearTimeout(timer); resolve(); } });
            dev.on('exit', (code) => { clearTimeout(timer); reject(new Error(`dev server exited (${code}): ${devErr}`)); });
        });

        // Serving
        const page = await (await fetch(base + '/')).text();
        check('dist dev builds dist/ at startup', existsSync(out('compiled/component/One.compiled.js')) && existsSync(out('a.js')));
        check('dist dev injects the live-reload script once', page.split("new EventSource('/__reload')").length === 2);
        const deep = await fetch(base + '/some/deep/route');
        check('dist dev falls back to index.html for routes', deep.status === 200 && (await deep.text()).includes('id="app"'));
        const one = await fetch(base + '/compiled/component/One.compiled.js');
        check('dist dev serves compiled components from dist/', one.status === 200 && (await one.text()).includes('Compiled component:'));

        // Live reload stream
        let reloads = 0;
        await new Promise((resolve) => {
            sse = http.get(base + '/__reload', (res) => {
                res.on('data', (d) => { if (String(d).includes('data: reload')) reloads++; });
                resolve();
            });
        });
        const reloadAfter = async (change, what) => {
            const before = reloads;
            await change();
            return waitFor(() => reloads > before, `reload after ${what}`);
        };
        const served = async (p) => (await fetch(base + '/' + p)).text();

        // Editing one component recompiles it alone.
        const mainBefore = await mtime('main.js');
        const twoBefore = await mtime('compiled/component/Two.compiled.js');
        check('component edit reloads', await reloadAfter(() => writeFile(join(app, 'src/component/One.js'), component('one-edited')), 'component edit'));
        check('component edit is served', await waitFor(async () => (await served('compiled/component/One.compiled.js')).includes('one-edited'), 'edited component'));
        check('component edit leaves main.js untouched', (await mtime('main.js')) === mainBefore);
        check('component edit leaves other components untouched', (await mtime('compiled/component/Two.compiled.js')) === twoBefore);

        // A new import ships; the components are left alone.
        await writeFile(join(app, 'b.js'), 'export default 1;\n');
        await sleep(400);
        check('unreferenced new file does not ship', !existsSync(out('b.js')));
        check('new import reloads', await reloadAfter(() => writeFile(join(app, 'main.js'), `import './a.js';\nimport './b.js';\n`), 'new import'));
        check('new import ships', await waitFor(() => existsSync(out('b.js')), 'b.js in dist'));
        check('new import leaves components untouched', (await mtime('compiled/component/Two.compiled.js')) === twoBefore);

        // A dropped import is removed from dist/.
        check('dropped import reloads', await reloadAfter(() => writeFile(join(app, 'main.js'), `import './a.js';\n`), 'dropped import'));
        check('dropped import is removed from dist', await waitFor(() => !existsSync(out('b.js')), 'b.js removed'));

        // A deleted component disappears.
        check('deleted component reloads', await reloadAfter(() => rm(join(app, 'src/component/Two.js')), 'deleted component'));
        check('deleted component is removed from dist', await waitFor(() => !existsSync(out('compiled/component/Two.compiled.js')), 'Two removed'));

        // A compile error reports in the browser instead of taking the server down.
        check('compile error reloads', await reloadAfter(() => writeFile(join(app, 'src/component/One.js'), 'export default Deezul.Component({ template: `<p>`, data: () => ({'), 'broken component'));
        check('compile error is served as a console.error module', await waitFor(async () => (await served('compiled/component/One.compiled.js')).includes('Compile error in component/One.js'), 'error module'));
        check('server survives a compile error', dev.exitCode === null && (await fetch(base + '/')).status === 200);
    } finally {
        if (sse) sse.destroy();
        if (dev && dev.exitCode === null) {
            const exited = new Promise((resolve) => dev.once('exit', resolve));
            dev.kill();
            await exited;   // the watcher holds the fixture dir open on Windows until exit
        }
        await rm(app, { recursive: true, force: true });
    }
}

if (failures > 0) {
    console.error(`\n${failures} pipeline check(s) failed`);
    process.exit(1);
}
console.log('\nAll pipeline checks passed');
