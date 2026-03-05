/**
 * styleProcessor tests
 */

import styleProcessor from '../../src/compiler/library/styleProcessor.js';

const testCss = `
.counter-card {
    background: white;
    border: 2px solid #667eea;
    border-radius: 8px;
    padding: 20px;
}

.counter-card h4 {
    margin: 0 0 15px 0;
    color: #667eea;
}

.counter-display {
    background: #f5f5f5;
    padding: 15px;
    font-size: 24px;
}

button:hover {
    background: #5a6fd6;
}
`;

const shadowCss = `
:host {
    display: block;
    padding: 20px;
}

:host(.active) {
    border: 2px solid blue;
}

::slotted(p) {
    color: red;
}
`;

console.log('=== Style Processor Tests ===\n');

// Test 1: Parse and generate
console.log('1. Parse and Generate');
const ast = styleProcessor.parse(testCss);
const regenerated = styleProcessor.generate(ast);
console.log('Parsed and regenerated successfully');
console.log('---\n');

// Test 2: Scope styles
console.log('2. Scope Styles (scopeId: abc123)');
const scoped = styleProcessor.scopeStyles(testCss, 'abc123');
console.log(scoped);
console.log('---\n');

// Test 3: Minify
console.log('3. Minify');
const minified = styleProcessor.minify(testCss);
console.log(minified);
console.log('---\n');

// Test 4: Get selectors
console.log('4. Get Selectors');
const selectors = styleProcessor.getSelectors(testCss);
console.log(selectors);
console.log('---\n');

// Test 5: Validate (valid CSS)
console.log('5. Validate (valid CSS)');
const errors = styleProcessor.validate(testCss);
console.log('Errors:', errors.length === 0 ? 'None' : errors);
console.log('---\n');

// Test 6: Validate (invalid CSS)
console.log('6. Validate (invalid CSS)');
const badCss = '.foo { color: ; }';
const badErrors = styleProcessor.validate(badCss);
console.log('Errors:', badErrors);
console.log('---\n');

// Test 7: Shadow DOM detection
console.log('7. Shadow DOM Selector Detection');
console.log('Has shadow selectors (testCss):', styleProcessor.hasShadowSelectors(testCss));
console.log('Has shadow selectors (shadowCss):', styleProcessor.hasShadowSelectors(shadowCss));
console.log('---\n');

// Test 8: Transform :host
console.log('8. Transform :host selectors');
const transformed = styleProcessor.transformHostSelectors(shadowCss, 'abc123');
console.log(transformed);
console.log('---\n');

// Test 9: Full processing (Shadow DOM mode)
console.log('9. Process Styles (Shadow DOM mode)');
const shadowResult = styleProcessor.processStyles(testCss, { shadow: true });
console.log('CSS length:', shadowResult.css.length);
console.log('Selectors:', shadowResult.selectors);
console.log('Errors:', shadowResult.errors);
console.log('---\n');

// Test 10: Full processing (Scoped mode)
console.log('10. Process Styles (Scoped mode)');
const scopedResult = styleProcessor.processStyles(testCss, {
    shadow: false,
    scopeId: 'xyz789',
    minify: true
});
console.log('CSS:', scopedResult.css);
console.log('---\n');

console.log('=== All tests complete ===');
