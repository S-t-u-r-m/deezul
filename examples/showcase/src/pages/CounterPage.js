export default Deezul.Component({
    template: `
        <div class="counter-page">
            <h1>Counter</h1>
            <p class="desc">This counter is backed by a data store — shared reactive state that persists across navigation. The count survives even if you leave and come back.</p>

            <div class="counter-box">
                <span class="count">{{ count }}</span>
                <div class="buttons">
                    <button class="btn" @click="increment">+</button>
                    <button class="btn" @click="decrement">&minus;</button>
                    <button class="btn btn-reset" @click="reset">Reset</button>
                </div>
            </div>
        </div>
    `,

    data: () => ({
        count: 0
    }),

    async $mounted() {
        const store = await Deezul.getDataStore('counter-store');
        this.count = store.count;
    },

    methods: {
        async increment() {
            const store = await Deezul.getDataStore('counter-store');
            store.count++;
            this.count = store.count;
        },
        async decrement() {
            const store = await Deezul.getDataStore('counter-store');
            store.count--;
            this.count = store.count;
        },
        async reset() {
            const store = await Deezul.getDataStore('counter-store');
            store.count = 0;
            this.count = store.count;
        }
    },

    styles: `
        .counter-page { max-width: 480px; }
        h1 {
            font-size: 32px;
            font-weight: 800;
            color: #1a1a2e;
            margin: 0 0 12px;
        }
        .desc {
            font-size: 14px;
            color: #666;
            line-height: 1.6;
            margin: 0 0 28px;
        }
        .counter-box {
            background: #fff;
            border: 1px solid #e8eaed;
            border-radius: 10px;
            padding: 32px;
            text-align: center;
        }
        .count {
            font-size: 64px;
            font-weight: 800;
            color: #00d4ff;
            display: block;
            margin-bottom: 24px;
        }
        .buttons {
            display: flex;
            justify-content: center;
            gap: 8px;
        }
        .btn {
            width: 48px;
            height: 48px;
            font-size: 22px;
            font-weight: 700;
            border: none;
            border-radius: 8px;
            background: #00d4ff;
            color: #fff;
            cursor: pointer;
            transition: background 0.15s;
        }
        .btn:hover { background: #00b8d9; }
        .btn-reset {
            width: auto;
            padding: 0 20px;
            font-size: 14px;
            background: transparent;
            color: #666;
            border: 1px solid #ddd;
        }
        .btn-reset:hover { background: #f5f5f5; }
    `
});
