/**
 * pipeline.js — the build pipeline behind both deezul-build and `deezul-dev --dist`.
 *
 * deezul-build runs it once. `deezul-dev --dist` runs it once at startup and then
 * incrementally on every save, pushing only what changed into dist/. Either way dist/
 * is produced by the same code, so what you test in dev is the build itself rather
 * than an in-memory imitation of it.
 *
 * What lands in dist/:
 *   compiled/**.compiled.js  every component under src/ (paths: runtime/modulePaths.js)
 *   deezul.esm.js            the runtime, from this package
 *   *.html                   every root-level page, dev live-reload lines removed
 *   main.js, *.config.js,
 *   favicon.*                always, as before
 *   assets/**                path-preserving
 *   public/**                copied into the dist root
 *   …and every local file those reference, followed transitively: `import … from`,
 *   `export … from`, `import '…'`, literal `import('…')`, and <script src>, <link href>
 *   and <img src> in pages. Without this, a main.js that imports ./auth-store.js works
 *   in dev and 404s once deployed.
 *
 * Not followed: imports assembled at runtime (import(`./x/${name}.js`)) and URLs a
 * script fetch()es. Put files like that in public/.
 *
 * A write is skipped when the output would not change, so an incremental update
 * touches only the files that actually differ.
 */
import { readdir, mkdir, writeFile, copyFile, readFile, rm, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, resolve, join, relative, extname, basename, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { Parser } from 'htmlparser2';
import { compileFileToCode } from '../compiler/library/main.js';
import { COMPILED_DIR, COMPILED_EXT } from '../runtime/modulePaths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNTIME_SRC = resolve(__dirname, '../../dist/deezul.esm.js');
const RUNTIME_NAME = 'deezul.esm.js';

// Top-level directories that are never app input.
export const IGNORED_DIRS = new Set(['dist', 'node_modules', '.git']);

export const toPosix = (p) => p.split(/[\\/]/).join('/');

// ── Reference extraction ─────────────────────────────────────────────────────

const IMPORT_PATTERNS = [
    /\b(?:import|export)\s[^'"`;]*?\bfrom\s*(['"])([^'"\n]+)\1/g,   // import x from '…' / export … from '…'
    /\bimport\s*(['"])([^'"\n]+)\1/g,                                // import '…'
    /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g                       // import('…')
];

// Only comments that start a line are removed: a commented-out import is the case
// that matters, and a mid-line strip would corrupt strings such as 'https://…' or
// 'image/*'.
const stripComments = (code) => code
    .replace(/^\s*\/\*[\s\S]*?\*\//gm, '')
    .replace(/^\s*\/\/.*$/gm, '');

function jsRefs(code) {
    const text = stripComments(code);
    const refs = [];
    for (const re of IMPORT_PATTERNS) {
        for (const m of text.matchAll(re)) refs.push({ spec: m[2], kind: 'js' });
    }
    return refs;
}

function htmlRefs(html) {
    const refs = [];
    let inlineModule = null;
    const parser = new Parser({
        onopentag(name, attrs) {
            if (name === 'script') {
                if (attrs.src) refs.push({ spec: attrs.src, kind: 'html' });
                else if (attrs.type === 'module') inlineModule = '';
            } else if (name === 'link' && attrs.href) {
                refs.push({ spec: attrs.href, kind: 'html' });
            } else if (name === 'img' && attrs.src) {
                refs.push({ spec: attrs.src, kind: 'html' });
            }
        },
        ontext(text) {
            if (inlineModule !== null) inlineModule += text;
        },
        onclosetag(name) {
            if (name === 'script' && inlineModule !== null) {
                refs.push(...jsRefs(inlineModule));
                inlineModule = null;
            }
        }
    }, { decodeEntities: true });
    parser.write(html);
    parser.end();
    return refs;
}

/**
 * The local file a reference points at, or null for URLs, fragments and packages.
 * In a page, `main.js` is relative; in a script, a bare `deezul` is a package.
 */
function resolveRef(root, { spec, kind }, fromFile) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(spec) || spec.startsWith('//') || spec.startsWith('#')) return null;
    let clean;
    try { clean = decodeURI(spec.split(/[?#]/)[0]); } catch { return null; }
    if (!clean) return null;
    if (clean.startsWith('/')) return join(root, clean);
    if (clean.startsWith('./') || clean.startsWith('../') || kind === 'html') return resolve(dirname(fromFile), clean);
    return null;
}

// ── File helpers ─────────────────────────────────────────────────────────────

async function walk(dir, accept = () => true) {
    const found = [];
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return found; }
    for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) found.push(...await walk(full, accept));
        else if (accept(full)) found.push(full);
    }
    return found;
}

async function writeIfChanged(dest, content) {
    try {
        if ((await readFile(dest, 'utf-8')) === content) return false;
    } catch { /* not there yet */ }
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, content, 'utf-8');
    return true;
}

// Size + mtime rather than content: assets can be large, and copyFile keeps the
// source mtime on Windows while leaving the copy newer elsewhere — unchanged either way.
async function copyIfChanged(src, dest) {
    try {
        const [from, to] = await Promise.all([stat(src), stat(dest)]);
        if (from.size === to.size && to.mtimeMs >= from.mtimeMs) return false;
    } catch { /* not there yet */ }
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(src, dest);
    return true;
}

// ── Pipeline ─────────────────────────────────────────────────────────────────

/**
 * @param {string} root - The app directory (contains index.html and src/)
 * @param {Object} [opts]
 * @param {Function} [opts.log] - Progress output
 * @param {Function} [opts.warn] - Problems that do not stop the build
 * @param {boolean} [opts.tolerant] - Turn component compile errors into a dist module
 *   that reports the error in the browser console, instead of throwing (dev mode)
 */
export function createPipeline(root, { log = console.log, warn = console.warn, tolerant = false } = {}) {
    const srcDir = join(root, 'src');
    const distDir = join(root, 'dist');

    // dist-relative path → source path, for every non-compiled file the last pass shipped.
    let shipped = new Map();

    const compiledDest = (file) => {
        const rel = relative(srcDir, file);
        return join(distDir, COMPILED_DIR, dirname(rel), basename(rel, extname(rel)) + COMPILED_EXT);
    };

    async function compileOne(file) {
        const name = toPosix(relative(srcDir, file));
        let code;
        try {
            code = await compileFileToCode(file);
        } catch (err) {
            if (!tolerant) throw err;
            warn(`[compile] ${name}: ${err.message}`);
            code = `console.error(${JSON.stringify(`Compile error in ${name}: ${err.message}`)});\n`;
        }
        const dest = compiledDest(file);
        const changed = await writeIfChanged(dest, code);
        if (changed) log(`Compiled ${name} -> ${toPosix(relative(distDir, dest))}`);
        return changed;
    }

    // A deleted source file — or a deleted directory, whose compiled mirror goes with it.
    async function removeCompiled(path) {
        const target = extname(path) === '.js'
            ? compiledDest(path)
            : join(distDir, COMPILED_DIR, relative(srcDir, path));
        if (!existsSync(target)) return false;
        await rm(target, { recursive: true, force: true });
        log(`Removed ${toPosix(relative(distDir, target))}`);
        return true;
    }

    /** Every non-compiled file dist/ needs: the fixed members plus what they reference. */
    async function collectShell() {
        const files = new Map();   // source path → dist-relative output
        const queue = [];
        const warnings = [];
        const add = (abs, out = toPosix(relative(root, abs))) => {
            if (files.has(abs)) return;
            files.set(abs, out);
            queue.push(abs);
        };

        for (const entry of await readdir(root, { withFileTypes: true })) {
            if (!entry.isFile()) continue;
            const name = entry.name;
            if (name.endsWith('.html') || name === 'main.js' || /\.config\.js$/.test(name) || /^favicon\.(ico|png|svg)$/.test(name)) {
                add(join(root, name));
            }
        }
        for (const file of await walk(join(root, 'assets'))) add(file);
        for (const file of await walk(join(root, 'public'))) add(file, toPosix(relative(join(root, 'public'), file)));

        while (queue.length) {
            const file = queue.shift();
            const ext = extname(file);
            if (ext !== '.html' && ext !== '.js' && ext !== '.mjs') continue;

            const text = await readFile(file, 'utf-8');
            for (const ref of (ext === '.html' ? htmlRefs(text) : jsRefs(text))) {
                const target = resolveRef(root, ref, file);
                if (!target) continue;

                const rel = relative(root, target);
                const from = toPosix(relative(root, file));
                if (rel.startsWith('..') || isAbsolute(rel)) {
                    warnings.push(`${from} references ${ref.spec}, which is outside the app directory — not shipped`);
                    continue;
                }
                const posix = toPosix(rel);
                const top = posix.split('/')[0];
                // Components ship compiled, the runtime comes from this package, and
                // compiled/ is generated — none of those are copied from the app.
                if (top === 'src' || top === COMPILED_DIR || IGNORED_DIRS.has(top) || posix === RUNTIME_NAME) continue;

                if (!existsSync(target)) {
                    warnings.push(`${from} references ${ref.spec}, which does not exist`);
                    continue;
                }
                if ((await stat(target)).isDirectory()) continue;
                add(target);
            }
        }
        return { files, warnings };
    }

    /** Bring every non-compiled file in dist/ up to date, and drop what is no longer referenced. */
    async function syncShell() {
        const { files, warnings } = await collectShell();
        for (const w of warnings) warn(`deezul: ${w}`);

        const next = new Map();
        let changed = false;
        for (const [src, out] of files) {
            next.set(out, src);
            const dest = join(distDir, out);
            let wrote;
            if (extname(src) === '.html') {
                // Drop the dev-only live-reload line (it points at the dev server's /__reload).
                const html = (await readFile(src, 'utf-8')).split('\n').filter(l => !l.includes('__reload')).join('\n');
                wrote = await writeIfChanged(dest, html);
            } else {
                wrote = await copyIfChanged(src, dest);
            }
            if (wrote) {
                changed = true;
                log(`Copied ${out}`);
            }
        }

        next.set(RUNTIME_NAME, RUNTIME_SRC);
        if (await copyIfChanged(RUNTIME_SRC, join(distDir, RUNTIME_NAME))) {
            changed = true;
            log(`Copied runtime -> ${RUNTIME_NAME}`);
        }

        for (const out of shipped.keys()) {
            if (next.has(out)) continue;
            await rm(join(distDir, out), { force: true });
            changed = true;
            log(`Removed ${out}`);
        }
        shipped = next;
        return changed;
    }

    /** A fresh dist/ from scratch. Returns the number of components compiled. */
    async function buildAll() {
        await rm(distDir, { recursive: true, force: true });
        shipped = new Map();
        const components = await walk(srcDir, (f) => f.endsWith('.js'));
        for (const file of components) await compileOne(file);
        await syncShell();
        return components.length;
    }

    /**
     * Apply changes to dist/. `paths` are absolute paths that were created, edited or
     * deleted. A component recompiles alone; anything else re-syncs the shell, which
     * rewrites only files whose output differs. Returns whether dist/ changed.
     */
    async function update(paths) {
        let changed = false;
        let shellDirty = false;
        for (const path of paths) {
            const rel = relative(root, path);
            if (rel.startsWith('..') || isAbsolute(rel)) continue;
            const top = toPosix(rel).split('/')[0];
            if (IGNORED_DIRS.has(top)) continue;

            if (top === 'src') {
                if (existsSync(path)) {
                    if (extname(path) === '.js' && (await stat(path)).isFile()) changed = (await compileOne(path)) || changed;
                } else {
                    changed = (await removeCompiled(path)) || changed;
                }
            } else {
                shellDirty = true;
            }
        }
        if (shellDirty) changed = (await syncShell()) || changed;
        return changed;
    }

    return { root, srcDir, distDir, buildAll, update };
}
