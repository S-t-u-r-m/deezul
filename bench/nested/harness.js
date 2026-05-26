/**
 * Nested-tree benchmark harness.
 *
 * Tests reactivity on a depth-3 tree where each node = { id, label, expanded, children }.
 * Collapsed children are unmounted via conditional render (not hidden via display:none),
 * so the framework actually pays mount/unmount cost on expand-collapse ops.
 *
 * Measurement methodology mirrors krausest harness in this repo: 1 warmup run +
 * `ITERATIONS` measured, double-rAF after each run to capture full paint, report
 * median of measured runs.
 *
 * Fixed-fanout fixtures (so results are reproducible):
 *   small:  10 × 10 × 10 = 1,000 leaves   (1,110 total nodes)
 *   large:  50 × 10 × 10 = 5,000 leaves   (5,550 total nodes)
 */

const ITERATIONS = 5;
const adjectives = ['pretty','large','big','small','tall','short','long','handsome','plain','quaint'];
const colors = ['red','yellow','blue','green','pink','brown','purple','white','black','orange'];
const nouns = ['table','chair','house','bbq','desk','car','pony','cookie','mouse','keyboard'];

let nextId = 1;
function rand(max) { return Math.floor(Math.random() * max); }
function makeLabel() {
    return adjectives[rand(adjectives.length)] + ' ' +
           colors[rand(colors.length)] + ' ' +
           nouns[rand(nouns.length)];
}

/**
 * Build a depth-3 tree with the given fanout. Total nodes = roots + roots*mids + roots*mids*leaves.
 * All nodes start `expanded: true` so create benchmarks render the full tree (not just roots).
 */
export function buildTree(roots, mids, leaves) {
    const out = new Array(roots);
    for (let i = 0; i < roots; i++) {
        const root = { id: nextId++, label: makeLabel(), expanded: true, children: new Array(mids) };
        for (let j = 0; j < mids; j++) {
            const mid = { id: nextId++, label: makeLabel(), expanded: true, children: new Array(leaves) };
            for (let k = 0; k < leaves; k++) {
                mid.children[k] = { id: nextId++, label: makeLabel(), expanded: true, children: [] };
            }
            root.children[j] = mid;
        }
        out[i] = root;
    }
    return out;
}

export function resetIdCounter() { nextId = 1; }

