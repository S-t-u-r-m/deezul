#!/usr/bin/env node
/**
 * Minimal test runner for Deezul compiler tests.
 * Runs each *.test.js file in test/compiler/ as a child process.
 * Exit code 0 if all pass, 1 if any fail.
 */

import { readdir } from 'fs/promises';
import { join, dirname } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const exec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const testDir = join(__dirname, 'compiler');

const files = (await readdir(testDir)).filter(f => f.endsWith('.test.js'));

if (files.length === 0) {
    console.log('No test files found.');
    process.exit(0);
}

console.log(`Running ${files.length} test file(s)...\n`);

let passed = 0;
let failed = 0;

for (const file of files) {
    const filePath = join(testDir, file);
    try {
        await exec('node', [filePath], { timeout: 30000 });
        console.log(`  PASS  ${file}`);
        passed++;
    } catch (err) {
        console.error(`  FAIL  ${file}`);
        if (err.stderr) console.error(`        ${err.stderr.trim()}`);
        else if (err.message) console.error(`        ${err.message}`);
        failed++;
    }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
