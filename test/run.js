#!/usr/bin/env node
/**
 * Minimal test runner for Deezul tests.
 * Runs each *.test.js file in test/compiler/ and test/runtime/ as a child
 * process. Exit code 0 if all pass, 1 if any fail.
 */

import { readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const exec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

const files = [];
for (const dir of ['compiler', 'runtime']) {
    const testDir = join(__dirname, dir);
    try {
        for (const f of await readdir(testDir)) {
            if (f.endsWith('.test.js')) files.push(join(testDir, f));
        }
    } catch { /* directory may not exist */ }
}

if (files.length === 0) {
    console.log('No test files found.');
    process.exit(0);
}

console.log(`Running ${files.length} test file(s)...\n`);

let passed = 0;
let failed = 0;

for (const filePath of files) {
    const name = filePath.slice(__dirname.length + 1);
    try {
        await exec('node', [filePath], { timeout: 30000 });
        console.log(`  PASS  ${name}`);
        passed++;
    } catch (err) {
        console.error(`  FAIL  ${name}`);
        if (err.stderr) console.error(`        ${err.stderr.trim()}`);
        else if (err.message) console.error(`        ${err.message}`);
        failed++;
    }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
