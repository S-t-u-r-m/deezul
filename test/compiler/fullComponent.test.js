/**
 * Test full Deezul.Component compilation
 */

import { compileComponentToCode } from '../../src/compiler/library/main.js';

// Full component source matching Deezul 5.0 format
const counterCardSource = `
/**
 * CounterCard - Child Component with Two-Way Sync Prop
 */

export default Deezul.Component({
    template: \`
        <div class="counter-card">
            <h4>Child Counter Card</h4>
            <div class="counter-display">
                <strong>Count:</strong> {{ count }}
            </div>
            <div class="counter-controls">
                <button @click="increment">Child +1</button>
                <button @click="decrement">Child -1</button>
                <button @click="double">Double</button>
            </div>
            <p class="note">Changes made here will sync back to parent!</p>
        </div>
    \`,

    data: () => ({
        count: 0
    }),

    methods: {
        increment() {
            this.count++;
        },

        decrement() {
            this.count--;
        },

        double() {
            this.count *= 2;
        }
    },

    computed: {
        doubled() {
            return this.count * 2;
        }
    },

    styles: \`
        .counter-card {
            background: white;
            border: 2px solid #667eea;
            border-radius: 8px;
            padding: 20px;
            margin-top: 15px;
        }
        .counter-card h4 {
            margin: 0 0 15px 0;
            color: #667eea;
        }
        .counter-display {
            background: #f5f5f5;
            padding: 15px;
            border-radius: 4px;
            text-align: center;
            font-size: 24px;
            margin-bottom: 15px;
        }
        .counter-controls {
            text-align: center;
        }
        .counter-controls button {
            background: #667eea;
            color: white;
            border: none;
            padding: 8px 16px;
            margin: 5px;
            border-radius: 4px;
            cursor: pointer;
        }
        .counter-controls button:hover {
            background: #5a6fd6;
        }
        .note {
            color: #666;
            font-size: 12px;
            font-style: italic;
            margin: 15px 0 0 0;
            text-align: center;
        }
    \`
});
`;

console.log('=== Full Component Compilation Test ===\n');

try {
    const output = compileComponentToCode(counterCardSource, {
        componentName: 'CounterCard'
    });

    console.log(output);
} catch (e) {
    console.error('Compilation error:', e.message);
    console.error(e.stack);
}
