# Deezul

A lightweight reactive UI framework with Shadow DOM web components, proxy-based reactivity, and bytecode-compiled templates.

[![CI](https://github.com/USER/deezul/actions/workflows/ci.yml/badge.svg)](https://github.com/USER/deezul/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## Features

- **Proxy-based reactivity** — Deep reactive objects, arrays, Maps, Sets, and Dates
- **Shadow DOM web components** — True encapsulation with scoped styles
- **Bytecode-compiled templates** — Templates compile to optimized bytecode for fast rendering
- **SPA Router** — History API router with nested routes, layouts, and route guards
- **Custom directives** — Lifecycle-aware directives with automatic cleanup
- **Computed properties & watchers** — Cached computations with dependency tracking
- **Error boundaries** — Component-level error isolation with recovery
- **Slots & refs** — Named slots, default slots, and template refs
- **Two-way binding** — `:bind` for inputs, `:propName.sync` for parent-child sync
- **Zero runtime dependencies** — Pure JavaScript, ~60KB minified

## Quick Start

### Installation

```bash
npm install deezul
```

### CDN

```html
<script type="module">
  import Deezul from 'https://unpkg.com/deezul/dist/deezul.esm.js';
</script>
```

### Define a Component

```javascript
export default Deezul.Component({
    template: `
        <div class="counter">
            <p>Count: {{ count }}</p>
            <button @click="increment">+1</button>
        </div>
    `,

    data: () => ({
        count: 0
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

    styles: `
        .counter { padding: 20px; }
    `
});
```

### Compile

Components must be compiled before use:

```bash
npx deezul-compile src/Counter.js compiled/Counter.compiled.js
```

Watch mode for development:

```bash
npx deezul-compile --watch src/ --out compiled/
```

### Initialize

```javascript
import Deezul from 'deezul';

Deezul.init({
    rootElement: 'app',

    modules: [
        { ref: 'home-page', path: 'compiled/HomePage.compiled.js' },
        { ref: 'about-page', path: 'compiled/AboutPage.compiled.js' }
    ],

    routes: [
        { path: '/', component: 'home-page' },
        { path: '/about', component: 'about-page' }
    ]
});
```

## Template Syntax

### Text Binding

```html
<p>{{ propertyName }}</p>
<p>{{ firstName + ' ' + lastName }}</p>
```

### Two-Way Binding

```html
<input type="text" :bind="username" />
```

### Attribute Binding

```html
<div :class="activeClass"></div>
<button :disabled="isLoading"></button>
```

### Event Handling

```html
<button @click="handleClick">Click</button>
<button @click="addItem(item)">Add</button>
```

### Conditionals

```html
<div :if="isVisible">Shown when true</div>
<div :else-if="altCondition">Alternative</div>
<div :else>Fallback</div>
```

### Loops

```html
<li :for="item in items">{{ item.name }}</li>
<div :for="(item, index) in items">{{ index }}: {{ item }}</div>
```

### Props

```html
<!-- Parent passes props to child -->
<dz-component dz-type="child" :label="title" :count.sync="total"></dz-component>
```

### Slots

```html
<!-- Parent -->
<dz-component dz-type="card">
    <span slot="header">Title</span>
    <p>Default content</p>
</dz-component>

<!-- Child template -->
<header><slot name="header"></slot></header>
<main><slot></slot></main>
```

### Refs

```html
<input type="text" ref="myInput" />
<!-- Access via this.$refs.myInput -->
```

## Lifecycle Hooks

```javascript
{
    $created()    { /* instance created, data reactive */ },
    $mounted()    { /* inserted into DOM */ },
    $updated()    { /* after reactive update */ },
    $unmounted()  { /* removed from DOM */ }
}
```

## Custom Directives

```javascript
Deezul.registerDirective('focus', {
    mounted(el, binding) {
        if (binding.value) el.focus();
    },
    updated(el, binding) {
        if (binding.value && !binding.oldValue) el.focus();
    }
});
```

```html
<input :focus="shouldFocus" />
```

## Router

```javascript
Deezul.init({
    rootElement: 'app',
    modules: [ /* ... */ ],
    routes: [
        { path: '/', component: 'home-page' },
        { path: '/users/:id', component: 'user-page' },
        { path: '/dashboard', component: 'dashboard', layouts: ['app-layout'] }
    ],
    beforeNavigate(to, from, next) { next(); },
    afterNavigate(to, from) { }
});
```

Programmatic navigation:

```javascript
this.$router.push('/users/123');
this.$router.back();
```

## Data Stores

Shared reactive state across components:

```javascript
// Register
modules: [
    { ref: 'app-store', type: 'data', data: { count: 0 } }
]

// Access in any component
const store = await Deezul.getDataStore('app-store');
store.count++;
```

## Error Boundaries

```javascript
{
    $errorCaptured(error, componentName, phase) {
        this.hasError = true;
        return false; // stop propagation
    }
}
```

## API Reference

| Method | Description |
|--------|-------------|
| `Deezul.init(options)` | Initialize the framework with modules, routes, and config |
| `Deezul.navigate(path)` | Navigate to a route programmatically |
| `Deezul.registerDirective(name, hooks)` | Register a custom directive |
| `Deezul.unregisterDirective(name)` | Remove a custom directive |
| `Deezul.getDataStore(ref)` | Get a reactive data store by reference name |
| `Deezul.cloneStore(ref)` | Get a non-reactive copy of a data store |
| `Deezul.createComponent(ref, data)` | Create a component instance programmatically |
| `Deezul.registerGlobalErrorHandler(fn)` | Register a global error handler |
| `Deezul.configure(options)` | Update framework configuration |

## Compiler CLI

```
Usage: deezul-compile <input> [output]

Options:
  -h, --help       Show help
  -v, --version    Show version
  -w, --watch      Watch files for changes
  -o, --out        Output directory
  -d, --debug      Debug output
  --ext            Output extension (default: .compiled.js)

Examples:
  deezul-compile src/App.js compiled/App.compiled.js
  deezul-compile src/ --out compiled/
  deezul-compile --watch src/ --out compiled/
```

## Key Patterns

1. **Data must be a factory function**: `data: () => ({})` not `data: {}`
2. **Methods access data via `this`**: `this.count++`
3. **Computed properties are cached**: Only re-evaluate when dependencies change
4. **Styles are scoped**: Each component's styles are isolated via Shadow DOM
5. **Props flow down, events flow up**: Unidirectional data flow with optional `.sync`

## Project Structure

```
deezul/
  src/
    runtime/     # Framework runtime (browser)
    compiler/    # Template-to-bytecode compiler (Node.js)
  tooling/
    bundler/     # Rollup config for building dist/
  dist/          # Built bundles (ESM + IIFE)
  examples/
    showcase/    # Interactive demo site with 16 feature pages
  test/          # Compiler tests
  docs/          # Documentation
```

## Development

```bash
git clone https://github.com/USER/deezul.git
cd deezul
npm install
npm run build             # Build runtime bundles
npm test                  # Run compiler tests
npm run build:showcase    # Compile showcase components
npm run dev               # Serve showcase at localhost:3000
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

[MIT](LICENSE)
