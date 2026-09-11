/**
 * modulePaths.test.js (tooling) — the contract that makes `{ ref, src }` entries work
 * end to end: for a source file under src/, the path the runtime resolves it to is the
 * file deezul-build writes AND the URL deezul-dev compiles on request.
 *
 * Builds and serves a throwaway fixture app, so it exercises the real bin scripts.
 */

import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { createServer } from 'net';
import { compiledPath } from '../../src/runtime/modulePaths.js';

const exec = promisify(execFile);
const PKG = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let failures = 0;
function check(name, cond) {
    if (cond) console.log(`  ok    ${name}`);
    else { failures++; console.error(`  FAIL  ${name}`); }
}

const freePort = () => new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

// A top-level file, one subdirectory, and a nested one — the mirroring is the contract.
const SOURCES = ['Top.js', 'component/Probe.js', 'view/nested/Deep.js'];
const COMPONENT = `export default Deezul.Component({
    template: \`<p>{{ msg }}</p>\`,
    data: () => ({ msg: 'hi' })
});
`;

const app = await mkdtemp(join(tmpdir(), 'deezul-src-'));
let dev = null;

try {
    for (const src of SOURCES) {
        const file = join(app, 'src', src);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, COMPONENT);
    }
    await writeFile(join(app, 'index.html'), '<!DOCTYPE html><div id="app"></div>');

    // ── deezul-build writes each component where its src entry resolves ──
    await exec('node', [join(PKG, 'src/build/index.js')], { cwd: app });
    for (const src of SOURCES) {
        const file = join(app, 'dist', compiledPath(src));
        const ok = existsSync(file) && (await readFile(file, 'utf-8')).includes('Compiled component:');
        check(`build writes ${compiledPath(src)}`, ok);
    }

    // ── deezul-dev serves each component at the URL its src entry resolves to ──
    const port = await freePort();
    dev = spawn('node', [join(PKG, 'src/dev-server/index.js')], {
        cwd: app,
        env: { ...process.env, PORT: String(port) }
    });
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('dev server did not start')), 10000);
        dev.stdout.on('data', (d) => { if (String(d).includes('running at')) { clearTimeout(timer); resolve(); } });
        dev.on('exit', (code) => { clearTimeout(timer); reject(new Error(`dev server exited (${code})`)); });
    });

    for (const src of SOURCES) {
        // './compiled/…' is resolved against deezul.esm.js, which dev serves from the app root.
        const url = `http://localhost:${port}/${compiledPath(src).slice(2)}`;
        const res = await fetch(url);
        const body = await res.text();
        check(`dev serves ${compiledPath(src)}`, res.status === 200 && body.includes('Compiled component:'));
    }
} finally {
    if (dev && dev.exitCode === null) {
        const exited = new Promise((resolve) => dev.once('exit', resolve));
        dev.kill();
        await exited;   // the watcher holds the fixture dir open on Windows until exit
    }
    await rm(app, { recursive: true, force: true });
}

if (failures > 0) {
    console.error(`\n${failures} module path check(s) failed`);
    process.exit(1);
}
console.log('\nAll module path checks passed');
