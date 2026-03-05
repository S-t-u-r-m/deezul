/**
 * Test the new codegen output format
 */

import { compile, compileToCode } from '../../src/compiler/library/main.js';

// Test template matching CounterCard
const counterTemplate = `
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
`;

// Test with expressions and attributes
const expressionTemplate = `
<div class="demo">
    <h1>{{ title }}</h1>
    <p :class="active ? 'active' : 'inactive'">Status: {{ status }}</p>
    <span>Count: {{ count + 1 }}</span>
    <button @click="toggle">Toggle</button>
    <button @click="setCount(10)">Set to 10</button>
</div>
`;

// Test with :for loop
const forLoopTemplate = `
<ul class="list">
    <li :for="(item, index) in items" :class="item.active ? 'active' : ''">
        <span>{{ index }}: {{ item.name }}</span>
        <button @click="removeItem(index)">Remove</button>
    </li>
</ul>
`;

// Test with :if/:else
const conditionalTemplate = `
<div class="status">
    <div :if="loading" class="loading">Loading...</div>
    <div :else-if="error" class="error">Error: {{ errorMessage }}</div>
    <div :else class="success">{{ data }}</div>
</div>
`;

console.log('=== Codegen New Format Tests ===\n');

// Test 1: Counter template
console.log('1. Counter Template');
console.log('-------------------');
const counterCode = compileToCode(counterTemplate, { componentName: 'CounterCard' });
console.log(counterCode);
console.log('\n');

// Test 2: Expression template
console.log('2. Expression Template');
console.log('----------------------');
const exprCode = compileToCode(expressionTemplate, { componentName: 'ExpressionDemo' });
console.log(exprCode);
console.log('\n');

// Test 3: For loop template
console.log('3. For Loop Template');
console.log('--------------------');
const forCode = compileToCode(forLoopTemplate, { componentName: 'ForLoopDemo' });
console.log(forCode);
console.log('\n');

// Test 4: Conditional template
console.log('4. Conditional Template');
console.log('-----------------------');
const condCode = compileToCode(conditionalTemplate, { componentName: 'ConditionalDemo' });
console.log(condCode);
console.log('\n');

console.log('=== All tests complete ===');
