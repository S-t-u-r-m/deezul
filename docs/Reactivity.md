# Deezul Reactivity System

The reactivity system provides automatic DOM updates when data changes. It uses type-specific proxy handlers for optimal performance.

## Architecture

```
DataProxy (selects handler by JavaScript type)
    ↓
Type Handler (Object, Array, Map, Set, Date)
    ↓
dataBindMap (object → property → bindings)
    ↓
DOM Updates (via binding.applyFn)
```

## Core Concepts

### Data Binding

Bindings connect data properties to DOM nodes. When a property changes, all bound nodes update automatically.

```javascript
// Register a binding at render time
addBinding(dataObject, 'count', textNode, {
    applyFn: (value, binding) => {
        binding.node.textContent = value;
    }
});

// When data.count changes, textNode.textContent updates automatically
```

### Type-Specific Handlers

Each JavaScript type has optimized handlers:

| Type | Handler | Notes |
|------|---------|-------|
| Object | `objectHandlers` | Plain objects, custom classes |
| Array | `arrayHandlers` | Arrays with :for loop support |
| Map | `mapHandlers` | ES6 Map collections |
| Set | `setHandlers` | ES6 Set collections |
| Date | `dateHandlers` | Date objects |

### Binding Storage

Bindings are stored differently based on value type:

**Primitive values** (string, number, boolean):
```
dataBindMap.get(parentObject).get('propertyName') → Set<binding>
```

**Object values**:
```
dataBindMap.get(objectValue) → Set<binding>
```

This provides O(1) lookup for object bindings.

### For-Loop Storage

For-loop structures use a **separate** `forLoopMap` WeakMap to avoid collisions with object-value binding Sets:

```
forLoopMap.get(collectionTarget) → Set<forLoopStructure>
```

When a collection (Array, Map, Set) is mutated, the notification system:
1. **Snapshots** the for-loop Set as an array copy (prevents double-rendering if `notifyParent` adds new structures to the live Set)
2. Calls `notifyParent` (triggers `:if` conditions watching the collection)
3. Iterates the snapshot, skipping dead structures whose anchor is detached (`!anchor.isConnected`)
4. Calls type-specific render functions for surgical DOM updates
5. Cleans dead structures from the live Set (prevents memory leaks)

### Parent Notification

Collection mutations notify their parent object so conditions like `:if="items.length > 0"` re-evaluate automatically:

```javascript
function notifyParent(proxyInstance, target) {
    const parent = proxyInstance[PARENT_PROXY];
    const key = proxyInstance[PARENT_KEY];
    if (parent && key) {
        queueUpdate(parent[TARGET], key, target);
    }
}
```

### Component Proxy

Unified access to data, methods, and computed properties with a `has` trap for `with(proxy)` condition evaluation:

```javascript
const componentProxy = new Proxy(componentDef, {
    get(target, key) {
        // Priority: methods > computed > data
        if (target.methods && key in target.methods) return target.methods[key].bind(componentProxy);
        if (target.computed && key in target.computed) return target.computed[key].call(componentProxy);
        return dataProxy[key];
    },
    has(target, key) {
        if (target.methods && key in target.methods) return true;
        if (target.computed && key in target.computed) return true;
        return key in data;
    }
});
```

## API Reference

### Creating Reactivity

```javascript
import createReactivity from './Reactivity.js';

const { proxy, dataProxy, factory } = createReactivity({
    data: { count: 0, name: 'John' },
    methods: {
        increment() { this.count++; }
    },
    computed: {
        doubled() { return this.count * 2; }
    }
});

// Access data through proxy
proxy.count = 5;        // Triggers updates
proxy.increment();      // Calls method
console.log(proxy.doubled);  // Computed value
```

### Binding Registration

```javascript
import { addBinding, removeBinding, getBindings } from './Reactivity.js';

// Add a binding
const binding = addBinding(target, 'propertyName', domNode, {
    type: 'text',
    applyFn: (value, binding) => {
        binding.node.textContent = value;
    }
});

// Remove a binding
removeBinding(target, 'propertyName', domNode);

// Get all bindings for a property
const bindings = getBindings(target, 'propertyName');
```

### Dynamic Structures

For `:for` loops and `:if` conditionals:

```javascript
import {
    addArrayForLoop,
    getArrayForLoops,
    addDynamicStructure,
    getDynamicStructures,
    removeDynamicStructure
} from './Reactivity.js';

// Register a :for loop on an array
addArrayForLoop(itemsArray, {
    template: templateElement,
    anchor: anchorNode,
    instances: [],
    updateFn: (array, meta) => {
        // Handle array changes
    }
});

// Register a :if conditional
addDynamicStructure(dataObject, 'showPanel', {
    type: 'conditional',
    template: templateElement,
    anchor: anchorNode,
    updateFn: (value, structure) => {
        // Show/hide based on value
    }
});
```

### Batching Updates

Batch multiple changes into a single DOM update cycle:

```javascript
import { batch } from './Reactivity.js';

// Without batching: 3 DOM updates
data.firstName = 'John';
data.lastName = 'Doe';
data.age = 30;

// With batching: 1 DOM update cycle
batch(() => {
    data.firstName = 'John';
    data.lastName = 'Doe';
    data.age = 30;
});
```

**Template usage:**
```html
<button @click="batch(handleSubmit)">Submit</button>
```

## Performance Optimizations

### Skip Unchanged Values

Handlers automatically skip updates when the value hasn't changed:

```javascript
data.count = 5;
data.count = 5;  // No update triggered (same value)
```

### O(1) Object Binding Lookup

When a property value is an object, bindings are stored directly on that object for instant lookup:

