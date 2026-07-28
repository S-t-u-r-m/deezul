/**
 * rebind.test.js — a DOM binding that depends on an object-valued property must
 * keep firing when that property is REASSIGNED (null↔object, object↔object,
 * object→null), not just when the object is deeply mutated.
 *
 * Regression: addBinding/getBindings home an object-valued dependency on the
 * VALUE's identity (SELF_BINDINGS). A binding registered while the property held
 * one value (null, or object A) was stranded once the property was reassigned to
 * a different value — getBindings routed the lookup to the new value and never
 * found it. Common victims: `selected`, `current`, `activeItem`, async-loaded
 * models bound via :class / {{ }} / attrs.
 */

import createReactivity, { addBinding } from '../../src/runtime/Reactivity.js';
import { flushSync } from '../../src/runtime/DataProxy.js';
// Registers renderUpdates (no DOM needed — our bindings use a recorder applyFn).
import '../../src/runtime/render.js';

let failures = 0;
function check(name, cond) {
    if (cond) console.log(`  ok    ${name}`);
    else { failures++; console.error(`  FAIL  ${name}`); }
}

// Register a binding on (proxy, prop) whose applyFn records the value it fires with.
function bindRecorder(proxy, prop) {
    const calls = [];
    addBinding(proxy, prop, {}, { applyFn: (value) => calls.push(value) });
    return calls;
}

// 1. null → object (the reported bug)
{
    const { proxy } = createReactivity({ data: { selected: null } });
    const calls = bindRecorder(proxy, 'selected');
    proxy.selected = { id: 1 };
    flushSync();
    check('null→object fires the binding', calls.length === 1 && calls[0] && calls[0].id === 1);
}

// 2. object → object (identity swap)
{
    const { proxy } = createReactivity({ data: { selected: { id: 1 } } });
    const calls = bindRecorder(proxy, 'selected');
    proxy.selected = { id: 2 };
    flushSync();
    check('object→object fires the binding', calls.length === 1 && calls[0] && calls[0].id === 2);
}

// 3. object → null
{
    const { proxy } = createReactivity({ data: { selected: { id: 1 } } });
    const calls = bindRecorder(proxy, 'selected');
    proxy.selected = null;
    flushSync();
    check('object→null fires the binding', calls.length === 1 && calls[0] === null);
}

// 4. deep mutation STILL fires after a reassignment (object-dep reactivity preserved)
{
    const { proxy } = createReactivity({ data: { selected: null } });
    const calls = bindRecorder(proxy, 'selected');
    proxy.selected = { id: 1 };
    flushSync();
    calls.length = 0;
    proxy.selected.id = 99;
    flushSync();
    check('deep mutation after reassign still fires the binding', calls.length >= 1);
}

// 5. two properties sharing an object: reassigning one must not strand the other
{
    const shared = { id: 1 };
    const { proxy } = createReactivity({ data: { a: null, b: shared } });
    const aCalls = bindRecorder(proxy, 'a');
    const bCalls = bindRecorder(proxy, 'b');
    proxy.a = proxy.b;          // a now references the same object as b
    flushSync();
    aCalls.length = 0; bCalls.length = 0;
    proxy.a = { id: 2 };        // reassign a only
    flushSync();
    check('reassigning a fires a-binding', aCalls.length === 1 && aCalls[0].id === 2);
    check('reassigning a leaves b-binding untouched', bCalls.length === 0);
    bCalls.length = 0;
    proxy.b = { id: 3 };        // b must still be reactive to its own reassignment
    flushSync();
    check('b still reactive after a moved off the shared object', bCalls.length === 1 && bCalls[0].id === 3);
}

// 6. primitive→primitive baseline unaffected
{
    const { proxy } = createReactivity({ data: { n: 0 } });
    const calls = bindRecorder(proxy, 'n');
    proxy.n = 5;
    flushSync();
    check('primitive reassignment fires', calls.length === 1 && calls[0] === 5);
}

if (failures) { console.error(`\n${failures} test(s) FAILED`); process.exit(1); }
else console.log('\nAll rebind tests passed');
