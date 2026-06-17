/**
 * Krausest-style benchmark harness.
 *
 * Identical operations + data across all framework adapters. Each adapter
 * exposes `mount(el)` returning an `ops` object; the harness wires those ops
 * to UI buttons AND drives them programmatically for benchmark measurement.
 *
 * Methodology: each op runs N+1 times (one warmup, N measured). For each
 * measured run, t0 = perf.now() before run(), then a single rAF + perf.now()
 * after for total wall-clock. We report the MEDIAN across measured runs to
 * suppress single-sample noise — krausest does similar (3-10 iterations,
 * uses median or sorted-min-of-N).
 *
 * NOT identical to the official krausest harness (which uses Puppeteer +
 * CDP paint timing). This is "comparable within this page" only.
 */

const ITERATIONS = 5;
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

let nextId = 1;
function rand(max) { return Math.floor(Math.random() * max); }

export function buildData(count) {
    const data = new Array(count);
    for (let i = 0; i < count; i++) {
        data[i] = {
            id: nextId++,
            label: adjectives[rand(adjectives.length)] + ' ' +
                   colors[rand(colors.length)] + ' ' +
                   nouns[rand(nouns.length)]
        };
    }
    return data;
}

export function resetIdCounter() { nextId = 1; }

function median(arr) {
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Standard krausest operations, parameterised by an `ops` object the adapter provides.
 * Each entry describes setup + run for one measured operation.
 */
function buildBenchmarks(ops) {
    return [
        {
            key: 'run',
            name: 'Create 1,000 rows',
            setup: () => { ops.clear(); },
            run: () => { ops.run(); }
        },
        {
            key: 'runlots',
            name: 'Create 10,000 rows',
            setup: () => { ops.clear(); },
            run: () => { ops.runLots(); }
        },
        {
            key: 'runhuge',
            name: 'Create 50,000 rows',
            setup: () => { ops.clear(); },
            run: () => { ops.runHuge(); }
        },
        {
            key: 'add',
            name: 'Append 1,000 to 1,000',
            setup: () => { ops.clear(); ops.run(); },
            run: () => { ops.add(); }
        },
        {
            key: 'update',
            name: 'Update every 10th row (1,000)',
            setup: () => { ops.clear(); ops.run(); },
            run: () => { ops.update(); }
        },
        {
            key: 'swap',
            name: 'Swap rows',
            setup: () => { ops.clear(); ops.run(); },
            run: () => { ops.swapRows(); }
        },
        {
            key: 'remove',
            name: 'Remove row (middle)',
            setup: () => { ops.clear(); ops.run(); },
            run: () => { ops.remove(ops.getMiddleId()); }
        },
        {
            key: 'clear',
            name: 'Clear 1,000 rows',
            setup: () => { ops.clear(); ops.run(); },
            run: () => { ops.clear(); }
        }
    ];
}

/**
 * Wait until the frame AFTER next paint. Double-rAF is the only measurement
 * that's fair across all four frameworks here:
 *
 *   - Microtask-only drains catch Vue/Deezul/Solid but miss React's MessageChannel.
 *   - MessageChannel yields catch React's scheduler but ALSO trigger browser
 *     layout/paint for whoever already finished — leading to wildly asymmetric
 *     numbers (Deezul finishes pre-layout, React's scheduler interleaves with
 *     layout, so React gets charged for layout time and Deezul doesn't).
 *
 * Double-rAF captures "DOM is rendered AND painted" uniformly for everyone.
 * Cost: ~33ms floor (two frames at 60Hz). For ops that take longer than that,
 * the floor is irrelevant. For ops that finish in <33ms, all frameworks tie
 * at the floor — which is the honest answer ("we can't distinguish them").
 */
function waitForPaint() {
    return new Promise(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
}

async function measureOnce(setup, run) {
    if (setup) {
        setup();
        // Settle setup before measuring: wait for paint so the DOM is in a
        // known visible state before t0. Critical for fast frameworks that
        // could otherwise overlap setup + measured work in one paint cycle.
        await waitForPaint();
    }
    const t0 = performance.now();
    run();
    const tJs = performance.now() - t0;
    await waitForPaint();
    const tFlush = performance.now() - t0;
    return { js: tJs, total: tFlush };
}

async function runBenchmark(bench, iterations) {
    // 1 untimed warmup to settle JIT
    await measureOnce(bench.setup, bench.run);

    const samples = [];
    for (let i = 0; i < iterations; i++) {
        samples.push(await measureOnce(bench.setup, bench.run));
    }
    return {
        jsMedian: median(samples.map(s => s.js)),
        jsMin: Math.min(...samples.map(s => s.js)),
        totalMedian: median(samples.map(s => s.total)),
        totalMin: Math.min(...samples.map(s => s.total)),
        samples: samples.length
    };
}

// ───────────────────────────────── UI ─────────────────────────────────

const FRAMEWORKS = {
    deezul: () => import('./deezul/adapter.js'),
    react: () => import('./react/adapter.js'),
    vue: () => import('./vue/adapter.js'),
    solid: () => import('./solid/adapter.js')
};

let currentAdapter = null;
let currentOps = null;
const results = {};   // { framework: { opKey: stats } }

function el(id) { return document.getElementById(id); }

function timeClass(ms) {
    if (ms < 5) return 'time-fast';
    if (ms < 50) return 'time-med';
    return 'time-slow';
}

function renderResults() {
    const frameworks = Object.keys(results);
    if (frameworks.length === 0) {
        el('results').innerHTML = '<p class="muted">No results yet. Pick a framework and click Run All.</p>';
        return;
    }

    // Discover op keys (use bench order from any framework that ran)
    const opOrder = ['run', 'runlots', 'runhuge', 'add', 'update', 'swap', 'remove', 'clear'];
    const opNames = {
        run: 'Create 1k', runlots: 'Create 10k', runhuge: 'Create 50k', add: 'Append 1k',
        update: 'Update 10th', swap: 'Swap', remove: 'Remove', clear: 'Clear'
    };

    let html = '<table><thead><tr><th>Operation</th>';
    for (const f of frameworks) html += `<th>${f} (wall-clock median)</th>`;
    html += '</tr></thead><tbody>';

    for (const op of opOrder) {
        html += `<tr><td>${opNames[op]}</td>`;
        for (const f of frameworks) {
            const r = results[f]?.[op];
            if (r) {
                // Wall-clock total (sync work + microtask + rAF + paint) — the only
                // metric that's comparable across React/Vue/Deezul, since their
                // schedulers defer different amounts of work past synchronous return.
                // "Total" here is now microtask-drained framework time (no rAF floor).
                html += `<td class="${timeClass(r.totalMedian)}">${r.totalMedian.toFixed(2)} ms <span class="muted">(min ${r.totalMin.toFixed(2)}, sync ${r.jsMedian.toFixed(2)})</span></td>`;
            } else {
                html += '<td>—</td>';
            }
        }
        html += '</tr>';
    }
    html += '</tbody></table>';
    el('results').innerHTML = html;
}

async function selectFramework(name) {
    if (currentAdapter && currentAdapter.unmount) {
        currentAdapter.unmount();
    }
    el('mount').innerHTML = '';
    el('status').textContent = `Loading ${name}…`;

    const mod = await FRAMEWORKS[name]();
    currentAdapter = mod.default;
    currentOps = await currentAdapter.mount(el('mount'));

    el('current-fw').textContent = name;
    el('status').textContent = `Ready (${name}).`;

    document.querySelectorAll('.fw-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.fw === name);
    });
}

async function runAll() {
    if (!currentOps) {
        el('status').textContent = 'Pick a framework first.';
        return;
    }
    const fw = el('current-fw').textContent;
    el('status').textContent = `Running ${fw} benchmarks…`;
    document.querySelectorAll('button').forEach(b => b.disabled = true);

    const benchmarks = buildBenchmarks(currentOps);
    if (!results[fw]) results[fw] = {};

    for (const bench of benchmarks) {
        el('status').textContent = `${fw}: ${bench.name}…`;
        results[fw][bench.key] = await runBenchmark(bench, ITERATIONS);
        renderResults();
        updateRowCount();
    }

    el('status').textContent = `${fw}: done (${ITERATIONS} iterations each, showing median).`;
    document.querySelectorAll('button').forEach(b => b.disabled = false);
}

function clearResults() {
    for (const k of Object.keys(results)) delete results[k];
    renderResults();
    el('status').textContent = 'Results cleared.';
}

// Count rendered <tr> elements anywhere in the mount tree (including Shadow DOM).
// Walks descendants and pierces open shadow roots so Deezul's shadow-rendered
// rows are also counted.
function countRenderedRows() {
    const root = el('mount');
    if (!root) return 0;
    let count = 0;
    function walk(node) {
        if (node.nodeType === 1) {
            if (node.tagName === 'TR') count++;
            if (node.shadowRoot) walk(node.shadowRoot);
        }
        for (let i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i]);
    }
    walk(root);
    return count;
}

