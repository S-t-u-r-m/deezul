/**
 * Deezul adapter for the krausest harness.
 *
 * mount(el) → mounts the compiled component into `el` and returns the
 * standard ops object. Krausest semantics:
 *   run       = replace items with 1,000 fresh
 *   runLots   = replace with 10,000 fresh
 *   add       = append 1,000
 *   update    = mutate every 10th item's label
 *   clear     = items = []
 *   swapRows  = swap items[1] ↔ items[length-2]
 *   select(id) / remove(id) — driven by row clicks but also exposed for tests
 */

import '/src/runtime/DzComponent.js';
import { componentRegistry } from '/src/runtime/registries.js';
import App from './App.compiled.js';
import { buildData, resetIdCounter } from '../harness.js';

componentRegistry.register('krausest-deezul', App);

let component = null;
let proxy = null;

function waitForMount(host) {
    return new Promise(resolve => {
        (function check() {
            if (host.component && host.component.proxy) {
                component = host.component;
                proxy = host.component.proxy;
                resolve();
            } else {
                setTimeout(check, 10);
            }
        })();
    });
}

export default {
    async mount(rootEl) {
        resetIdCounter();
        const host = document.createElement('dz-component');
        host.setAttribute('dz-type', 'krausest-deezul');
        rootEl.appendChild(host);
        await waitForMount(host);

        return {
            run()       { proxy.items = buildData(1000); },
            runLots()   { proxy.items = buildData(10000); },
            runHuge()   { proxy.items = buildData(50000); },
            add()       { proxy.items = proxy.items.concat(buildData(1000)); },
            update() {
                // Krausest: mutate every 10th label in place.
                for (let i = 0; i < proxy.items.length; i += 10) {
                    proxy.items[i].label += ' !!!';
                }
            },
            clear()     { proxy.items = []; },
            swapRows() {
                const n = proxy.items.length;
                if (n < 4) return;
                const arr = proxy.items.slice();
                const a = arr[1], b = arr[n - 2];
                arr[1] = b; arr[n - 2] = a;
                proxy.items = arr;
            },
            select(id)  { proxy.selected = id; },
            remove(id) {
                const idx = proxy.items.findIndex(it => it.id === id);
                if (idx >= 0) proxy.items.splice(idx, 1);
            },
            getMiddleId() {
                const items = proxy.items;
                return items.length ? items[Math.floor(items.length / 2)].id : null;
            }
        };
    },

    unmount() {
        // No explicit teardown — harness clears the mount element which removes the host.
        component = null;
        proxy = null;
    }
};
