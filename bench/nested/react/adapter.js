/**
 * React adapter for the nested-tree harness.
 *
 * Uses recursive <TreeNode> with React.memo at each level. Every op produces a
 * new tree value via path-cloning (structural sharing) so that:
 *   - changed nodes get new object identity → React re-renders them
 *   - unchanged subtrees keep reference identity → memo() skips them
 *
 * This is the idiomatic perf pattern for React trees. Going further (Redux
 * with normalizr + selector memoisation, or signals via use-sync-external-store)
 * would beat memo but isn't what "writing React" looks like.
 */
import React from 'https://esm.sh/react@18.3.1';
import { createRoot } from 'https://esm.sh/react-dom@18.3.1/client';
import htm from 'https://esm.sh/htm@3.1.1';
import { buildTree, resetIdCounter, SHAPES } from '../harness.js';

const html = htm.bind(React.createElement);
const { useState, memo } = React;

const ref = { tree: [], setTree: null };
let nextInsertedId = 9_999_000;

const LeafNode = memo(function LeafNode({ node }) {
    return html`<li className="lvl-2"><span>${node.label}</span></li>`;
});

const MidNode = memo(function MidNode({ node }) {
    return html`
        <li className="lvl-1">
            <span>${node.label}</span>
            ${node.expanded ? html`
                <ul>
                    ${node.children.map(leaf => html`<${LeafNode} key=${leaf.id} node=${leaf} />`)}
                </ul>
            ` : null}
        </li>
    `;
});

const RootNode = memo(function RootNode({ node }) {
    return html`
        <li className="lvl-0">
            <span>${node.label}</span>
            ${node.expanded ? html`
                <ul>
                    ${node.children.map(mid => html`<${MidNode} key=${mid.id} node=${mid} />`)}
                </ul>
            ` : null}
        </li>
    `;
});

function App() {
    const [tree, setTree] = useState([]);
    ref.tree = tree;
    ref.setTree = setTree;
    return html`
        <ul className="tree">
            ${tree.map(root => html`<${RootNode} key=${root.id} node=${root} />`)}
        </ul>
    `;
}

// ─── Path-cloning helpers (preserve reference identity for unchanged subtrees) ───

function mapAllExpanded(tree, value) {
    return tree.map(root => ({
        ...root, expanded: value,
        children: root.children.map(mid => ({
            ...mid, expanded: value,
            children: mid.children.map(leaf => ({ ...leaf, expanded: value }))
        }))
    }));
}

function replaceLeaf(tree, ri, mi, li, mutator) {
    const oldRoot = tree[ri]; if (!oldRoot) return tree;
    const oldMid = oldRoot.children[mi]; if (!oldMid) return tree;
    const oldLeaf = oldMid.children[li]; if (!oldLeaf) return tree;

    const newLeaf = mutator(oldLeaf);
    const newMidChildren = oldMid.children.slice();
    newMidChildren[li] = newLeaf;
    const newMid = { ...oldMid, children: newMidChildren };

    const newRootChildren = oldRoot.children.slice();
    newRootChildren[mi] = newMid;
    const newRoot = { ...oldRoot, children: newRootChildren };

    const next = tree.slice();
    next[ri] = newRoot;
    return next;
}

// Update every leaf — every node at every level needs a new identity.
// Equivalent to "rebuild the whole tree's spine with new label leaves".
function updateAllLeaves(tree) {
    return tree.map(root => ({
        ...root,
        children: root.children.map(mid => ({
            ...mid,
            children: mid.children.map(leaf => ({ ...leaf, label: leaf.label + ' !' }))
        }))
    }));
}

// Toggle `count` roots at indices [0, step, 2*step, ...].
function toggleRoots(tree, count, step) {
    const indices = new Set();
    for (let i = 0; i < count && i * step < tree.length; i++) indices.add(i * step);
    return tree.map((root, idx) => indices.has(idx) ? { ...root, expanded: !root.expanded } : root);
}

// Append a new mid to each of `count` roots at indices [0, step, ...].
function insertMidsAt(tree, count, step) {
    const indices = new Set();
    for (let i = 0; i < count && i * step < tree.length; i++) indices.add(i * step);
    return tree.map((root, idx) => {
        if (!indices.has(idx)) return root;
        const newMid = makeMidWithLeaves();
        return { ...root, children: [...root.children, newMid] };
    });
}

function makeMidWithLeaves() {
    const children = new Array(10);
    for (let k = 0; k < 10; k++) {
        children[k] = { id: nextInsertedId++, label: 'inserted leaf', expanded: true, children: [] };
    }
    return { id: nextInsertedId++, label: 'inserted mid', expanded: true, children };
}

let root = null;

export default {
    async mount(rootEl) {
        resetIdCounter();
        root = createRoot(rootEl);
        root.render(html`<${App} />`);
        await new Promise(r => requestAnimationFrame(r));

        return {
            createSmall() { ref.setTree(buildTree(SHAPES.SMALL.roots, SHAPES.SMALL.mids, SHAPES.SMALL.leaves)); },
            createLarge() { ref.setTree(buildTree(SHAPES.LARGE.roots, SHAPES.LARGE.mids, SHAPES.LARGE.leaves)); },
            createHuge()  { ref.setTree(buildTree(SHAPES.HUGE.roots,  SHAPES.HUGE.mids,  SHAPES.HUGE.leaves)); },

            collapseAll() { ref.setTree(mapAllExpanded(ref.tree, false)); },
            expandAll()   { ref.setTree(mapAllExpanded(ref.tree, true)); },

            toggleMany() {
                const len = ref.tree.length;
                const step = Math.max(1, Math.floor(len / 25));
                ref.setTree(toggleRoots(ref.tree, 25, step));
            },

            deepLeafUpdate(ri, mi, li) {
                ref.setTree(replaceLeaf(ref.tree, ri, mi, li, leaf => ({ ...leaf, label: leaf.label + ' !' })));
            },

            deepLeafUpdateAll() { ref.setTree(updateAllLeaves(ref.tree)); },

            insertManyMids() {
                const len = ref.tree.length;
                const step = Math.max(1, Math.floor(len / 25));
                ref.setTree(insertMidsAt(ref.tree, 25, step));
            },

            removeManyRoots() {
                const len = ref.tree.length;
                const drop = Math.min(25, len);
                ref.setTree(ref.tree.slice(0, len - drop));
            },

            clear() { ref.setTree([]); }
        };
    },
    unmount() {
        if (root) { root.unmount(); root = null; }
        ref.tree = []; ref.setTree = null;
    }
};
