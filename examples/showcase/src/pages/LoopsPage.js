export default Deezul.Component({
    template: `
        <div class="page">
            <h1>Loops & Conditionals</h1>
            <p class="intro">Render lists with <code>:for</code> and toggle content with <code>:if</code>.</p>

            <h2>For Loops</h2>
            <p>Use <code>:for="item in array"</code> to repeat an element for each item in an array:</p>
            <pre class="code-block" :pre><code>&lt;ul&gt;
    &lt;li :for="fruit in fruits"&gt;{{ fruit }}&lt;/li&gt;
&lt;/ul&gt;</code></pre>

            <h3>Index Variable</h3>
            <p>Access the loop index with <code>:index</code>:</p>
            <pre class="code-block" :pre><code>&lt;div :for="user in users" :index="idx"&gt;
    {{ idx }}: {{ user.name }}
&lt;/div&gt;</code></pre>

            <h3>Array Mutations</h3>
            <p>The reactivity system detects array mutations and updates the DOM efficiently:</p>
            <pre class="code-block" :pre><code>methods: {
    addItem() {
        this.items.push({ name: 'New Item' });
    },
    removeFirst() {
        this.items.splice(0, 1);
    },
    replaceAll() {
        this.items = [{ name: 'Fresh' }];
    }
}</code></pre>

            <h2>Live Demo — Todo List</h2>
            <div class="demo-box">
                <div class="demo-controls">
                    <input :model="newTodo" placeholder="Add a todo..." class="demo-input" />
                    <button @click="addTodo" class="demo-btn">Add</button>
                </div>
                <ul class="todo-list">
                    <li :for="todo in todos" :index="i" class="todo-item">
                        <span>{{ todo }}</span>
                        <button @click="removeTodo" class="remove-btn">x</button>
                    </li>
                </ul>
                <p class="todo-count">{{ todos.length }} items</p>
            </div>

            <h2>Conditionals</h2>
            <p>Use <code>:if</code>, <code>:else-if</code>, and <code>:else</code> to conditionally render elements:</p>
            <pre class="code-block" :pre><code>&lt;div :if="status === 'loading'"&gt;Loading...&lt;/div&gt;
&lt;div :else-if="status === 'error'"&gt;Something went wrong.&lt;/div&gt;
&lt;div :else&gt;Content loaded!&lt;/div&gt;</code></pre>
            <p>Only the matching branch renders. When the condition changes, branches swap efficiently.</p>

            <h2>Live Demo — Toggle</h2>
            <div class="demo-box">
                <div class="demo-controls">
                    <button @click="setStatus" class="demo-btn">Cycle Status</button>
                    <span class="status-label">Current: {{ status }}</span>
                </div>
                <div class="demo-output">
                    <p :if="status === 'loading'" class="status-msg">Loading data...</p>
                    <p :else-if="status === 'error'" class="status-msg error">Error! Something went wrong.</p>
                    <p :else class="status-msg success">Data loaded successfully.</p>
                </div>
            </div>

            <p class="next">Next: <a href="/computed">Computed Properties & Watchers</a></p>
        </div>
    `,

    data: () => ({
        newTodo: '',
        todos: ['Learn Deezul', 'Build an app', 'Deploy it'],
        status: 'loading'
    }),

    methods: {
        addTodo() {
            if (this.newTodo.trim()) {
                this.todos.push(this.newTodo.trim());
                this.newTodo = '';
            }
        },
        removeTodo(event) {
            const li = event.target.closest('li');
            const items = li.parentElement.children;
            let idx = 0;
            for (let i = 0; i < items.length; i++) {
                if (items[i] === li) { idx = i; break; }
            }
            this.todos.splice(idx, 1);
        },
        setStatus() {
            const cycle = ['loading', 'error', 'success'];
            const i = cycle.indexOf(this.status);
            this.status = cycle[(i + 1) % cycle.length];
        }
    },

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
        .demo-box {
            background: #fff; border: 1px solid #e0e4e8; border-radius: 10px;
            padding: 24px; margin: 12px 0 16px;
        }
        .demo-controls { display: flex; gap: 8px; align-items: center; margin-bottom: 16px; }
        .demo-input {
            flex: 1; padding: 8px 12px; border: 1px solid #ddd; border-radius: 6px;
            font-size: 14px; outline: none;
        }
        .demo-input:focus { border-color: #00d4ff; }
        .demo-btn {
            padding: 8px 16px; background: #1a1a2e; color: #fff; border: none;
            border-radius: 6px; font-size: 13px; cursor: pointer;
        }
        .demo-btn:hover { background: #2a2a4e; }
        .todo-list { list-style: none; padding: 0; margin: 0; }
        .todo-item {
            display: flex; justify-content: space-between; align-items: center;
            padding: 8px 12px; border-bottom: 1px solid #eee; font-size: 14px;
        }
        .remove-btn {
            background: none; border: none; color: #c44; cursor: pointer;
            font-size: 14px; font-weight: bold; padding: 2px 8px; border-radius: 4px;
        }
        .remove-btn:hover { background: #fee; }
        .todo-count { font-size: 13px; color: #888; margin-top: 8px; }
        .status-label { font-size: 14px; color: #666; }
        .demo-output { margin-top: 12px; }
        .status-msg { font-size: 15px; font-weight: 600; padding: 12px; border-radius: 6px; background: #eef6ff; color: #2266aa; }
        .status-msg.error { background: #fef0f0; color: #c44; }
        .status-msg.success { background: #f0fef0; color: #2a7; }
        .next { margin-top: 32px; font-size: 15px; color: #555; }
        .next a { color: #00d4ff; text-decoration: none; font-weight: 600; }
        .next a:hover { text-decoration: underline; }
    `
});
