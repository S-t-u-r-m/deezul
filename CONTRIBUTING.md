# Contributing to Deezul

## Development Setup

```bash
git clone https://github.com/USER/deezul.git
cd deezul
npm install
npm run build
npm test
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Build runtime bundles to `dist/` |
| `npm test` | Run compiler tests |
| `npm run build:showcase` | Compile showcase site components |
| `npm run dev` | Serve showcase at `localhost:3000` |
| `npm run compile -- <file>` | Compile a single component |

## Project Structure

```
src/
  runtime/     # Browser runtime — reactivity, components, router, directives
  compiler/    # Node.js compiler — template parsing, bytecode generation
tooling/
  bundler/     # Rollup configuration for building dist/
examples/
  showcase/    # Interactive demo site (16 pages covering all features)
test/
  compiler/    # Compiler unit tests
```

## Code Style

- ES modules throughout (`import`/`export`, no CommonJS)
- Functional programming preferred; no classes except Web Component registration
- Performance-critical loops: `for (let i = 0, len = arr.length; i < len; i++)`
- Hot-path lookups: `Set.has()` over `Array.includes()`
- Module-level functions over inline closures for binding apply functions
- No external runtime dependencies — the browser bundle is pure JavaScript

## Testing

Tests are standalone Node.js scripts in `test/compiler/`. Run them with:

```bash
npm test
```

Each test file is executed as a child process. A non-zero exit code means failure.

When adding compiler features, add corresponding tests that exercise the new codegen paths.

## Pull Requests

1. One feature or fix per PR
2. Add tests for new compiler features
3. Run `npm test` and `npm run build` before submitting
4. Keep commits focused and well-described
