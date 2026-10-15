/**
 * sourceHygiene.test.js (tooling) — no source file contains a character you cannot see.
 *
 * A regex literal in templateCheck.js once held a literal 0x08, left where a `\b` had
 * been mangled by tooling on the way in. It cost an hour: the file read back looking
 * exactly right, the function silently matched nothing, and editors render the byte as
 * nothing at all. Several escape-mangling incidents in one sitting produced it, and
 * nothing in the repository would have noticed another.
 *
 * So this walks the source and refuses control characters other than tab, newline and
 * carriage return. It is cheap, it runs with the rest of the suite, and it turns a class
 * of invisible bug into a named line number.
 */

import { readdir, readFile } from 'fs/promises';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOTS = ['src', 'test', 'tooling', 'examples'];
const IGNORED = new Set(['node_modules', 'dist', 'types', 'compiled', '.git', 'archive', '_shots']);
const TEXT = /\.(js|mjs|cjs|json|md|ts|css|html|yml|yaml)$/;

/** Tab, newline and carriage return are the only control characters text needs. */
const ALLOWED = new Set([9, 10, 13]);

let failures = 0;
function check(name, cond) {
    if (cond) console.log(`  ok    ${name}`);
    else { failures++; console.error(`  FAIL  ${name}`); }
}

async function walk(dir, out = []) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
    for (const entry of entries) {
        if (entry.name.startsWith('.') || IGNORED.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full, out);
        else if (TEXT.test(entry.name)) out.push(full);
    }
    return out;
}

const files = (await Promise.all(ROOTS.map((r) => walk(join(PKG, r))))).flat();
check('there is source to check', files.length > 20);

const offenders = [];
for (const file of files) {
    const text = await readFile(file, 'utf8');
    let line = 1;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code === 10) { line++; continue; }
        if (code < 32 && !ALLOWED.has(code)) {
            offenders.push(`${relative(PKG, file)}:${line} contains 0x${code.toString(16).padStart(2, '0')}`);
            break;  // one report per file is enough to go and look
        }
    }
}

for (const o of offenders) console.error(`        ${o}`);
check(`no invisible control characters (${files.length} files)`, offenders.length === 0);

if (failures > 0) {
    console.error(`\n  ${failures} failure(s)`);
    process.exit(1);
}
