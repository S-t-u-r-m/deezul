/**
 * Solid.js adapter for the nested-tree harness.
 *
 * Uses `createStore` (Solid's fine-grained nested-reactivity primitive) rather
 * than `createSignal` — stores are the right answer for trees with per-node
 * mutation. setStore('tree', i, 'children', j, ...) updates exactly that path,
 * and signals subscribed only to that path fire — ancestors don't re-render.
 *
 * For bulk ops (collapseAll/expandAll/deepLeafUpdateAll) we use `produce`,
 * which lets us mutate a draft Immer-style and emits a single batched update.
 * That's the idiomatic high-perf Solid pattern; calling setStore N times for
 * each leaf would pay reactive-graph cost N times.
 *
 * Uses solid-js/html (tagged-template runtime) since there's no build step.
 * ~10-20% slower than compiled JSX — same caveat as the krausest Solid adapter.
 */
import { For } from 'https://esm.sh/solid-js@1.8.17';
import { render } from 'https://esm.sh/solid-js@1.8.17/web';
import html from 'https://esm.sh/solid-js@1.8.17/html';
import { createStore, produce } from 'https://esm.sh/solid-js@1.8.17/store';
import { buildTree, resetIdCounter, SHAPES } from '../harness.js';

let store = null;
let setStore = null;
let nextInsertedId = 9_999_000;

function TreeNode(props) {
    const level = props.level;
    return html`
        <li class=${`lvl-${level}`}>
            <span>${() => props.node.label}</span>
            ${() => props.node.expanded && props.node.children.length > 0
                ? html`
                    <ul>
                        <${For} each=${() => props.node.children}>
                            ${child => html`<${TreeNode} node=${child} level=${level + 1} />`}
                        <//>
                    </ul>
                `
                : null}
        </li>
    `;
}

function App() {
    return html`
        <ul class="tree">
            <${For} each=${() => store.tree}>
                ${root => html`<${TreeNode} node=${root} level=${0} />`}
            <//>
        </ul>
    `;
}

function walkAllMutable(tree, fn) {
    for (let i = 0; i < tree.length; i++) {
        const r = tree[i];
        fn(r);
        const mids = r.children;
        for (let j = 0; j < mids.length; j++) {
            const m = mids[j];
            fn(m);
            const leaves = m.children;
            for (let k = 0; k < leaves.length; k++) fn(leaves[k]);
        }
    }
}

function makeMidWithLeaves() {
    const children = new Array(10);
    for (let k = 0; k < 10; k++) {
        children[k] = { id: nextInsertedId++, label: 'inserted leaf', expanded: true, children: [] };
    }
    return { id: nextInsertedId++, label: 'inserted mid', expanded: true, children };
}

let dispose = null;

export default {
    async mount(rootEl) {
        resetIdCounter();
        [store, setStore] = createStore({ tree: [] });
        dispose = render(App, rootEl);
        await new Promise(r => requestAnimationFrame(r));

        return {
            createSmall() { setStore('tree', buildTree(SHAPES.SMALL.roots, SHAPES.SMALL.mids, SHAPES.SMALL.leaves)); },
            createLarge() { setStore('tree', buildTree(SHAPES.LARGE.roots, SHAPES.LARGE.mids, SHAPES.LARGE.leaves)); },
            createHuge()  { setStore('tree', buildTree(SHAPES.HUGE.roots,  SHAPES.HUGE.mids,  SHAPES.HUGE.leaves)); },

            collapseAll() { setStore('tree', produce(tree => walkAllMutable(tree, n => { n.expanded = false; }))); },
            expandAll()   { setStore('tree', produce(tree => walkAllMutable(tree, n => { n.expanded = true; }))); },

            toggleMany() {
                setStore('tree', produce(tree => {
                    const step = Math.max(1, Math.floor(tree.length / 25));
                    for (let i = 0; i < 25 && i * step < tree.length; i++) {
                        tree[i * step].expanded = !tree[i * step].expanded;
                    }
                }));
            },

            deepLeafUpdate(ri, mi, li) {
                if (store.tree[ri]?.children?.[mi]?.children?.[li]) {
                    setStore('tree', ri, 'children', mi, 'children', li, 'label', l => l + ' !');
                }
            },

            deepLeafUpdateAll() {
                setStore('tree', produce(tree => {
                    for (let i = 0; i < tree.length; i++) {
                        const mids = tree[i].children;
                        for (let j = 0; j < mids.length; j++) {
                            const leaves = mids[j].children;
                            for (let k = 0; k < leaves.length; k++) {
                                leaves[k].label = leaves[k].label + ' !';
                            }
                        }
                    }
                }));
            },

            insertManyMids() {
                setStore('tree', produce(tree => {
                    const step = Math.max(1, Math.floor(tree.length / 25));
                    for (let i = 0; i < 25 && i * step < tree.length; i++) {
                        tree[i * step].children.push(makeMidWithLeaves());
                    }
                }));
            },

            removeManyRoots() {
                setStore('tree', produce(tree => {
                    for (let n = 0; n < 25 && tree.length > 0; n++) tree.pop();
                }));
            },

            clear() { setStore('tree', []); }
        };
    },
    unmount() {
        if (dispose) { dispose(); dispose = null; }
        store = null; setStore = null;
    }
};