```javascript
data.user = { name: 'John' };
// Bindings for 'user' stored on the user object itself
// Lookup: dataBindMap.get(userObject) → bindings
```

### WeakMap for Garbage Collection

`dataBindMap` uses WeakMap, so bindings are automatically cleaned up when data objects are garbage collected.

## Handler Details

### Object Handler

Handles plain objects and custom class instances.

```javascript
// Triggers objectHandlers.set
data.name = 'John';

// Triggers objectHandlers.delete
delete data.name;
```

### Array Handler

Handles arrays with special support for `:for` loops. All mutating methods are intercepted and trigger surgical DOM updates.

```javascript
// Index assignment - updates single node
data.items[0] = 'new item';

// Mutating methods - surgical updates
data.items.push('new');      // Append node
data.items.pop();            // Remove last node
data.items.shift();          // Remove first node
data.items.unshift('first'); // Prepend node
data.items.splice(1, 2, 'a', 'b'); // Targeted insert/remove
data.items.sort();           // Reorder nodes
data.items.reverse();        // Reorder nodes
```

Each mutation type calls a specific render function for optimal performance:
- `push` → `renderUpdates.forLoopPush(structure, items)`
- `pop` → `renderUpdates.forLoopPop(structure, removed)`
- `shift` → `renderUpdates.forLoopShift(structure, removed)`
- `unshift` → `renderUpdates.forLoopUnshift(structure, items)`
- `splice` → `renderUpdates.forLoopSplice(structure, start, deleteCount, items, removed)`
- `sort/reverse` → `renderUpdates.forLoopReorder(structure, array)`
- index set → `renderUpdates.forLoopSet(structure, index, value, oldValue)`

### Map Handler

Handles ES6 Map collections with method interception.

```javascript
// Mutating methods trigger updates
data.myMap.set('key', 'value');  // forLoopMapSet
data.myMap.delete('key');        // forLoopMapDelete
data.myMap.clear();              // forLoopClear
```

### Set Handler

Handles ES6 Set collections with method interception.

```javascript
// Mutating methods trigger updates
data.mySet.add('value');     // forLoopSetAdd
data.mySet.delete('value');  // forLoopSetDelete
data.mySet.clear();          // forLoopClear
```

### Date Handler

Handles Date objects with mutating method interception.

```javascript
// All setX methods trigger binding updates
data.birthday.setFullYear(2025);
data.birthday.setMonth(5);
data.birthday.setDate(15);
// ... and all other setX/setUTCX methods
```

## Dormant Bindings (Path Map)

When a parent object is deleted, child bindings become "dormant" and are stored by path string:

```javascript
// Active binding on user object
data.user = { name: 'John' };
// Binding stored: dataBindMap.get(userObject)

// Delete parent - binding becomes dormant
delete data.user;
// Binding moved to: pathMap.get('user.name')

// Restore parent - binding reactivated
data.user = { name: 'Jane' };
// Binding moved back to new userObject
```

**Status:** Not yet implemented

## Integration with Compiler

The compiled output includes `binding.strings` (string table) and `binding.code` (bytecode). At render time, bytecode is iterated to register bindings in `dataBindMap`.

Dynamic structures (`:for`, `:if`) are registered via `addDynamicStructure` and `addArrayForLoop` during initial rendering.

## Render Updates Interface

Reactivity calls specific render functions for DOM updates. The render runtime must provide these functions:

```javascript
import { setRenderUpdates } from './Reactivity.js';

setRenderUpdates({
    // Array for loop updates
    forLoopPush(structure, items) { /* append nodes */ },
    forLoopPop(structure, removed) { /* remove last node */ },
    forLoopShift(structure, removed) { /* remove first node */ },
    forLoopUnshift(structure, items) { /* prepend nodes */ },
    forLoopSplice(structure, start, deleteCount, items, removed) { /* targeted update */ },
    forLoopReorder(structure, array) { /* reorder all nodes */ },
    forLoopSet(structure, index, value, oldValue) { /* update single node */ },

    // Map for loop updates
    forLoopMapSet(structure, key, value, isNew) { /* add/update entry */ },
    forLoopMapDelete(structure, key) { /* remove entry */ },

    // Set for loop updates
    forLoopSetAdd(structure, value) { /* add value */ },
    forLoopSetDelete(structure, value) { /* remove value */ },

    // Shared
    forLoopClear(structure) { /* remove all nodes */ }
});
```

This architecture keeps render logic in one place while reactivity decides when and which function to call.

## Exports

```javascript
// Main entry point
export default createReactivity;

// Binding management
export { addBinding, getBindings, removeBinding };

// Dynamic structures
export { addArrayForLoop, getArrayForLoops };
export { addDynamicStructure, getDynamicStructures, removeDynamicStructure };

// Batching
export { batch };

// Render interface
export { setRenderUpdates };
```

## Known Limitations

1. **Array reassignment** (`items = newArray`): Replacing an entire collection does not re-render for-loops bound to the old collection. Workaround: use `splice(0, items.length, ...newItems)` to mutate in-place.

2. **Dotted path bindings in for-loops**: `{{ item.label }}` where `item` is an object compiles as a TEXT binding for root property "item", returning `[object Object]`. Needs runtime dotted path resolution or TEXT_EVAL compilation.

3. **Computed property reactivity**: Computed values are re-evaluated on every access but don't trigger reactive updates when their dependencies change.

4. **Binding cleanup**: When DOM instances are removed (`removeInstance`), their bindings remain in `dataBindMap` (memory leak over repeated renders).

5. **Dormant bindings**: When a parent object is deleted and re-created, child bindings are not migrated to the new object. (Path Map system not yet implemented.)
