/**
 * Test scriptParser
 */

import { parseComponent, parseComponentFile } from '../../src/compiler/library/scriptParser.js';

// Test source matching CounterCard.js
const counterSource = `
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

    styles: \`
        .counter-card {
            background: white;
            border: 2px solid #667eea;
        }
        .counter-controls button {
            background: #667eea;
        }
    \`
});
`;

// Test with data function
const withDataSource = `
export default Deezul.Component({
    template: \`<div>{{ count }}</div>\`,

    data: () => ({
        count: 0,
        items: [],
        user: null
    }),

    methods: {
        increment() {
            this.count++;
        }
    },

    computed: {
        doubled() {
            return this.count * 2;
        }
    },

    watch: {
        count(newVal, oldVal) {
            console.log('Count changed');
        }
    },

    static: {
        API_URL: 'https://api.example.com'
    },

    styles: \`.demo { color: red; }\`
});
`;

console.log('=== Script Parser Tests ===\n');

// Test 1: Counter component
console.log('1. Counter Component Parse');
console.log('--------------------------');
try {
    const counter = parseComponent(counterSource);
    console.log('Template:', counter.template ? counter.template.substring(0, 50) + '...' : 'null');
    console.log('Methods:', counter.method ? 'found' : 'null');
    console.log('Styles:', counter.style ? counter.style.substring(0, 50) + '...' : 'null');
    console.log('Data:', counter.data || 'null');
    console.log('');
} catch (e) {
    console.error('Error:', e.message);
}

// Test 2: Full component with all sections
console.log('2. Full Component with All Sections');
console.log('------------------------------------');
try {
    const full = parseComponent(withDataSource);
    console.log('Template:', full.template || 'null');
    console.log('Data:', full.data || 'null');
    console.log('Methods:', full.method ? 'found' : 'null');
    console.log('Computed:', full.computed ? 'found' : 'null');
    console.log('Watch:', full.watcher ? 'found' : 'null');
    console.log('Static:', full.staticData ? 'found' : 'null');
    console.log('Styles:', full.style || 'null');
    console.log('');
} catch (e) {
    console.error('Error:', e.message);
}

// Test 3: Full output
console.log('3. Full Parsed Output');
console.log('---------------------');
try {
    const full = parseComponent(withDataSource);
    console.log('data:', full.data);
    console.log('');
    console.log('method:', full.method);
    console.log('');
    console.log('computed:', full.computed);
    console.log('');
    console.log('watcher:', full.watcher);
    console.log('');
    console.log('staticData:', full.staticData);
} catch (e) {
    console.error('Error:', e.message);
}

// Test 4: Regex literals in methods must not break body extraction.
// A regex like /[&<>"]/ or /[",\n]/ carries quotes/angle-brackets/braces that
// would desync a naive brace/string scanner (extractBalanced). Regression guard.
console.log('4. Regex literals in methods');
console.log('----------------------------');
{
    const regexSrc = 'export default Deezul.Component({\n' +
        '    template: `<div>{{ n }}</div>`,\n' +
        '    data: () => ({ n: 0 }),\n' +
        '    methods: {\n' +
        '        tags(s) { return s.replace(/[&<>"]/g, ""); },\n' +
        '        csv(v) { return /[",\\n]/.test(v) ? \'"\' + v.replace(/"/g, \'""\') + \'"\' : v; },\n' +
        '        slug(s) { return s.replace(/[^a-z0-9]+/gi, "-"); },\n' +
        '        ratio(a, b) { return a / b; }\n' +
        '    },\n' +
        '    styles: `.x { color: red }`\n' +
        '});';
    const p = parseComponent(regexSrc);
    if (!p.template) { console.error('FAIL: body not extracted (regex desynced the scanner)'); process.exit(1); }
    if (!p.method) { console.error('FAIL: methods not extracted with regex literals'); process.exit(1); }
    for (const m of ['tags', 'csv', 'slug', 'ratio']) {
        if (!p.method.includes(m)) { console.error('FAIL: missing method ' + m); process.exit(1); }
    }
    if (!p.method.includes('a / b')) { console.error('FAIL: division operator not preserved'); process.exit(1); }
    console.log('PASS: regex literals parsed, division preserved\n');
}

console.log('\n=== All tests complete ===');
