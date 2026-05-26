/**
 * Deezul adapter for the nested-tree harness.
 *
 * Uses the framework's proxy-based deep reactivity for everything — assigning
 * `proxy.tree = newTree` re-proxifies on access, and per-node mutation like
 * `proxy.tree[i].expanded = false` triggers updates surgically. Bulk ops
 * (collapseAll, deepLeafUpdateAll) write many properties in a row — Deezul
 * auto-batches via microtask, so the whole sweep flushes as one render.
 */

import '/src/runtime/DzComponent.js';
import { componentRegistry } from '/src/runtime/registries.js';
import App from './App.compiled.js';
import { buildTree, resetIdCounter, SHAPES } from '../harness.js';

componentRegistry.register('nested-deezul', App);

let host = null;
let proxy = null;
let nextInsertedId = 9_999_000;

function waitForMount(el) {
    return new Promise(resolve => {
        (function check() {
            if (el.component && el.component.proxy) {
                proxy = el.component.proxy;
                resolve();
            } else {
                setTimeout(check, 10);
            }
        })();
    });
}

function walkAll(fn) {
    const roots = proxy.tree;
    for (let i = 0; i < roots.length; i++) {
        const r = roots[i];
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

function buildMidWithLeaves(midsPerLeaf = 10) {
    const children = new Array(midsPerLeaf);
    for (let k = 0; k < midsPerLeaf; k++) {
        children[k] = { id: nextInsertedId++, label: 'inserted leaf', expanded: true, children: [] };
    }
    return { id: nextInsertedId++, label: 'inserted mid', expanded: true, children };
}

export default {
    async mount(rootEl) {
        resetIdCounter();
        host = document.createElement('dz-component');
        host.setAttribute('dz-type', 'nested-deezul');
        rootEl.appendChild(host);
        await waitForMount(host);

        return {
            createSmall() { proxy.tree = buildTree(SHAPES.SMALL.roots, SHAPES.SMALL.mids, SHAPES.SMALL.leaves); },
            createLarge() { proxy.tree = buildTree(SHAPES.LARGE.roots, SHAPES.LARGE.mids, SHAPES.LARGE.leaves); },
            createHuge()  { proxy.tree = buildTree(SHAPES.HUGE.roots,  SHAPES.HUGE.mids,  SHAPES.HUGE.leaves); },

            collapseAll() { walkAll(n => { if (n.expanded) n.expanded = false; }); },
            expandAll()   { walkAll(n => { if (!n.expanded) n.expanded = true; }); },

            // Toggle 25 evenly-spaced roots (every 4th in a 100-root tree).
            // Each toggle mounts/unmounts a ~111-node subtree → ~2,775 nodes total.
            toggleMany() {
                const roots = proxy.tree;
                const step = Math.max(1, Math.floor(roots.length / 25));
                for (let i = 0; i < 25 && i * step < roots.length; i++) {
                    const r = roots[i * step];
                    r.expanded = !r.expanded;
                }
            },

            deepLeafUpdate(ri, mi, li) {
                const leaf = proxy.tree[ri]?.children?.[mi]?.children?.[li];
                if (leaf) leaf.label = leaf.label + ' !';
            },

            // Mutate every leaf's label. 10,000 property writes batched via microtask.
            deepLeafUpdateAll() {
                const roots = proxy.tree;
                for (let i = 0; i < roots.length; i++) {
                    const mids = roots[i].children;
                    for (let j = 0; j < mids.length; j++) {
                        const leaves = mids[j].children;
                        for (let k = 0; k < leaves.length; k++) {
                            leaves[k].label = leaves[k].label + ' !';
                        }
                    }
                }
            },

            // Push a new mid-with-10-leaves into 25 evenly-spaced roots.
            insertManyMids() {
                const roots = proxy.tree;
                const step = Math.max(1, Math.floor(roots.length / 25));
                for (let i = 0; i < 25 && i * step < roots.length; i++) {
                    roots[i * step].children.push(buildMidWithLeaves(10));
                }
            },

            // Remove the last 25 root subtrees (indices stay valid as we splice from the end).
            removeManyRoots() {
                const tree = proxy.tree;
                for (let n = 0; n < 25 && tree.length > 0; n++) {
                    tree.splice(tree.length - 1, 1);
                }
            },

            clear() { proxy.tree = []; }
        };
    },

    unmount() {
        if (host && host.parentElement) host.parentElement.removeChild(host);
        host = null;
        proxy = null;
    }
};
