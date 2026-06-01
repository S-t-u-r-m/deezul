#!/usr/bin/env node
/**
 * deezul-build — production build for a deezul app.
 *
 * Run from a deezul app directory (the one containing index.html + src/):
 *   npx deezul-build        # or add "build": "deezul-build" to package.json scripts
 *
 * Assembles a self-contained, hostable dist/ folder:
 *   dist/
 *     index.html            (app shell, dev live-reload script stripped)
 *     main.js, *.config.js  (app entry + configs)
 *     favicon.*             (if present)
 *     deezul.esm.js         (runtime, from this package's dist)
 *     compiled/*.compiled.js (components compiled from src/)
 *     <public/ contents>    (copied verbatim if a public/ dir exists)
 *
 * Deploying is then just: upload dist/ (or serve it). Nothing else is needed —
 * src/, node_modules/, and package files do not ship.
 *
 * Paths: the app being built is process.cwd() (the consumer); the runtime bundle
 * is resolved relative to this file (inside the deezul package).
 */
import { readdir, mkdir, writeFile, copyFile, readFile, rm, cp } from 'fs/promises';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve, join, basename, extname } from 'path';
import { compileFileToCode } from '../compiler/library/main.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = process.cwd();
const srcDir = resolve(ROOT, 'src');
const distDir = resolve(ROOT, 'dist');
const compiledDir = resolve(distDir, 'compiled');
const runtimeSrc = resolve(__dirname, '../../dist/deezul.esm.js');

if (!existsSync(srcDir)) {
    console.error(`deezul-build: no src/ directory found in ${ROOT}`);
    process.exit(1);
}

// Fresh dist/ every build
await rm(distDir, { recursive: true, force: true });
await mkdir(compiledDir, { recursive: true });

// 1. Compile components -> dist/compiled/
const files = (await readdir(srcDir)).filter(f => f.endsWith('.js'));
for (const file of files) {
    const code = await compileFileToCode(join(srcDir, file));
    const out = basename(file, extname(file)) + '.compiled.js';
    await writeFile(join(compiledDir, out), code, 'utf-8');
    console.log(`Compiled ${file} -> compiled/${out}`);
}

// 2. Runtime -> dist/deezul.esm.js
await copyFile(runtimeSrc, join(distDir, 'deezul.esm.js'));
console.log(`Copied runtime -> deezul.esm.js`);

// 3. App shell: index.html (reload line stripped), main.js, *.config.js, favicon.*
//    plus a public/ directory copied verbatim if present.
const entries = await readdir(ROOT, { withFileTypes: true });
for (const e of entries) {
    if (e.isFile()) {
        const name = e.name;
        if (name === 'index.html') {
            const html = await readFile(join(ROOT, name), 'utf-8');
            // Drop the dev-only live-reload line (it points at the dev server's /__reload).
            const stripped = html.split('\n').filter(l => !l.includes('__reload')).join('\n');
            await writeFile(join(distDir, name), stripped, 'utf-8');
            console.log(`Copied index.html (live-reload stripped)`);
        } else if (name === 'main.js' || /\.config\.js$/.test(name) || /^favicon\.(ico|png|svg)$/.test(name)) {
            await copyFile(join(ROOT, name), join(distDir, name));
            console.log(`Copied ${name}`);
        }
    } else if (e.isDirectory() && e.name === 'public') {
        await cp(join(ROOT, 'public'), distDir, { recursive: true });
        console.log(`Copied public/ -> dist/`);
    }
}

console.log(`\nBuilt ${files.length} component(s) -> dist/  (ready to host)`);
