#!/usr/bin/env node
/**
 * deezul-dev — zero-config dev server with on-demand compilation.
 *
 * Run from a deezul app directory (the one containing index.html + src/):
 *   npx deezul-dev          # or add "dev": "deezul-dev" to package.json scripts
 *
 * Components are compiled in-process per request — nothing is written to disk.
 * A request for /compiled/<Name>.compiled.js compiles <cwd>/src/<Name>.js on the
 * fly; /deezul.esm.js is served from this package's own dist build. Saving a
 * file pings the browser to reload, which triggers a fresh compile next request.
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const ROOT = process.cwd();
const SRC_DIR = path.join(ROOT, 'src');
const RUNTIME = path.resolve(__dirname, '../../dist/deezul.esm.js');

const MIME = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
};

// ── SSE live reload ──────────────────────────────────────────────────────────

const sseClients = new Set();
const sendReload = () => { for (const res of sseClients) res.write('data: reload\n\n'); };

// A save just pings the browser; the next request recompiles on the fly.
let debounce = null;
if (fs.existsSync(SRC_DIR)) {
    fs.watch(SRC_DIR, { recursive: true }, (_e, filename) => {
        if (!filename || !filename.endsWith('.js')) return;
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
    const m = pathname.match(/^\/compiled\/(.+)\.compiled\.js$/);
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
    let filePath = path.join(ROOT, pathname === '/' ? 'index.html' : pathname);

    // SPA fallback — serve index.html for extensionless routes
    if (!path.extname(filePath)) {
        if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
            filePath = path.join(ROOT, 'index.html');
        }
    }

    try {
        const data = await readFile(filePath);
        res.writeHead(200, {
            'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
            'Cache-Control': 'no-cache',
        });
        res.end(data);
    } catch {
        res.writeHead(404);
        res.end('Not found');
    }
});

server.listen(PORT, () => {
    console.log(`deezul-dev running at http://localhost:${PORT}`);
    console.log(`Serving ${ROOT}`);
    console.log(`Compiling src/ on demand...`);
});