function median(arr) {
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

// Tree shapes — kept here so adapters and harness agree.
const SMALL = { roots: 10,  mids: 10, leaves: 10 };   // 1,110 nodes
const LARGE = { roots: 50,  mids: 10, leaves: 10 };   // 5,550 nodes
const HUGE  = { roots: 100, mids: 10, leaves: 10 };   // 11,100 nodes (10,000 leaves)

/**
 * Benchmark suite. Each entry: { key, name, setup, run }.
 * `setup` puts the tree into the expected starting state; `run` is what we time.
 * Setup runs before each measured iteration AND once for warmup.
 *
 * Workloads are sized to push above the ~33ms double-rAF paint floor — single-
 * node ops on small trees end up indistinguishable from instant. Each op
 * batches enough work to actually measure framework cost.
 */
function buildBenchmarks(ops) {
    // Reusable starter: huge tree, fully expanded (11,100 nodes).
    const seedHuge = () => { ops.clear(); ops.createHuge(); };

    return [
        {
            key: 'createSmall',
            name: 'Create small tree (1,110 nodes)',
            setup: () => { ops.clear(); },
            run: () => { ops.createSmall(); }
        },
        {
            key: 'createLarge',
            name: 'Create large tree (5,550 nodes)',
            setup: () => { ops.clear(); },
            run: () => { ops.createLarge(); }
        },
        {
            key: 'createHuge',
            name: 'Create huge tree (11,100 nodes)',
            setup: () => { ops.clear(); },
            run: () => { ops.createHuge(); }
        },
        {
            key: 'collapseAll',
            name: 'Collapse all (11,100 → 100 visible)',
            setup: seedHuge,
            run: () => { ops.collapseAll(); }
        },
        {
            key: 'expandAll',
            name: 'Expand all (re-mount 11,000 children)',
            setup: () => { ops.clear(); ops.createHuge(); ops.collapseAll(); },
            run: () => { ops.expandAll(); }
        },
        {
            key: 'toggleMany',
            name: 'Toggle 25 root subtrees (~2,775 mount/unmount)',
            setup: seedHuge,
            run: () => { ops.toggleMany(); }
        },
        {
            key: 'deepLeafUpdate',
            name: 'Update 1 leaf (sanity: should be sub-floor)',
            setup: seedHuge,
            run: () => { ops.deepLeafUpdate(50, 5, 5); }
        },
        {
            key: 'deepLeafUpdateAll',
            name: 'Update every leaf label (10,000 mutations)',
            setup: seedHuge,
            run: () => { ops.deepLeafUpdateAll(); }
        },
        {
            key: 'insertManyMids',
            name: 'Insert 25 new mid-children (with 10 leaves each)',
            setup: seedHuge,
            run: () => { ops.insertManyMids(); }
        },
        {
            key: 'removeManyRoots',
            name: 'Remove 25 root subtrees (~2,775 unmount)',
            setup: seedHuge,
            run: () => { ops.removeManyRoots(); }
        },
        {
            key: 'clear',
            name: 'Clear (11,100 nodes)',
            setup: seedHuge,
            run: () => { ops.clear(); }
        }
    ];
}

function waitForPaint() {
    return new Promise(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
}

async function measureOnce(setup, run) {
    if (setup) {
        setup();
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

// Shape constants are also re-exported on the module for adapters that want to know.
export const SHAPES = { SMALL, LARGE, HUGE };

// ───────────────────────────────── UI ─────────────────────────────────

const FRAMEWORKS = {
    deezul: () => import('./deezul/adapter.js'),
    react:  () => import('./react/adapter.js'),
    vue:    () => import('./vue/adapter.js'),
    solid:  () => import('./solid/adapter.js')
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

    const opOrder = ['createSmall','createLarge','createHuge','collapseAll','expandAll','toggleMany',
                     'deepLeafUpdate','deepLeafUpdateAll','insertManyMids','removeManyRoots','clear'];
    const opNames = {
        createSmall: 'Create 1k tree',
        createLarge: 'Create 5k tree',
        createHuge: 'Create 11k tree',
        collapseAll: 'Collapse all',
        expandAll: 'Expand all',
        toggleMany: 'Toggle 25 roots',
        deepLeafUpdate: 'Update 1 leaf (sanity)',
        deepLeafUpdateAll: 'Update all 10k leaves',
        insertManyMids: 'Insert 25 mids',
        removeManyRoots: 'Remove 25 roots',
        clear: 'Clear 11k'
    };

    let html = '<table><thead><tr><th>Operation</th>';
    for (const f of frameworks) html += `<th>${f} (wall-clock median)</th>`;
    html += '</tr></thead><tbody>';

    for (const op of opOrder) {
        html += `<tr><td>${opNames[op]}</td>`;
        for (const f of frameworks) {
            const r = results[f]?.[op];
            if (r) {
                html += `<td class="${timeClass(r.totalMedian)}">${r.totalMedian.toFixed(2)} ms <span class="muted">(min ${r.totalMin.toFixed(2)}, sync ${r.jsMedian.toFixed(2)})</span></td>`;
            } else {
                html += '<td>&mdash;</td>';
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

// Count all DOM elements under the mount (piercing shadow roots so Deezul's
// shadow-rendered nodes are counted). Used for the visible-node display only —
// not for correctness, just a sanity readout.
function countRenderedNodes() {
    const root = el('mount');
    if (!root) return 0;
    let count = 0;
    function walk(node) {
        if (node.nodeType === 1) {
            // Count <li> as the "tree-row" unit, ignoring wrapper divs/spans/uls.
            if (node.tagName === 'LI') count++;
            if (node.shadowRoot) walk(node.shadowRoot);
        }
        for (let i = 0; i < node.childNodes.length; i++) walk(node.childNodes[i]);
    }
    walk(root);
    return count;
}

function updateRowCount() {
    el('row-count').textContent = countRenderedNodes();
}

async function runManualOp(opKey) {
    if (!currentOps) {
        el('status').textContent = 'Pick a framework first.';
        return;
    }
    el('status').textContent = `Running ${opKey}…`;

    // deepLeafUpdate is the only parameterised op; everything else takes no args.
    if (opKey === 'deepLeafUpdate') {
        currentOps.deepLeafUpdate(0, 0, 0);
    } else {
        currentOps[opKey]();
    }

    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    updateRowCount();
    el('status').textContent = `${opKey} done.`;
}

window.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.fw-btn').forEach(b => {
        b.addEventListener('click', () => selectFramework(b.dataset.fw));
    });
    document.querySelectorAll('.op-btn').forEach(b => {
        b.addEventListener('click', () => runManualOp(b.dataset.op));
    });
    el('run-all').addEventListener('click', runAll);
    el('clear-results').addEventListener('click', clearResults);

    selectFramework('deezul');
});
