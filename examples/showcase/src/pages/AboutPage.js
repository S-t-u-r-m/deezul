export default Deezul.Component({
    template: `
        <div class="about">
            <h1>About Deezul</h1>
            <p>Deezul is a reactive UI framework that compiles templates into bytecode bindings at build time and applies them at runtime using Proxy-observed data.</p>

            <h2>How it works</h2>
            <ul>
                <li><strong>Compiler</strong> parses component templates and emits bytecode arrays that describe where and how to bind data to the DOM.</li>
                <li><strong>Runtime</strong> creates Proxy wrappers around your data. When a property changes, only the specific DOM nodes bound to it are updated.</li>
                <li><strong>Shadow DOM</strong> encapsulates each component's markup and styles, preventing leaks.</li>
                <li><strong>Router</strong> provides client-side navigation with nested routes, layouts, params, and guards.</li>
            </ul>

            <h2>Features</h2>
            <ul>
                <li>Text and attribute bindings</li>
                <li>Two-way binding with <code>:model</code></li>
                <li>Conditional rendering with <code>:if</code> / <code>:else</code></li>
                <li>List rendering with <code>:for</code></li>
                <li>Computed properties and watchers</li>
                <li>Props, slots, refs, and events</li>
                <li>Custom directives with lifecycle hooks</li>
                <li>Data stores for shared state</li>
                <li>Error boundaries</li>
            </ul>
        </div>
    `,

    data: () => ({}),

    styles: `
        .about { max-width: 640px; }
        h1 {
            font-size: 32px;
            font-weight: 800;
            color: #1a1a2e;
            margin: 0 0 16px;
        }
        h2 {
            font-size: 20px;
            font-weight: 700;
            color: #1a1a2e;
            margin: 28px 0 12px;
        }
        p {
            font-size: 15px;
            color: #555;
            line-height: 1.7;
            margin: 0 0 8px;
        }
        ul {
            padding-left: 20px;
            margin: 0 0 8px;
        }
        li {
            font-size: 14px;
            color: #555;
            line-height: 1.8;
        }
        code {
            background: #f0f1f3;
            padding: 2px 6px;
            border-radius: 4px;
            font-size: 13px;
        }
    `
});
