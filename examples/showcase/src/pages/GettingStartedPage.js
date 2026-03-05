export default Deezul.Component({
    template: `
        <div class="page">
            <h1>Getting Started</h1>
            <p class="intro">Set up a Deezul project from scratch in under 5 minutes.</p>

            <h2>1. Install</h2>
            <pre class="code-block" :pre><code>npm install deezul</code></pre>
            <p class="note">This gives you the runtime bundle and the compiler CLI.</p>

            <h2>2. Project Structure</h2>
            <pre class="code-block" :pre><code>my-app/
  index.html          # App shell
  main.js             # Entry point
  modules.config.js   # Component registry
  src/
    layout/
      AppLayout.js    # Layout wrapper
    pages/
      HomePage.js     # Page components
  compiled/           # Compiler output (gitignored)</code></pre>

            <h2>3. Create a Component</h2>
            <p>Components are plain JavaScript files that export a <code>Deezul.Component()</code> call:</p>
            <pre class="code-block" :pre><code>// src/pages/HomePage.js
export default Deezul.Component({
    template: \`
        &lt;div&gt;
            &lt;h1&gt;{{ title }}&lt;/h1&gt;
            &lt;p&gt;{{ message }}&lt;/p&gt;
        &lt;/div&gt;
    \`,

    data: () => ({
        title: 'My App',
        message: 'Welcome to Deezul!'
    }),

    styles: \`
        h1 { color: #333; }
        p { color: #666; }
    \`
});</code></pre>

            <h2>4. Compile</h2>
            <p>The compiler transforms your source components into optimized bytecode:</p>
            <pre class="code-block" :pre><code># Compile a single component
npx deezul-compile src/pages/HomePage.js compiled/HomePage.compiled.js

# Or use the --watch flag during development
npx deezul-compile --watch src/ compiled/</code></pre>

            <h2>5. Register Modules</h2>
            <p>Create a <code>modules.config.js</code> to register your components:</p>
            <pre class="code-block" :pre><code>// modules.config.js
export default [
    {
        ref: 'app-layout',
        path: './compiled/AppLayout.compiled.js'
    },
    {
        ref: 'home-page',
        path: './compiled/HomePage.compiled.js'
    },
];</code></pre>

            <h2>6. Initialize the App</h2>
            <pre class="code-block" :pre><code>// main.js
import Deezul from 'deezul';
import modules from './modules.config.js';

Deezul.init({
    rootElement: 'app',
    modules,
    routes: [
        {
            path: '/',
            component: 'home-page',
            layouts: ['app-layout']
        },
    ]
});</code></pre>

            <h2>7. HTML Shell</h2>
            <pre class="code-block" :pre><code>&lt;!DOCTYPE html&gt;
&lt;html lang="en"&gt;
&lt;head&gt;
    &lt;meta charset="UTF-8"&gt;
    &lt;meta name="viewport" content="width=device-width, initial-scale=1.0"&gt;
    &lt;title&gt;My Deezul App&lt;/title&gt;
&lt;/head&gt;
&lt;body&gt;
    &lt;div id="app"&gt;&lt;/div&gt;
    &lt;script type="module" src="main.js"&gt;&lt;/script&gt;
&lt;/body&gt;
&lt;/html&gt;</code></pre>

            <h2>8. Serve</h2>
            <p>Use any static file server to run your app:</p>
            <pre class="code-block" :pre><code>npx http-server . -p 3000</code></pre>
            <p class="note">Open <code>http://localhost:3000</code> in your browser. That's it!</p>

            <p class="next">Next: Learn about <a href="/components">Components</a> in depth.</p>
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
        .note { font-size: 13px; color: #888; font-style: italic; }
        .next { margin-top: 32px; font-size: 15px; color: #555; }
        .next a { color: #00d4ff; text-decoration: none; font-weight: 600; }
        .next a:hover { text-decoration: underline; }
    `
});
