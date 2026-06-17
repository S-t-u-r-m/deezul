/**
 * React adapter for the krausest harness.
 *
 * Uses React 18 + htm for JSX-like syntax without a build step. State pattern
 * is natural useState — what a typical React user would write. The official
 * krausest React entries sometimes use a Store/forceUpdate trick to bypass
 * VDOM diffing on writes; that's not what most users write, so we don't.
 *
 * The mount returns an `ops` object that imperatively triggers state updates
 * via setters captured into a module-level ref. This bridges the adapter API
 * (imperative ops) with React's reactive model.
 */
import React from 'https://esm.sh/react@18.3.1';
import { createRoot } from 'https://esm.sh/react-dom@18.3.1/client';
import htm from 'https://esm.sh/htm@3.1.1';
import { buildData, resetIdCounter } from '../harness.js';

const html = htm.bind(React.createElement);
const { useState, useCallback, memo } = React;

// State bridge — populated when App renders, used by ops from outside React.
const ref = { items: [], selected: null, setItems: null, setSelected: null };

const Row = memo(function Row({ item, selected, onSelect, onRemove }) {
    return html`
        <tr className=${item.id === selected ? 'danger' : ''}>
            <td className="col-md-1">${item.id}</td>
            <td className="col-md-4"><a onClick=${() => onSelect(item.id)}>${item.label}</a></td>
            <td className="col-md-1"><a onClick=${() => onRemove(item.id)}>x</a></td>
            <td className="col-md-6"></td>
        </tr>
    `;
});

function App() {
    const [items, setItems] = useState([]);
    const [selected, setSelected] = useState(null);
    ref.items = items;
    ref.selected = selected;
    ref.setItems = setItems;
    ref.setSelected = setSelected;

    const onSelect = useCallback(id => setSelected(id), []);
    const onRemove = useCallback(id => {
        setItems(prev => {
            const idx = prev.findIndex(it => it.id === id);
            if (idx < 0) return prev;
            const next = prev.slice();
            next.splice(idx, 1);
            return next;
        });
    }, []);

    return html`
        <div className="krausest-app">
            <table className="ktbl">
                <tbody>
                    ${items.map(item => html`
                        <${Row}
                            key=${item.id}
                            item=${item}
                            selected=${selected}
                            onSelect=${onSelect}
                            onRemove=${onRemove}
                        />
                    `)}
                </tbody>
            </table>
        </div>
    `;
}

let root = null;

export default {
    async mount(rootEl) {
        resetIdCounter();
        root = createRoot(rootEl);
        root.render(html`<${App} />`);
        // React 18 batches state and renders asynchronously — wait one rAF so
        // initial mount commits before ops run.
        await new Promise(r => requestAnimationFrame(r));

        return {
            run() { ref.setItems(buildData(1000)); },
            runLots() { ref.setItems(buildData(10000)); },
            runHuge() { ref.setItems(buildData(50000)); },
            add() { ref.setItems(ref.items.concat(buildData(1000))); },
            update() {
                // Krausest mutates labels in place. React state must be immutable;
                // we produce a new array with new objects for the affected rows.
                const next = ref.items.slice();
                for (let i = 0; i < next.length; i += 10) {
                    next[i] = { id: next[i].id, label: next[i].label + ' !!!' };
                }
                ref.setItems(next);
            },
            clear() { ref.setItems([]); },
            swapRows() {
                const n = ref.items.length;
                if (n < 4) return;
                const arr = ref.items.slice();
                const a = arr[1], b = arr[n - 2];
                arr[1] = b; arr[n - 2] = a;
                ref.setItems(arr);
            },
            select(id) { ref.setSelected(id); },
            remove(id) {
                const idx = ref.items.findIndex(it => it.id === id);
                if (idx < 0) return;
                const next = ref.items.slice();
                next.splice(idx, 1);
                ref.setItems(next);
            },
            getMiddleId() {
                return ref.items.length ? ref.items[Math.floor(ref.items.length / 2)].id : null;
            }
        };
    },
    unmount() {
        if (root) { root.unmount(); root = null; }
        ref.items = []; ref.selected = null; ref.setItems = null; ref.setSelected = null;
    }
};
