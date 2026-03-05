export default Deezul.Component({
    template: `
        <div class="page">
            <h1>Routing</h1>
            <p class="intro">Deezul includes a built-in SPA router using the History API. Define routes, layouts, and guards — no extra dependencies needed.</p>

            <h2>Basic Setup</h2>
            <p>Pass a <code>routes</code> array to <code>Deezul.init()</code>:</p>
            <pre class="code-block" :pre><code>Deezul.init({
    rootElement: 'app',
    modules,
    routes: [
        {
            path: '/',
            component: 'home-page',
            layouts: ['app-layout']
        },
        {
            path: '/about',
            component: 'about-page',
            layouts: ['app-layout']
        },
        {
            path: '/users/:id',
            component: 'user-detail',
            layouts: ['app-layout']
        },
    ]
});</code></pre>

            <h2>Navigation</h2>
            <p>Use standard <code>&lt;a href&gt;</code> links — the router intercepts them automatically:</p>
            <pre class="code-block" :pre><code>&lt;a href="/about"&gt;About&lt;/a&gt;
&lt;a href="/users/42"&gt;User 42&lt;/a&gt;</code></pre>
            <p>Or navigate programmatically:</p>
            <pre class="code-block" :pre><code>// Navigate to a path
Deezul.navigate('/users/42');

// Replace current history entry (no back button)
Deezul.navigate('/login', { replace: true });</code></pre>

            <h2>Route Parameters</h2>
            <p>Define dynamic segments with <code>:param</code>. Access them in your component via <code>this.$route.params</code>:</p>
            <pre class="code-block" :pre><code>// Route definition:
// {
//     path: '/users/:id',
//     component: 'user-detail'
// }

// In the component:
$mounted() {
    const userId = this.$route.params.id;
    console.log('Viewing user:', userId);
}</code></pre>

            <h2>Layouts</h2>
            <p>Layouts wrap your page components. They must include a <code>&lt;router-component&gt;</code> where the page renders:</p>
            <pre class="code-block" :pre><code>// AppLayout.js
export default Deezul.Component({
    template: \`
        &lt;div class="layout"&gt;
            &lt;nav&gt;...&lt;/nav&gt;
            &lt;main&gt;
                &lt;router-component&gt;&lt;/router-component&gt;
            &lt;/main&gt;
        &lt;/div&gt;
    \`
});</code></pre>
            <p>Multiple layouts can be nested. The outermost layout renders first, each containing a <code>&lt;router-component&gt;</code> for the next level.</p>

            <h2>Nested Routes</h2>
            <p>Define child routes with the <code>children</code> property:</p>
            <pre class="code-block" :pre><code>routes: [
    {
        path: '/dashboard',
        component: 'dashboard-layout',
        children: [
            {
                path: '/',
                component: 'dashboard-home'
            },
            {
                path: '/settings',
                component: 'dashboard-settings'
            },
        ]
    }
]</code></pre>

            <h2>Route Guards</h2>
            <p>Run logic before or after navigation:</p>
            <pre class="code-block" :pre><code>Deezul.init({
    routes: [...],
    beforeNavigate(to, from, next) {
        if (to.path === '/admin' && !isLoggedIn()) {
            next('/login');  // Redirect
        } else {
            next();  // Continue
        }
    },
    afterNavigate(to, from) {
        console.log('Navigated to', to.path);
    }
});</code></pre>

            <h2>404 Not Found</h2>
            <p>Provide a custom component for unmatched routes:</p>
            <pre class="code-block" :pre><code>Deezul.init({
    routes: [...],
    notFoundComponent: 'not-found-page'
});</code></pre>

            <h2>Base Path</h2>
            <p>For subdirectory hosting (like GitHub Pages), set <code>basePath</code>:</p>
            <pre class="code-block" :pre><code>Deezul.init({
    basePath: '/my-repo',
    routes: [...]
});</code></pre>
            <p>All route matching and link interception will account for the base path automatically.</p>

            <p class="next">Next: <a href="/data-stores">Data Stores</a> — shared reactive state across components.</p>
        </div>
    `,

    data: () => ({}),

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
        .next { margin-top: 32px; font-size: 15px; color: #555; }
        .next a { color: #00d4ff; text-decoration: none; font-weight: 600; }
        .next a:hover { text-decoration: underline; }
    `
});
