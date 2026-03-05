export default Deezul.Component({
    template: `
        <div class="layout">
            <nav class="navbar">
                <a href="/" class="brand">Deezul</a>
                <div class="nav-links">
                    <a href="/" class="nav-link">Home</a>
                    <a href="/about" class="nav-link">About</a>
                    <a href="/counter" class="nav-link">Counter</a>
                </div>
            </nav>
            <main class="content">
                <router-component></router-component>
            </main>
        </div>
    `,

    data: () => ({}),

    styles: `
        .layout {
            min-height: 100vh;
            display: flex;
            flex-direction: column;
        }
        .navbar {
            display: flex;
            align-items: center;
            padding: 0 24px;
            height: 56px;
            background: #1a1a2e;
            color: #fff;
        }
        .brand {
            font-size: 20px;
            font-weight: 700;
            color: #00d4ff;
            text-decoration: none;
            margin-right: 32px;
        }
        .nav-links {
            display: flex;
            gap: 8px;
        }
        .nav-link {
            color: #aaa;
            text-decoration: none;
            padding: 6px 14px;
            border-radius: 6px;
            font-size: 14px;
            transition: color 0.15s, background 0.15s;
        }
        .nav-link:hover {
            color: #fff;
            background: rgba(255,255,255,0.08);
        }
        .content {
            flex: 1;
            padding: 40px 48px;
            background: #fafbfc;
        }
    `
});
