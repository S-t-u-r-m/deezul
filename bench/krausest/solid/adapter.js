/**
 * Solid.js adapter for the krausest harness.
 *
 * Uses `solid-js/html` (tagged-template runtime) instead of compiled JSX —
 * because we have no build step. This is typically ~10–20% slower than
 * Solid's compiled-JSX path, so what we measure is a slight under-estimate
 * of Solid's true ceiling. Even so, it's the right cross-framework gold
 * standard since signals + fine-grained reactivity remain Solid's defining
 * win regardless of template format.
 *
 * Pattern: createSignal for `selected` (primitive). For `items` we use the
 * same signal-with-replace pattern — replacement is what krausest tests.
 * Solid's `<For>` component handles keyed reconciliation; we feed it the
 * signal getter so it knows what to track.
 */
import { createSignal, For } from 'https://esm.sh/solid-js@1.8.17';
import { render } from 'https://esm.sh/solid-js@1.8.17/web';
import html from 'https://esm.sh/solid-js@1.8.17/html';
import { buildData, resetIdCounter } from '../harness.js';

const state = { items: null, setItems: null, selected: null, setSelected: null };

function App() {
    const [items, setItems] = createSignal([]);
    const [selected, setSelected] = createSignal(null);
    state.items = items;
    state.setItems = setItems;
    state.selected = selected;
    state.setSelected = setSelected;

    return html`
        <div class="krausest-app">
            <table class="ktbl">
                <tbody>
                    <${For} each=${items}>
                        ${(item) => html`
                            <tr class=${() => item.id === selected() ? 'danger' : ''}>
                                <td class="col-md-1">${item.id}</td>
                                <td class="col-md-4"><a onClick=${() => setSelected(item.id)}>${() => item.label}</a></td>
                                <td class="col-md-1"><a onClick=${() => {
                                    const arr = items();
                                    const idx = arr.findIndex(it => it.id === item.id);
                                    if (idx >= 0) setItems([...arr.slice(0, idx), ...arr.slice(idx + 1)]);
                                }}>x</a></td>
                                <td class="col-md-6"></td>
                            </tr>
                        `}
                    <//>
                </tbody>
            </table>
        </div>
    `;
}

let dispose = null;

export default {
    async mount(rootEl) {
        resetIdCounter();
        dispose = render(App, rootEl);
        await new Promise(r => requestAnimationFrame(r));

        return {
            run()     { state.setItems(buildData(1000)); },
            runLots() { state.setItems(buildData(10000)); },
            runHuge() { state.setItems(buildData(50000)); },
            add()     { state.setItems([...state.items(), ...buildData(1000)]); },
            update() {
                // createSignal doesn't track per-item mutations — replace items
                // at every 10th index with new objects. (createStore would allow
                // path-based mutation; this matches the simpler signal pattern.)
                const arr = state.items();
                const next = arr.slice();
                for (let i = 0; i < next.length; i += 10) {
                    next[i] = { id: next[i].id, label: next[i].label + ' !!!' };
                }
                state.setItems(next);
            },
            clear()   { state.setItems([]); },
            swapRows() {
                const arr = state.items();
                const n = arr.length;
                if (n < 4) return;
                const next = arr.slice();
                const a = next[1], b = next[n - 2];
                next[1] = b; next[n - 2] = a;
                state.setItems(next);
            },
            select(id) { state.setSelected(id); },
            remove(id) {
                const arr = state.items();
                const idx = arr.findIndex(it => it.id === id);
                if (idx < 0) return;
                state.setItems([...arr.slice(0, idx), ...arr.slice(idx + 1)]);
            },
            getMiddleId() {
                const arr = state.items();
                return arr.length ? arr[Math.floor(arr.length / 2)].id : null;
            }
        };
    },
    unmount() {
        if (dispose) { dispose(); dispose = null; }
        state.items = null; state.setItems = null;
        state.selected = null; state.setSelected = null;
    }
};
