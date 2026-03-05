export default Deezul.Component({
    template: `
        <div class="home">
            <h1>Deezul Framework</h1>
            <p class="subtitle">A lightweight reactive UI framework built on Web Components, Proxy-based reactivity, and bytecode-compiled templates.</p>

            <div class="cards">
                <div class="card">
                    <h3>Reactive</h3>
                    <p>Proxy-based data binding. Change your data and the DOM updates automatically — no virtual DOM needed.</p>
                </div>
                <div class="card">
                    <h3>Web Components</h3>
                    <p>Shadow DOM encapsulation with scoped styles, slots, props, and lifecycle hooks built in.</p>
                </div>
                <div class="card">
                    <h3>Compiled</h3>
                    <p>Templates compile to bytecode at build time. The runtime applies targeted updates with zero diffing overhead.</p>
                </div>
                <div class="card">
                    <h3>Lightweight</h3>
                    <p>Tiny runtime with no dependencies. SPA routing, data stores, computed properties, and directives included.</p>
                </div>
            </div>

            <div class="install-section">
                <h2>Install</h2>
                <pre class="code-block" :pre><code>npm install deezul</code></pre>
            </div>

            <div class="quickstart-section">
                <h2>Quick Start</h2>
                <pre class="code-block" :pre><code>// my-component.js
export default Deezul.Component({
    template: \`
        &lt;div&gt;
            &lt;h1&gt;{{ greeting }}&lt;/h1&gt;
            &lt;button @click="update"&gt;Click me&lt;/button&gt;
        &lt;/div&gt;
    \`,

    data: () => ({
        greeting: 'Hello, Deezul!'
    }),

    methods: {
        update() {
            this.greeting = 'It works!';
        }
    }
});</code></pre>

                <pre class="code-block" :pre><code># Compile the component
npx deezul-compile my-component.js my-component.compiled.js</code></pre>

                <pre class="code-block" :pre><code>// main.js — Initialize the app
import Deezul from 'deezul';

Deezul.init({
    rootElement: 'app',
    modules: [
        {
            ref: 'my-component',
            path: './my-component.compiled.js'
        }
    ],
    routes: [
        {
            path: '/',
            component: 'my-component'
        }
    ]
});</code></pre>
            </div>

            <p class="next-step">Ready to dive in? Start with the <a href="/getting-started">Getting Started</a> guide.</p>
        </div>
    `,

    data: () => ({}),

    styles: `
        .home { max-width: 760px; }
        h1 {
            font-size: 40px;
            font-weight: 800;
            color: #1a1a2e;
            margin: 0 0 12px;
        }
        h2 {
            font-size: 22px;
            font-weight: 700;
            color: #1a1a2e;
            margin: 0 0 12px;
        }
        .subtitle {
            font-size: 17px;
            color: #555;
            line-height: 1.6;
            margin: 0 0 36px;
        }
        .cards {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 16px;
            margin-bottom: 40px;
        }
        .card {
            background: #fff;
            border: 1px solid #e8eaed;
            border-radius: 10px;
            padding: 24px;
        }
        .card h3 {
            font-size: 16px;
            color: #1a1a2e;
            margin: 0 0 8px;
        }
        .card p {
            font-size: 13px;
            color: #666;
            line-height: 1.5;
            margin: 0;
        }
        .install-section { margin-bottom: 36px; }
        .quickstart-section { margin-bottom: 36px; }
        .code-block {
            background: #1e1e2e;
            color: #cdd6f4;
            padding: 16px 20px;
            border-radius: 8px;
            font-size: 13px;
            line-height: 1.6;
            overflow-x: auto;
            margin: 0 0 12px;
            font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
            white-space: pre;
        }
        .code-block code {
            font-family: inherit;
        }
        .next-step {
            font-size: 15px;
            color: #555;
            margin-top: 20px;
        }
        .next-step a {
            color: #00d4ff;
            text-decoration: none;
            font-weight: 600;
        }
        .next-step a:hover { text-decoration: underline; }
    `
});
