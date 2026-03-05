export default Deezul.Component({
    template: `
        <div class="home">
            <h1>Welcome to Deezul</h1>
            <p class="subtitle">A lightweight reactive UI framework built on Web Components, Proxy-based reactivity, and bytecode-compiled bindings.</p>

            <div class="cards">
                <div class="card">
                    <h3>Reactive</h3>
                    <p>Proxy-based data binding with automatic DOM updates. Change data, the UI follows.</p>
                </div>
                <div class="card">
                    <h3>Components</h3>
                    <p>Shadow DOM web components with props, slots, lifecycle hooks, and scoped styles.</p>
                </div>
                <div class="card">
                    <h3>Fast</h3>
                    <p>Bytecode-compiled templates with no virtual DOM overhead. Direct, targeted updates.</p>
                </div>
            </div>

            <p class="hint">Try the <a href="/counter">Counter</a> page to see reactivity in action.</p>
        </div>
    `,

    data: () => ({}),

    styles: `
        .home { max-width: 720px; }
        h1 {
            font-size: 36px;
            font-weight: 800;
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
            grid-template-columns: repeat(3, 1fr);
            gap: 16px;
            margin-bottom: 32px;
        }
        .card {
            background: #fff;
            border: 1px solid #e8eaed;
            border-radius: 10px;
            padding: 24px;
        }
        .card h3 {
            font-size: 17px;
            color: #1a1a2e;
            margin: 0 0 8px;
        }
        .card p {
            font-size: 13px;
            color: #666;
            line-height: 1.5;
            margin: 0;
        }
        .hint {
            font-size: 14px;
            color: #888;
        }
        .hint a {
            color: #00d4ff;
            text-decoration: none;
            font-weight: 600;
        }
        .hint a:hover { text-decoration: underline; }
    `
});
