import http from 'http';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3000;
const ROOT = __dirname;
const SRC_DIR = path.join(__dirname, 'src');
const COMPILED_DIR = path.join(__dirname, 'compiled');
const COMPILER = path.join(__dirname, 'compiler', 'cli.js');

const MIME = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
};

// ── SSE clients for live reload ──────────────────────────────────────────────

const sseClients = new Set();

function sendReload() {
    for (const res of sseClients) {
        res.write('data: reload\n\n');
    }
}

// ── Auto-compile on file change ──────────────────────────────────────────────

let debounceTimer = null;

fs.watch(SRC_DIR, { recursive: true }, (eventType, filename) => {
    if (!filename || !filename.endsWith('.js')) return;

    // Debounce rapid saves
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        const name = path.basename(filename, '.js');
        const input = path.join(SRC_DIR, filename);
        const output = path.join(COMPILED_DIR, `${name}.compiled.js`);

        console.log(`[watch] Changed: ${filename}`);
        try {
            execSync(`node "${COMPILER}" "${input}" "${output}"`, { stdio: 'pipe' });
            console.log(`[watch] Compiled: ${name}.compiled.js`);
            sendReload();
        } catch (err) {
            console.error(`[watch] Compile error:`, err.stderr?.toString() || err.message);
        }
    }, 100);
});

// ── HTTP server ──────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
    // SSE endpoint for live reload
    if (req.url === '/__reload') {
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

    let filePath = path.join(ROOT, req.url === '/' ? 'index.html' : req.url);

    // SPA fallback — serve index.html for routes without file extensions
    if (!path.extname(filePath)) {
        const exists = fs.existsSync(filePath);
        if (!exists || fs.statSync(filePath).isDirectory()) {
            filePath = path.join(ROOT, 'index.html');
        }
    }

    const ext = path.extname(filePath);
    const contentType = MIME[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not found');
            return;
        }
        res.writeHead(200, {
            'Content-Type': contentType,
            'Cache-Control': 'no-cache',
        });
        res.end(data);
    });
});

server.listen(PORT, () => {
    console.log(`Deezul dev server running at http://localhost:${PORT}`);
    console.log(`Watching src/ for changes...`);
});
