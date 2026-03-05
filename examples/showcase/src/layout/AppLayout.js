export default Deezul.Component({
    template: `
        <div class="layout">
            <aside class="sidebar">
                <a href="/" class="brand">Deezul</a>
                <p class="tagline">Framework Guide</p>
                <nav class="nav">
                    <a href="/" class="nav-link">Introduction</a>
                    <a href="/getting-started" class="nav-link">Getting Started</a>
                    <a href="/components" class="nav-link">Components</a>
                    <a href="/reactivity" class="nav-link">Reactivity</a>
                    <a href="/template-syntax" class="nav-link">Template Syntax</a>
                    <a href="/loops-conditionals" class="nav-link">Loops & Conditionals</a>
                    <a href="/computed" class="nav-link">Computed & Watchers</a>
                    <a href="/routing" class="nav-link">Routing</a>
                    <a href="/data-stores" class="nav-link">Data Stores</a>
                    <a href="/lifecycle" class="nav-link">Lifecycle & Errors</a>
                </nav>
                <div class="sidebar-footer">
                    <a href="https://github.com/S-t-u-r-m/deezul" class="gh-link" target="_blank">GitHub</a>
                </div>
            </aside>
            <main class="content">
                <div class="construction-banner">Under Construction - This guide is a work in progress.</div>
                <router-component></router-component>
            </main>
        </div>
    `,

    data: () => ({}),

    styles: `
        .layout {
            display: flex;
            min-height: 100vh;
        }
        .sidebar {
            width: 240px;
            min-width: 240px;
            background: #1a1a2e;
            padding: 24px 0;
            display: flex;
            flex-direction: column;
            position: fixed;
            top: 0;
            left: 0;
            bottom: 0;
            overflow-y: auto;
        }
        .brand {
            font-size: 22px;
            font-weight: 800;
            color: #00d4ff;
            text-decoration: none;
            padding: 0 20px;
        }
        .tagline {
            font-size: 12px;
            color: #667;
            padding: 4px 20px 0;
            margin: 0;
        }
        .nav {
            display: flex;
            flex-direction: column;
            margin-top: 28px;
            gap: 2px;
        }
        .nav-link {
            color: #aab;
            text-decoration: none;
            padding: 9px 20px;
            font-size: 14px;
            transition: color 0.15s, background 0.15s;
        }
        .nav-link:hover {
            color: #fff;
            background: rgba(255,255,255,0.07);
        }
        .sidebar-footer {
            margin-top: auto;
            padding: 16px 20px;
        }
        .gh-link {
            color: #667;
            text-decoration: none;
            font-size: 13px;
        }
        .gh-link:hover {
            color: #aab;
        }
        .construction-banner {
            background: #fff3cd;
            color: #856404;
            border: 1px solid #ffc107;
            border-radius: 6px;
            padding: 10px 16px;
            font-size: 14px;
            font-weight: 600;
            margin-bottom: 24px;
        }
        .content {
            flex: 1;
            margin-left: 240px;
            padding: 40px 56px;
            background: #fafbfc;
            min-height: 100vh;
        }
    `
});
