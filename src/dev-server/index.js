#!/usr/bin/env node
/**
 * deezul-dev — zero-config dev server.
 *
 * Run from a deezul app directory (the one containing index.html + src/):
 *   npx deezul-dev          # or add "dev": "deezul-dev" to package.json scripts
 *   npx deezul-dev --dist   # serve the real build, rebuilt on every save
 *
 * SOURCE MODE (default)
 * Components are compiled in-process per request — nothing is written to disk.
 * A request for /compiled/<Name>.compiled.js compiles <cwd>/src/<Name>.js on the
 * fly; /deezul.esm.js is served from this package's own dist build; everything else
 * is served from the app directory. Saving a file pings the browser to reload, which
 * triggers a fresh compile next request.
 *
 * DIST MODE (--dist)
 * Runs the same pipeline as deezul-build once at startup, then serves dist/. Every
 * save pushes only what changed into dist/ — one component recompiled, or the pages,
 * scripts and assets they reference re-synced — then reloads the browser. What you
 * test is exactly what deploys: a file the build would leave out 404s here too. The
 * live-reload script is added to pages as they are served, so it never has to be
 * written into index.html.
 *
 * In both modes /compiled/<Name>.compiled.js is exactly what a `{ ref, src: '<Name>.js' }`
 * module entry resolves to: the convention is owned by src/runtime/modulePaths.js,
 * shared with the runtime and deezul-build, so apps name source files and never write
 * compiled paths.
 *
 * Paths: the served app lives at process.cwd() (the consumer), while the runtime
 * bundle is resolved relative to this file (inside the deezul package).
 */
import http from 'http';
import fs from 'fs';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { compileFileToCode } from '../compiler/library/main.js';
import { COMPILED_DIR, COMPILED_EXT } from '../runtime/modulePaths.js';
import { createPipeline, IGNORED_DIRS, toPosix } from '../build/pipeline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const ROOT = process.cwd();
const SRC_DIR = path.join(ROOT, 'src');
const DIST_DIR = path.join(ROOT, 'dist');
const RUNTIME = path.resolve(__dirname, '../../dist/deezul.esm.js');
const DIST_MODE = process.argv.includes('--dist');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const COMPILED_URL = new RegExp(`^/${escapeRe(COMPILED_DIR)}/(.+)${escapeRe(COMPILED_EXT)}$`);

const MIME = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.mjs': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.map': 'application/json',
    '.txt': 'text/plain',
    '.xml': 'application/xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
};

// ── SSE live reload ──────────────────────────────────────────────────────────

const sseClients = new Set();
const sendReload = () => { for (const res of sseClients) res.write('data: reload\n\n'); };

// Connected after the load event on purpose: the stream never completes, and one
// opened before load keeps the browser tab's loading spinner turning forever.
const RELOAD_SCRIPT = `<script>addEventListener('load', () => { if (!location.search.includes('noreload')) new EventSource('/__reload').onmessage = () => location.reload(); });</script>`;

function injectReload(html) {
    const at = html.lastIndexOf('</body>');
    return at === -1 ? html + RELOAD_SCRIPT : html.slice(0, at) + RELOAD_SCRIPT + '\n' + html.slice(at);
}

/**
 * Watch a directory tree. Tries native fs.watch (recursive) first; recursive
 * watching is unavailable on network/mapped drives on Windows (FSWatcher dies with
 * UNKNOWN errno -4094), so on failure we fall back to polling file mtimes once a
 * second. `accept(fullPath)` decides which file changes count and `descend(dirPath)`
 * which directories polling walks into; onChange receives absolute paths — including
 * for deletions.
 */
function watchTree(dir, { accept, descend = () => true }, onChange) {
    const POLL_MS = 1000;

    const startPolling = () => {
        console.log('[watch] fs.watch unavailable (network drive?) — polling for changes instead');
        let mtimes = new Map();
        const scan = (d, seen, fire) => {
            let entries;
            try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
            for (const entry of entries) {
                const full = path.join(d, entry.name);
                if (entry.isDirectory()) {
                    if (descend(full)) scan(full, seen, fire);
                } else if (accept(full)) {
                    let mtime;
                    try { mtime = fs.statSync(full).mtimeMs; } catch { continue; }
                    seen.set(full, mtime);
                    if (fire && mtimes.get(full) !== mtime) onChange(full);
                }
            }
        };
        const tick = (fire) => {
            const seen = new Map();
            scan(dir, seen, fire);
            if (fire) for (const full of mtimes.keys()) if (!seen.has(full)) onChange(full);
            mtimes = seen;
        };
        tick(false); // prime mtimes without firing
        setInterval(() => tick(true), POLL_MS).unref();
    };

    try {
        const watcher = fs.watch(dir, { recursive: true }, (_e, filename) => {
            if (!filename) return;
            const full = path.join(dir, filename);
            if (accept(full)) onChange(full);
        });
        // The UNKNOWN error arrives asynchronously — without this handler it
        // crashes the whole process.
        watcher.on('error', () => {
            watcher.close();
            startPolling();
        });
    } catch {
        startPolling();
    }
}

