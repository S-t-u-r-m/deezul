/**
 * Vue 3 adapter for the nested-tree harness.
 *
 * Uses `reactive()` (deep proxy) rather than `shallowRef` because the bench
 * relies on per-node property mutation — flipping `expanded`, replacing
 * `label`, pushing into `children`. Deep proxy is the natural cross-framework
 * comparator: it's the same model Deezul uses, and what unoptimised Vue
 * code naturally produces.
 *
 * Cost of choosing reactive() over shallowRef: every node gets proxified on
 * access. That's the price of getting per-property reactivity. The krausest
 * variant in this repo uses shallowRef + triggerRef because that bench only
 * does whole-array replacement; here we need the deep version.
 */
import { createApp, reactive } from 'https://esm.sh/vue@3.4.27/dist/vue.esm-browser.prod.js';
import { buildTree, resetIdCounter, SHAPES } from '../harness.js';

const state = reactive({ tree: [] });
let nextInsertedId = 9_999_000;

const App = {
    setup() {
        return { state };
    },
    template: `
        <ul class="tree">
            <template v-for="root in state.tree" :key="root.id">
                <li class="lvl-0">
                    <span>{{ root.label }}</span>
                    <ul v-if="root.expanded">
                        <template v-for="mid in root.children" :key="mid.id">
                            <li class="lvl-1">
                                <span>{{ mid.label }}</span>
                                <ul v-if="mid.expanded">
                                    <li v-for="leaf in mid.children" :key="leaf.id" class="lvl-2">
                                        <span>{{ leaf.label }}</span>
                                    </li>
                                </ul>
                            </li>
                        </template>
                    </ul>
                </li>
            </template>
        </ul>
    `
};

function walkAll(fn) {
    const roots = state.tree;
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

function makeMidWithLeaves() {
    const children = new Array(10);
    for (let k = 0; k < 10; k++) {
        children[k] = { id: nextInsertedId++, label: 'inserted leaf', expanded: true, children: [] };
    }
    return { id: nextInsertedId++, label: 'inserted mid', expanded: true, children };
}

let app = null;

export default {
    async mount(rootEl) {
        resetIdCounter();
        state.tree = [];
        app = createApp(App);
        app.mount(rootEl);
        await new Promise(r => requestAnimationFrame(r));

        return {
            createSmall() { state.tree = buildTree(SHAPES.SMALL.roots, SHAPES.SMALL.mids, SHAPES.SMALL.leaves); },
            createLarge() { state.tree = buildTree(SHAPES.LARGE.roots, SHAPES.LARGE.mids, SHAPES.LARGE.leaves); },
            createHuge()  { state.tree = buildTree(SHAPES.HUGE.roots,  SHAPES.HUGE.mids,  SHAPES.HUGE.leaves); },

            collapseAll() { walkAll(n => { if (n.expanded) n.expanded = false; }); },
            expandAll()   { walkAll(n => { if (!n.expanded) n.expanded = true; }); },

            toggleMany() {
                const roots = state.tree;
                const step = Math.max(1, Math.floor(roots.length / 25));
                for (let i = 0; i < 25 && i * step < roots.length; i++) {
                    const r = roots[i * step];
                    r.expanded = !r.expanded;
                }
            },

            deepLeafUpdate(ri, mi, li) {
                const leaf = state.tree[ri]?.children?.[mi]?.children?.[li];
                if (leaf) leaf.label = leaf.label + ' !';
            },

            deepLeafUpdateAll() {
                const roots = state.tree;
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

            insertManyMids() {
                const roots = state.tree;
                const step = Math.max(1, Math.floor(roots.length / 25));
                for (let i = 0; i < 25 && i * step < roots.length; i++) {
                    roots[i * step].children.push(makeMidWithLeaves());
                }
            },

            removeManyRoots() {
                const tree = state.tree;
                for (let n = 0; n < 25 && tree.length > 0; n++) {
                    tree.splice(tree.length - 1, 1);
                }
            },

            clear() { state.tree = []; }
        };
    },
    unmount() {
        if (app) { app.unmount(); app = null; }
        state.tree = [];
    }
};
