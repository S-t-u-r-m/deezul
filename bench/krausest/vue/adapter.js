/**
 * Vue 3 adapter (tuned) for the krausest harness.
 *
 * Uses shallowRef + manual triggerRef — the pattern used by krausest's
 * optimized Vue entry. Why: ref(array) deep-proxies every element on access,
 * which costs ~10k Proxy allocations at Create 10k scale. shallowRef
 * skips that — the array itself triggers reactivity on assignment, but
 * elements aren't reactified. Mutations require an explicit triggerRef().
 *
 * Trade-off: more verbose than natural Vue (`.value = ...` no longer enough
 * for every case). But this is what perf-conscious Vue users write, and
 * it's the pattern Vue itself ships in their bench entries.
 */
// Production build of Vue's runtime+compiler. The default `vue.esm-browser.js`
// is the DEV build, which carries dev warnings, prop validation, reactivity
// tracing, etc. The `.prod.js` build is what real Vue apps ship.
import { createApp, shallowRef, triggerRef } from 'https://esm.sh/vue@3.4.27/dist/vue.esm-browser.prod.js';
import { buildData, resetIdCounter } from '../harness.js';

const state = { items: null, selected: null };

const App = {
    setup() {
        state.items = shallowRef([]);
        state.selected = shallowRef(null);
        return {
            items: state.items,
            selected: state.selected,
            select(id) { state.selected.value = id; },
            remove(id) {
                const arr = state.items.value;
                const idx = arr.findIndex(it => it.id === id);
                if (idx >= 0) {
                    arr.splice(idx, 1);
                    triggerRef(state.items);
                }
            }
        };
    },
    template: `
        <div class="krausest-app">
            <table class="ktbl">
                <tbody>
                    <tr v-for="item in items" :key="item.id" :class="item.id === selected ? 'danger' : ''">
                        <td class="col-md-1">{{ item.id }}</td>
                        <td class="col-md-4"><a @click="select(item.id)">{{ item.label }}</a></td>
                        <td class="col-md-1"><a @click="remove(item.id)">x</a></td>
                        <td class="col-md-6"></td>
                    </tr>
                </tbody>
            </table>
        </div>
    `
};

let app = null;

export default {
    async mount(rootEl) {
        resetIdCounter();
        app = createApp(App);
        app.mount(rootEl);
        await new Promise(r => requestAnimationFrame(r));

        return {
            // .value = newArray triggers via shallowRef's setter — no triggerRef needed.
            run()     { state.items.value = buildData(1000); },
            runLots() { state.items.value = buildData(10000); },
            runHuge() { state.items.value = buildData(50000); },
            add()     { state.items.value = state.items.value.concat(buildData(1000)); },
            update() {
                // shallowRef doesn't track per-item mutations. Replace items
                // at every 10th index with new objects and triggerRef.
                const arr = state.items.value;
                for (let i = 0; i < arr.length; i += 10) {
                    arr[i] = { id: arr[i].id, label: arr[i].label + ' !!!' };
                }
                triggerRef(state.items);
            },
            clear()   { state.items.value = []; },
            swapRows() {
                const arr = state.items.value;
                const n = arr.length;
                if (n < 4) return;
                const a = arr[1], b = arr[n - 2];
                arr[1] = b; arr[n - 2] = a;
                triggerRef(state.items);
            },
            select(id) { state.selected.value = id; },
            remove(id) {
                const arr = state.items.value;
                const idx = arr.findIndex(it => it.id === id);
                if (idx >= 0) {
                    arr.splice(idx, 1);
                    triggerRef(state.items);
                }
            },
            getMiddleId() {
                const arr = state.items.value;
                return arr.length ? arr[Math.floor(arr.length / 2)].id : null;
            }
        };
    },
    unmount() {
        if (app) { app.unmount(); app = null; }
        state.items = null; state.selected = null;
    }
};
