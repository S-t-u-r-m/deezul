export default Deezul.Component({
    template: `
        <div class="page">
            <h1>Template Syntax</h1>
            <p class="intro">Deezul templates use a concise binding syntax for attributes, events, and two-way data flow.</p>

            <h2>Attribute Binding</h2>
            <p>Prefix an attribute with <code>:</code> to bind it to a reactive value:</p>
            <pre class="code-block" :pre><code>&lt;div :class="activeClass"&gt;Styled&lt;/div&gt;
&lt;img :src="imageUrl" /&gt;
&lt;a :href="link"&gt;Click&lt;/a&gt;</code></pre>

            <h2>Boolean Attributes</h2>
            <p>Boolean attributes like <code>disabled</code>, <code>checked</code>, and <code>hidden</code> are handled automatically. When the bound value is <code>false</code>, the attribute is removed entirely:</p>
            <pre class="code-block" :pre><code>&lt;button :disabled="isLoading"&gt;Submit&lt;/button&gt;
&lt;input type="checkbox" :checked="isActive" /&gt;</code></pre>

            <h2>Event Handling</h2>
            <p>Use <code>@</code> to bind event handlers:</p>
            <pre class="code-block" :pre><code>&lt;button @click="handleClick"&gt;Click Me&lt;/button&gt;
&lt;input @input="onType" @keydown="onKey" /&gt;
&lt;form @submit="onSubmit"&gt;...&lt;/form&gt;</code></pre>
            <p>Event handlers are methods defined in your component's <code>methods</code> object. The event object is passed as the first argument:</p>
            <pre class="code-block" :pre><code>// In your component's methods object:
handleClick(event) {
    console.log('Clicked!', event.target);
},
onSubmit(event) {
    event.preventDefault();
    // handle form
}</code></pre>

            <h2>Two-Way Binding</h2>
            <p>Use <code>:model</code> for two-way binding on form inputs:</p>
            <pre class="code-block" :pre><code>&lt;input :model="name" /&gt;
&lt;textarea :model="bio"&gt;&lt;/textarea&gt;
&lt;select :model="role"&gt;
    &lt;option value="admin"&gt;Admin&lt;/option&gt;
    &lt;option value="user"&gt;User&lt;/option&gt;
&lt;/select&gt;</code></pre>
            <p>When the user types, <code>this.name</code> updates. When you set <code>this.name</code> in code, the input value updates.</p>

            <h2>Live Demo</h2>
            <div class="demo-box">
                <div class="demo-row">
                    <label>Name:</label>
                    <input :model="name" class="demo-input" />
                </div>
                <div class="demo-row">
                    <label>Color:</label>
                    <select :model="color" class="demo-input">
                        <option value="blue">Blue</option>
                        <option value="green">Green</option>
                        <option value="red">Red</option>
                    </select>
                </div>
                <p class="demo-result">Hello, <strong>{{ name }}</strong>! Your color is <strong>{{ color }}</strong>.</p>
                <button @click="resetForm" class="demo-btn">Reset</button>
            </div>

            <p class="next">Next: <a href="/loops-conditionals">Loops & Conditionals</a> — rendering lists and conditional content.</p>
        </div>
    `,

    data: () => ({
        name: 'Developer',
        color: 'blue'
    }),

    methods: {
        resetForm() {
            this.name = 'Developer';
            this.color = 'blue';
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
        .demo-box {
            background: #fff; border: 1px solid #e0e4e8; border-radius: 10px;
            padding: 24px; margin: 12px 0 16px;
        }
        .demo-row { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
        .demo-row label { font-size: 14px; color: #444; min-width: 60px; }
        .demo-input {
            flex: 1; padding: 8px 12px; border: 1px solid #ddd; border-radius: 6px;
            font-size: 14px; outline: none;
        }
        .demo-input:focus { border-color: #00d4ff; }
        .demo-result { font-size: 15px; margin: 16px 0 12px; }
        .demo-btn {
            padding: 8px 16px; background: #1a1a2e; color: #fff; border: none;
            border-radius: 6px; font-size: 13px; cursor: pointer;
        }
        .demo-btn:hover { background: #2a2a4e; }
        .next { margin-top: 32px; font-size: 15px; color: #555; }
        .next a { color: #00d4ff; text-decoration: none; font-weight: 600; }
        .next a:hover { text-decoration: underline; }
    `
});
