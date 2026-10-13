#!/usr/bin/env node
/**
 * postbuild.js — finish the declaration build.
 *
 * `tsc` generates types/ from the JSDoc in src/runtime, which covers everything the
 * runtime exports. It cannot cover `Deezul.Component`: that is read by the compiler and
 * never exists at runtime, so there is no source for tsc to read. That declaration is
 * hand-written at src/types/globals.d.ts, and this script does the two things that make
 * an app pick it up by installing deezul and nothing else:
 *
 *   1. copies it next to the generated declarations, so the package has one types/ dir;
 *   2. adds a /// <reference> to the type entry, so TypeScript loads it as soon as
 *      anything in the app imports deezul -- which makes the ambient `Deezul` available
 *      to component sources, which import nothing themselves.
 *
 * Run by `npm run types`, which `prepare` runs. Safe to run twice.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

const SOURCE = join(root, 'src', 'types', 'globals.d.ts');
const TYPES_DIR = join(root, 'types');
const TARGET = join(TYPES_DIR, 'globals.d.ts');
const ENTRY = join(TYPES_DIR, 'Deezul.d.ts');
const REFERENCE = '/// <reference path="./globals.d.ts" />';

if (!existsSync(SOURCE)) {
    console.error(`postbuild: ${SOURCE} is missing — nothing to copy.`);
    process.exit(1);
}
if (!existsSync(TYPES_DIR)) mkdirSync(TYPES_DIR, { recursive: true });

copyFileSync(SOURCE, TARGET);

if (!existsSync(ENTRY)) {
    console.error(`postbuild: ${ENTRY} is missing — did tsc run first?`);
    process.exit(1);
}

// tsc rewrites the entry on every build, so the reference is re-added each time rather
// than assumed to still be there.
const entry = readFileSync(ENTRY, 'utf8');
if (!entry.startsWith(REFERENCE)) {
    writeFileSync(ENTRY, `${REFERENCE}\n${entry}`);
}

console.log('types: globals.d.ts copied and referenced from Deezul.d.ts');