function updateRowCount() {
    el('row-count').textContent = countRenderedRows();
}

async function runManualOp(opKey) {
    if (!currentOps) {
        el('status').textContent = 'Pick a framework first.';
        return;
    }
    const opMap = {
        run: 'Create 1k', runLots: 'Create 10k', runHuge: 'Create 50k', add: 'Append 1k',
        update: 'Update 10th', swapRows: 'Swap', remove: 'Remove mid', clear: 'Clear'
    };
    el('status').textContent = `Running ${opMap[opKey]}…`;

    // 'remove' needs a target id; pick the middle row.
    if (opKey === 'remove') {
        const id = currentOps.getMiddleId();
        if (id == null) { el('status').textContent = 'No rows to remove.'; return; }
        currentOps.remove(id);
    } else {
        currentOps[opKey]();
    }

    // Wait for paint so the row count reflects the post-op DOM.
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    updateRowCount();
    el('status').textContent = `${opMap[opKey]} done.`;
}

// Wire UI
window.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.fw-btn').forEach(b => {
        b.addEventListener('click', () => selectFramework(b.dataset.fw));
    });
    document.querySelectorAll('.op-btn').forEach(b => {
        b.addEventListener('click', () => runManualOp(b.dataset.op));
    });
    el('run-all').addEventListener('click', runAll);
    el('clear-results').addEventListener('click', clearResults);

    // Default to Deezul on load
    selectFramework('deezul');
});
