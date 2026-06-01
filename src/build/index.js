#!/usr/bin/env node
/**
 * deezul-build — production build for a deezul app.
 *
 * Run from a deezul app directory (the one containing src/):
 *   npx deezul-build        # or add "build": "deezul-build" to package.json scripts
 *
 * Compiles each src/<Name>.js component to compiled/<Name>.compiled.js and copies
 * the deezul runtime to ./deezul.esm.js, producing static output that can be
 * served as-is (e.g. by any static file server). The dev server (deezul-dev)
 * does this on the fly and writes nothing; this is only for static deploys.
 *
 * Paths: the app being built is process.cwd() (the consumer), while the runtime
 * bundle is resolved relative to this file (inside the deezul package).
 */
import { readdir, mkdir, writeFile, copyFile } from 'fs/promises';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve, join, basename, extname } from 'path';
import { compileFileToCode } from '../compiler/library/main.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = process.cwd();
const srcDir = resolve(ROOT, 'src');
const outDir = resolve(ROOT, 'compiled');
const runtimeSrc = resolve(__dirname, '../../dist/deezul.esm.js');
const runtimeDest = resolve(ROOT, 'deezul.esm.js');

if (!existsSync(srcDir)) {
    console.error(`deezul-build: no src/ directory found in ${ROOT}`);
    process.exit(1);
}

if (!existsSync(outDir)) await mkdir(outDir, { recursive: true });

// Compile components
const files = (await readdir(srcDir)).filter(f => f.endsWith('.js'));
for (const file of files) {
    const input = join(srcDir, file);
    const output = join(outDir, basename(file, extname(file)) + '.compiled.js');
    const code = await compileFileToCode(input);
    await writeFile(output, code, 'utf-8');
    console.log(`Compiled ${file} -> compiled/${basename(output)}`);
}

// Copy the runtime next to the compiled output
await copyFile(runtimeSrc, runtimeDest);
console.log(`Copied runtime: deezul.esm.js -> ./deezul.esm.js`);

console.log(`\nBuilt ${files.length} component(s).`);
