export default Deezul.Component({
    template: `
        <div class="page">
            <h1>Data Stores</h1>
            <p class="intro">Data stores provide shared reactive state that persists across component navigation. Any component can read and write to a store.</p>

            <h2>Registering a Store</h2>
            <p>Add a module with <code>type: 'data'</code> in your modules config:</p>
            <pre class="code-block" :pre><code>// modules.config.js
export default [
    // Components...
    {
        ref: 'app-layout',
        path: './compiled/AppLayout.compiled.js'
    },

    // Data stores
    {
        ref: 'user-store',
        type: 'data',
        data: {
            name: '',
            isLoggedIn: false,
            preferences: {}
        }
    },
    {
        ref: 'cart-store',
        type: 'data',
        data: {
            items: [],
            total: 0
        },
        localStorage: true  // Persist across page reloads
    },
];</code></pre>

            <h2>Using a Store in Components</h2>
            <p><code>Deezul.getDataStore()</code> returns a Promise that resolves to the reactive store proxy:</p>
            <pre class="code-block" :pre><code>export default Deezul.Component({
    template: \`
        &lt;div&gt;
            &lt;p&gt;Count: {{ count }}&lt;/p&gt;
            &lt;button @click="increment"&gt;+1&lt;/button&gt;
        &lt;/div&gt;
    \`,

    data: () => ({
        count: 0
    }),

    async $mounted() {
        const store = await Deezul.getDataStore('counter-store');
        this.count = store.count;
    },

    methods: {
        async increment() {
            const store = await Deezul.getDataStore('counter-store');
            store.count++;
            this.count = store.count;
        }
    }
});</code></pre>
            <p class="note">Note: Primitive values (numbers, strings) are copied, not referenced. After mutating the store, read the value back to sync your component.</p>

            <h2>localStorage Persistence</h2>
            <p>Set <code>localStorage: true</code> to automatically save store data to the browser's localStorage. Data survives page reloads:</p>
            <pre class="code-block" :pre><code>{
    ref: 'settings-store',
    type: 'data',
    data: {
        theme: 'light',
        fontSize: 14
    },
    localStorage: true,
    localStorageKey: 'app_settings'  // Optional custom key
}</code></pre>
            <p>Saves are debounced (500ms) to avoid excessive writes during rapid updates.</p>

            <h2>Cloning a Store</h2>
            <p>Use <code>Deezul.cloneStore()</code> to get an isolated copy. Mutations on the clone don't affect the original:</p>
            <pre class="code-block" :pre><code>const draft = await Deezul.cloneStore('user-store');
draft.name = 'New Name';
// Original user-store.name is unchanged
// Useful for "edit & save" or "edit & cancel" patterns</code></pre>

            <h2>Live Demo</h2>
            <p>This counter uses a shared data store. Navigate away and come back — the count persists:</p>
            <div class="demo-box">
                <p class="demo-result">Count: <strong>{{ count }}</strong></p>
                <div class="demo-controls">
                    <button @click="decrement" class="demo-btn">-</button>
                    <button @click="increment" class="demo-btn">+</button>
                    <button @click="resetCount" class="demo-btn secondary">Reset</button>
                </div>
            </div>

            <p class="next">Next: <a href="/lifecycle">Lifecycle & Errors</a> — hooks and error handling.</p>
        </div>
    `,

    data: () => ({
        count: 0
    }),

    async $mounted() {
        const store = await Deezul.getDataStore('counter-store');
        this.count = store.count;
    },

    methods: {
        async increment() {
            const store = await Deezul.getDataStore('counter-store');
            store.count++;
            this.count = store.count;
        },
        async decrement() {
            const store = await Deezul.getDataStore('counter-store');
            store.count--;
            this.count = store.count;
        },
        async resetCount() {
            const store = await Deezul.getDataStore('counter-store');
            store.count = 0;
            this.count = 0;
        }
    },

    styles: `
        .page { max-width: 760px; }
        h1 { font-size: 32px; font-weight: 800; color: #1a1a2e; margin: 0 0 8px; }
        h2 { font-size: 19px; font-weight: 700; color: #1a1a2e; margin: 32px 0 10px; }
        .intro { font-size: 16px; color: #555; line-height: 1.6; margin: 0 0 24px; }
        p { font-size: 14px; color: #444; line-height: 1.6; margin: 0 0 12px; }
        code { background: #eef; padding: 2px 5px; border-radius: 3px; font-size: 13px; font-family: 'Consolas', 'Monaco', monospace; }
        .code-block {
            background: #1e1e2e; color: #cdd6f4; padding: 16px 20px; border-radius: 8px;
            font-size: 13px; line-height: 1.6; overflow-x: auto; margin: 0 0 12px;
            font-family: 'Consolas', 'Monaco', 'Courier New', monospace; white-space: pre;
        }
        .code-block code { background: none; padding: 0; color: inherit; font-family: inherit; }
        .note { font-size: 13px; color: #888; font-style: italic; }
        .demo-box {
            background: #fff; border: 1px solid #e0e4e8; border-radius: 10px;
            padding: 24px; margin: 12px 0 16px;
        }
        .demo-result { font-size: 20px; margin: 0 0 16px; }
        .demo-controls { display: flex; gap: 8px; }
        .demo-btn {
            padding: 8px 20px; background: #1a1a2e; color: #fff; border: none;
            border-radius: 6px; font-size: 15px; cursor: pointer;
        }
        .demo-btn:hover { background: #2a2a4e; }
        .demo-btn.secondary { background: #667; }
        .demo-btn.secondary:hover { background: #778; }
        .next { margin-top: 32px; font-size: 15px; color: #555; }
        .next a { color: #00d4ff; text-decoration: none; font-weight: 600; }
        .next a:hover { text-decoration: underline; }
    `
});
