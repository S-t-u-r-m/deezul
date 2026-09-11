#!/usr/bin/env node
/**
 * deezul-build — production build for a deezul app.
 *
 * Run from a deezul app directory (the one containing index.html + src/):
 *   npx deezul-build        # or add "build": "deezul-build" to package.json scripts
 *
 * Assembles a self-contained, hostable dist/ folder:
 *   dist/
 *     *.html                 (every root page, dev live-reload lines stripped)
 *     main.js, *.config.js   (app entry + configs)
 *     favicon.*              (if present)
 *     deezul.esm.js          (runtime, from this package's dist)
 *     compiled/*.compiled.js (components compiled from src/ — the paths `{ ref, src }`
 *                            module entries resolve to; see src/runtime/modulePaths.js)
 *     assets/                (path-preserving)
 *     <public/ contents>     (copied verbatim if a public/ dir exists)
 *     + every local file the pages and scripts import, followed transitively
 *
 * Deploying is then just: upload dist/ (or serve it). Nothing else is needed —
 * src/, node_modules/, and package files do not ship.
 *
 * The work is done by pipeline.js, which `deezul-dev --dist` shares — so a dev server
 * serving dist/ is serving exactly this output.
 */
import { existsSync } from 'fs';
import { createPipeline } from './pipeline.js';

const pipeline = createPipeline(process.cwd());

if (!existsSync(pipeline.srcDir)) {
    console.error(`deezul-build: no src/ directory found in ${pipeline.root}`);
    process.exit(1);
}

const count = await pipeline.buildAll();
console.log(`\nBuilt ${count} component(s) -> dist/  (ready to host)`);