// ── Source mode ──────────────────────────────────────────────────────────────

async function serveSource(res, pathname) {
    // Serve the deezul runtime straight from this package (no copy step).
    if (pathname === '/deezul.esm.js') {
        try {
            const data = await readFile(RUNTIME);
            res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' });
            res.end(data);
        } catch {
            res.writeHead(404);
            res.end('Runtime not found — build deezul (dist/deezul.esm.js) first.');
        }
        return;
    }

    // On-demand compile: /compiled/<Name>.compiled.js  ⇐  <cwd>/src/<Name>.js
    const m = pathname.match(COMPILED_URL);
    if (m) {
        const srcPath = path.join(SRC_DIR, `${m[1]}.js`);
        try {
            const code = await compileFileToCode(srcPath); // returns a string, in memory
            res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' });
            res.end(code);
        } catch (err) {
            // Surface the compile error to the browser console instead of a blank failure.
            console.error(`[compile] ${m[1]}.js:`, err.message);
            res.writeHead(500, { 'Content-Type': 'application/javascript' });
            res.end(`console.error(${JSON.stringify(`Compile error in ${m[1]}.js: ${err.message}`)});`);
        }
        return;
    }

    // Static files (index.html, main.js, configs, assets) from the app dir
    await serveStatic(res, ROOT, pathname, (html) => html);
}

// ── Static serving (both modes) ──────────────────────────────────────────────

async function serveStatic(res, base, pathname, transformHtml) {
    let filePath = path.join(base, pathname === '/' ? 'index.html' : pathname);

    // SPA fallback — serve index.html for extensionless routes
    if (!path.extname(filePath)) {
        if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
            filePath = path.join(base, 'index.html');
        }
    }

    try {
        const ext = path.extname(filePath);
        let data = await readFile(filePath);
        if (ext === '.html') data = transformHtml(data.toString('utf-8'));
        res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Cache-Control': 'no-cache',
        });
        res.end(data);
    } catch {
        res.writeHead(404);
        res.end('Not found');
    }
}

// ── Startup ──────────────────────────────────────────────────────────────────

if (DIST_MODE) {
    if (!fs.existsSync(SRC_DIR)) {
        console.error(`deezul-dev --dist: no src/ directory found in ${ROOT}`);
        process.exit(1);
    }

    // Tolerant: a component that fails to compile mid-edit reports in the browser
    // console rather than taking the server down.
    const pipeline = createPipeline(ROOT, { tolerant: true });
    const count = await pipeline.buildAll();
    console.log(`Built ${count} component(s) -> dist/`);

    // Everything in the app except generated and installed trees is build input.
    const isAppInput = (full) => {
        const rel = path.relative(ROOT, full);
        return !rel.startsWith('..') && !IGNORED_DIRS.has(toPosix(rel).split('/')[0]);
    };

    // Saves arrive in bursts (editors write temp files, renames fire twice): collect
    // them, then apply one update at a time so passes never interleave.
    const pending = new Set();
    let debounce = null;
    let queue = Promise.resolve();
    watchTree(ROOT, { accept: isAppInput, descend: isAppInput }, (full) => {
        pending.add(full);
        clearTimeout(debounce);
        debounce = setTimeout(() => {
            const batch = [...pending];
            pending.clear();
            queue = queue
                .then(async () => { if (await pipeline.update(batch)) sendReload(); })
                .catch((err) => console.error('[dist]', err.message));
        }, 100);
    });
} else if (fs.existsSync(SRC_DIR)) {
    // A save just pings the browser; the next request recompiles on the fly.
    let debounce = null;
    watchTree(SRC_DIR, { accept: (full) => full.endsWith('.js') }, () => {
        clearTimeout(debounce);
        debounce = setTimeout(sendReload, 100);
    });
}

// ── HTTP server ────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
    // Route on the path only — strip the query string (e.g. ?noreload) so it
    // doesn't become part of the looked-up filename.
    const pathname = new URL(req.url, 'http://localhost').pathname;

    // SSE endpoint for live reload
    if (pathname === '/__reload') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        });
        res.write('\n');
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
    }

    if (DIST_MODE) await serveStatic(res, DIST_DIR, pathname, injectReload);
    else await serveSource(res, pathname);
});

server.listen(PORT, () => {
    console.log(`deezul-dev running at http://localhost:${PORT}`);
    if (DIST_MODE) {
        console.log(`Serving ${DIST_DIR}`);
        console.log(`Rebuilding changed files into dist/ on save...`);
    } else {
        console.log(`Serving ${ROOT}`);
        console.log(`Compiling src/ on demand...`);
    }
});
