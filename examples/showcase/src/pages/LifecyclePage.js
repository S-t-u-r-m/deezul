export default Deezul.Component({
    template: `
        <div class="page">
            <h1>Lifecycle & Errors</h1>
            <p class="intro">Components have lifecycle hooks that fire at specific points, plus built-in error handling with recovery.</p>

            <h2>Lifecycle Hooks</h2>
            <p>Hooks are defined as methods on the component definition, prefixed with <code>$</code>:</p>
            <pre class="code-block" :pre><code>export default Deezul.Component({
    template: \`&lt;div&gt;{{ message }}&lt;/div&gt;\`,

    data: () => ({
        message: ''
    }),

    $created() {
        // Called after proxy created, before DOM render
        // Good for: initial data fetching, setup
        console.log('Component created');
    },

    $mounted() {
        // Called after template is rendered into Shadow DOM
        // Good for: DOM access, $refs, third-party init
        this.message = 'Mounted!';
    },

    $updated() {
        // Called after a reactive update completes
        // WARNING: Do NOT modify reactive data here (infinite loop!)
        console.log('DOM updated');
    },

    $unmounted() {
        // Called before component cleanup
        // Good for: remove listeners, cancel timers
        console.log('Cleaning up');
    }
});</code></pre>

            <h2>Hook Order</h2>
            <div class="flow-diagram">
                <div class="flow-step">$created</div>
                <div class="flow-arrow">&darr;</div>
                <div class="flow-step">Template renders</div>
                <div class="flow-arrow">&darr;</div>
                <div class="flow-step">$mounted</div>
                <div class="flow-arrow">&darr;</div>
                <div class="flow-step loop">$updated (on each reactive change)</div>
                <div class="flow-arrow">&darr;</div>
                <div class="flow-step">$unmounted</div>
            </div>

            <h2>Async Hooks</h2>
            <p>Hooks can be <code>async</code> — useful for data fetching:</p>
            <pre class="code-block" :pre><code>async $mounted() {
    const store = await Deezul.getDataStore('user-store');
    this.userName = store.name;

    const response = await fetch('/api/data');
    this.items = await response.json();
}</code></pre>

            <h2>Error Handling</h2>
            <p>Add a <code>$error</code> hook to handle errors within a component:</p>
            <pre class="code-block" :pre><code>$error(errorInfo) {
    console.log('Error in', errorInfo.phase);
    console.log('Message:', errorInfo.message);

    // Return true to mark as handled
    return true;

    // Or return HTML for custom fallback UI:
    // return '&lt;div class="error"&gt;Something broke&lt;/div&gt;';
}</code></pre>

            <h3>Error Info Object</h3>
            <table class="info-table">
                <tr><th>Property</th><th>Description</th></tr>
                <tr><td><code>type</code></td><td>Component type name</td></tr>
                <tr><td><code>phase</code></td><td>Where error occurred: mount, created, mounted, event, binding</td></tr>
                <tr><td><code>error</code></td><td>The original Error object</td></tr>
                <tr><td><code>message</code></td><td>Error message string</td></tr>
                <tr><td><code>instanceId</code></td><td>Unique component instance ID</td></tr>
            </table>

            <h2>Global Error Handler</h2>
            <p>Catch errors from any component:</p>
            <pre class="code-block" :pre><code>Deezul.registerGlobalErrorHandler((errorInfo) => {
    // Log to analytics service
    analytics.track('component_error', errorInfo);

    // Return true to prevent default fallback UI
    return true;
});</code></pre>

            <h2>Recovery</h2>
            <p>When a fatal error occurs during mount, Deezul shows a fallback UI with a retry button. The component will attempt to remount (up to 3 attempts by default).</p>
            <p>Configure recovery behavior:</p>
            <pre class="code-block" :pre><code>Deezul.init({
    errors: {
        logToConsole: true,
        showStackTrace: false,
        maxRecoveryAttempts: 3
    }
});</code></pre>

            <div class="tip-box">
                <strong>Tip:</strong> Use <code>$created</code> for data setup, <code>$mounted</code> for DOM interaction, and <code>$unmounted</code> for cleanup. Keep <code>$updated</code> read-only to avoid infinite loops.
            </div>

            <p class="done">That's the complete Deezul guide! Go back to <a href="/">Introduction</a> or check the <a href="https://github.com/S-t-u-r-m/deezul" target="_blank">source on GitHub</a>.</p>
        </div>
    `,

    data: () => ({}),

    styles: `
        .page { max-width: 760px; }
        h1 { font-size: 32px; font-weight: 800; color: #1a1a2e; margin: 0 0 8px; }
        h2 { font-size: 19px; font-weight: 700; color: #1a1a2e; margin: 32px 0 10px; }
        h3 { font-size: 16px; font-weight: 600; color: #333; margin: 20px 0 8px; }
        .intro { font-size: 16px; color: #555; line-height: 1.6; margin: 0 0 24px; }
        p { font-size: 14px; color: #444; line-height: 1.6; margin: 0 0 12px; }
        code { background: #eef; padding: 2px 5px; border-radius: 3px; font-size: 13px; font-family: 'Consolas', 'Monaco', monospace; }
        .code-block {
            background: #1e1e2e; color: #cdd6f4; padding: 16px 20px; border-radius: 8px;
            font-size: 13px; line-height: 1.6; overflow-x: auto; margin: 0 0 12px;
            font-family: 'Consolas', 'Monaco', 'Courier New', monospace; white-space: pre;
        }
        .code-block code { background: none; padding: 0; color: inherit; font-family: inherit; }
        .flow-diagram {
            display: flex; flex-direction: column; align-items: center;
            background: #fff; border: 1px solid #e0e4e8; border-radius: 10px;
            padding: 24px; margin: 12px 0 16px; gap: 4px;
        }
        .flow-step {
            background: #1a1a2e; color: #fff; padding: 10px 24px; border-radius: 8px;
            font-size: 14px; font-weight: 600; font-family: 'Consolas', monospace;
        }
        .flow-step.loop { background: #2a5a8e; }
        .flow-arrow { font-size: 18px; color: #aaa; }
        .info-table { width: 100%; border-collapse: collapse; margin: 0 0 12px; font-size: 14px; }
        .info-table th { text-align: left; padding: 8px 12px; background: #eef2f5; border-bottom: 2px solid #ddd; color: #333; }
        .info-table td { padding: 8px 12px; border-bottom: 1px solid #eee; color: #444; }
        .info-table code { font-size: 12px; }
        .tip-box {
            background: #eef6ff; border: 1px solid #bee; border-radius: 8px;
            padding: 16px 20px; margin: 24px 0; font-size: 14px; color: #336;
        }
        .done { margin-top: 32px; font-size: 15px; color: #555; }
        .done a { color: #00d4ff; text-decoration: none; font-weight: 600; }
        .done a:hover { text-decoration: underline; }
    `
});
