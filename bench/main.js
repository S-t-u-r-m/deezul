/**
 * Deezul Benchmark Driver
 *
 * Measures reactive DOM update performance using js-framework-benchmark
 * style operations: create, replace, update, append, swap, remove, clear.
 *
 * Timing: performance.now() with double-rAF to include browser layout/paint.
 */

import '/src/runtime/DzComponent.js';
import { componentRegistry } from '/src/runtime/registries.js';
import BenchList from '/bench/BenchList.compiled.js';

// ============================================================================
// SETUP
// ============================================================================

componentRegistry.register('bench-list', BenchList);

let proxy = null;

function waitForMount() {
    return new Promise(resolve => {
        (function check() {
            const el = document.querySelector('dz-component');
            if (el && el.component && el.component.proxy) {
                proxy = el.component.proxy;
                resolve();
            } else {
                setTimeout(check, 50);
            }
        })();
    });
}

// ============================================================================
// DATA GENERATION (js-framework-benchmark compatible)
// ============================================================================

const adjectives = [
    "pretty", "large", "big", "small", "tall", "short", "long", "handsome",
    "plain", "quaint", "clean", "elegant", "easy", "angry", "crazy", "helpful",
    "mushy", "odd", "unsightly", "adorable", "important", "inexpensive",
    "cheap", "expensive", "fancy"
];
const colors = [
    "red", "yellow", "blue", "green", "pink", "brown", "purple",
    "brown", "white", "black", "orange"
];
const nouns = [
    "table", "chair", "house", "bbq", "desk", "car", "pony", "cookie",
    "sandwich", "burger", "pizza", "mouse", "keyboard"
];

function _random(max) {
    return (Math.random() * max) | 0;
}

function buildData(count) {
    const data = new Array(count);
    for (let i = 0; i < count; i++) {
        data[i] =
            adjectives[_random(adjectives.length)] + " " +
            colors[_random(colors.length)] + " " +
            nouns[_random(nouns.length)];
    }
    return data;
}

// ============================================================================
// TIMING
// ============================================================================

function nextFrame() {
    return new Promise(resolve => {
        requestAnimationFrame(() => {
            requestAnimationFrame(resolve);
        });
    });
}

function getRowCount() {
    const el = document.querySelector('dz-component');
    if (!el || !el.shadowRoot) return 0;
    return el.shadowRoot.querySelectorAll('li').length;
}

async function measure(setup, run) {
    // Run setup and wait for render to complete
    if (setup) {
        setup();
        await nextFrame();
    }

    // Measure synchronous JS execution time (framework cost)
    const t0 = performance.now();
    run();
    const tJs = performance.now() - t0;

    // Wait for browser layout + paint, measure total
    await nextFrame();
    const tTotal = performance.now() - t0;

    return { js: tJs, total: tTotal, rows: getRowCount() };
}

// ============================================================================
// BENCHMARK DEFINITIONS
// ============================================================================

const benchmarks = [
    {
        key: "create1k",
        name: "Create 1,000 rows",
        setup: () => { proxy.items = []; },
        run: () => { proxy.items.push(...buildData(1000)); }
    },
    {
        key: "create10k",
        name: "Create 10,000 rows",
        setup: () => { proxy.items = []; },
        run: () => { proxy.items.push(...buildData(10000)); }
    },
    {
        key: "replace1k",
        name: "Replace 1,000 rows",
        setup: () => {
            proxy.items = [];
            proxy.items.push(...buildData(1000));
        },
        run: () => { proxy.items = buildData(1000); }
    },
    {
        key: "append1k",
        name: "Append 1,000 to 1,000",
        setup: () => {
            proxy.items = [];
            proxy.items.push(...buildData(1000));
        },
        run: () => { proxy.items.push(...buildData(1000)); }
    },
    {
        key: "update10th",
        name: "Update every 10th row",
        setup: () => {
            proxy.items = [];
            proxy.items.push(...buildData(1000));
        },
        run: () => {
            // Reassignment triggers forLoopReconcile (updates in-place, no DOM creation)
            const updated = [...proxy.items];
            for (let i = 0; i < updated.length; i += 10) {
                updated[i] = updated[i] + ' !!!';
            }
            proxy.items = updated;
        }
    },
    {
        key: "swapRows",
        name: "Swap rows",
        setup: () => {
            proxy.items = [];
            proxy.items.push(...buildData(1000));
        },
        run: () => {
            // Swap row 1 and 998 via reassignment (triggers forLoopReconcile)
            const swapped = [...proxy.items];
            const temp = swapped[1];
            swapped[1] = swapped[998];
            swapped[998] = temp;
            proxy.items = swapped;
        }
    },
    {
        key: "remove",
        name: "Remove row (middle)",
        setup: () => {
            proxy.items = [];
            proxy.items.push(...buildData(1000));
        },
        run: () => { proxy.items.splice(499, 1); }
    },
    {
        key: "clear",
        name: "Clear 1,000 rows",
        setup: () => {
            proxy.items = [];
            proxy.items.push(...buildData(1000));
        },
        run: () => { proxy.items = []; }
    }
];

// ============================================================================
// UI
// ============================================================================

const results = {};
const statusEl = document.getElementById('status');
const rowCountEl = document.getElementById('row-count');
const resultsBody = document.getElementById('results-body');
let running = false;

function setStatus(msg) {
    statusEl.textContent = msg;
}

function updateRowCount() {
    rowCountEl.textContent = getRowCount();
}

function timeClass(ms) {
    if (ms < 50) return 'time-fast';
    if (ms < 200) return 'time-med';
    return 'time-slow';
}

function renderResults() {
    resultsBody.innerHTML = '';
    for (const bench of benchmarks) {
        const r = results[bench.key];
        const tr = document.createElement('tr');
        if (r) {
            tr.innerHTML =
                `<td>${bench.name}</td>` +
                `<td class="${timeClass(r.js)}">${r.js.toFixed(1)} ms</td>` +
                `<td>${r.total.toFixed(1)} ms</td>` +
                `<td>${r.rows}</td>`;
        } else {
            tr.innerHTML =
                `<td>${bench.name}</td>` +
                `<td>&mdash;</td>` +
                `<td>&mdash;</td>` +
                `<td>&mdash;</td>`;
        }
        resultsBody.appendChild(tr);
    }
}

function setButtonsDisabled(disabled) {
    document.querySelectorAll('.controls button').forEach(b => b.disabled = disabled);
}

async function runSingle(key) {
    if (running) return;
    running = true;
    setButtonsDisabled(true);

    const bench = benchmarks.find(b => b.key === key);
    if (!bench) { running = false; setButtonsDisabled(false); return; }

    setStatus(`Running: ${bench.name}...`);
    const r = await measure(bench.setup, bench.run);
    results[bench.key] = r;
    updateRowCount();
    renderResults();
    setStatus(`Done: ${bench.name} — ${r.js.toFixed(1)} ms JS, ${r.total.toFixed(1)} ms total`);
    console.log(`[bench] ${bench.name}: ${r.js.toFixed(1)} ms JS | ${r.total.toFixed(1)} ms total (${r.rows} rows)`);

    running = false;
    setButtonsDisabled(false);
}

async function runAll() {
    if (running) return;
    running = true;
    setButtonsDisabled(true);

    for (const bench of benchmarks) {
        setStatus(`Running: ${bench.name}...`);
        const r = await measure(bench.setup, bench.run);
        results[bench.key] = r;
        updateRowCount();
        renderResults();
        console.log(`[bench] ${bench.name}: ${r.js.toFixed(1)} ms JS | ${r.total.toFixed(1)} ms total (${r.rows} rows)`);
        await nextFrame();
    }

    // Print summary
    console.log('\n--- Benchmark Summary ---');
    for (const bench of benchmarks) {
        const r = results[bench.key];
        if (r) console.log(`${bench.name.padEnd(28)} ${r.js.toFixed(1).padStart(8)} ms JS  ${r.total.toFixed(1).padStart(8)} ms total`);
    }
    console.log('-------------------------\n');

    setStatus('All benchmarks complete.');
    running = false;
    setButtonsDisabled(false);
}

async function warmup() {
    if (running) return;
    running = true;
    setButtonsDisabled(true);
    setStatus('Warming up (JIT compilation)...');

    // Run each benchmark once silently to warm up JIT
    for (const bench of benchmarks) {
        if (bench.setup) {
            bench.setup();
            await nextFrame();
        }
        bench.run();
        await nextFrame();
    }

    // Reset
    proxy.items = [];
    await nextFrame();
    updateRowCount();
    setStatus('Warmup complete. Ready to benchmark.');
    running = false;
    setButtonsDisabled(false);
}

// ============================================================================
// INITIALIZATION
// ============================================================================

renderResults();

waitForMount().then(() => {
    setStatus('Ready.');
    updateRowCount();

    // Wire buttons
    document.getElementById('btn-runAll').addEventListener('click', runAll);
    document.getElementById('btn-warmup').addEventListener('click', warmup);

    for (const bench of benchmarks) {
        const btn = document.getElementById(`btn-${bench.key}`);
        if (btn) btn.addEventListener('click', () => runSingle(bench.key));
    }
});
