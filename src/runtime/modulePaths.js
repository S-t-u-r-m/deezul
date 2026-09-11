/**
 * modulePaths.js - Where a component's compiled output lives
 *
 * The single owner of the compiled-file convention. deezul-dev serves compiled
 * components at these URLs, deezul-build writes them to these files, and the
 * registry resolves `{ ref, src }` module entries to them — so an app names its
 * SOURCE file and never has to spell out a compiled path:
 *
 *   { ref: 'dz-button', src: 'component/Button.js' }
 *     → './compiled/component/Button.compiled.js'
 *
 * `src` is the file's path under the app's src/ directory. Subdirectories are
 * mirrored into compiled/, which is also what `deezul-compile src/ --out compiled/`
 * produces. An app that compiles to a different layout keeps using `path`.
 *
 * The resolved path is relative, and a dynamic import() resolves it against the
 * runtime module (deezul.esm.js) — which dev and build both serve from the app root.
 *
 * Pure and dependency-free: imported by the browser runtime and by the Node tooling.
 */

export const COMPILED_DIR = 'compiled';
export const COMPILED_EXT = '.compiled.js';

/**
 * Compiled module path for a source file under src/.
 * A leading './' or 'src/' and a trailing '.js' are optional.
 * @param {string} src - e.g. 'component/Button.js'
 * @returns {string} e.g. './compiled/component/Button.compiled.js'
 */
export function compiledPath(src) {
    const rel = src.replace(/^\.\//, '').replace(/^src\//, '').replace(/\.js$/, '');
    return `./${COMPILED_DIR}/${rel}${COMPILED_EXT}`;
}

/**
 * The path a module entry loads from: its `path`, or the compiled path for its
 * `src`. Undefined for entries that carry their definition inline (`data`).
 * @param {Object} mod - Module entry from Deezul.init({ modules })
 * @returns {string|undefined}
 */
export function modulePath(mod) {
    if (mod.src === undefined) return mod.path;

    // Both is ambiguous, and a typo'd `src` must not silently fall back to `path`.
    if (mod.path !== undefined) {
        throw new Error(`Module '${mod.ref}' has both 'src' and 'path'. Use 'src' for a file under src/, or 'path' for an explicit URL — not both.`);
    }
    if (typeof mod.src !== 'string' || mod.src === '') {
        throw new Error(`Module '${mod.ref}' has an invalid 'src': expected a file path under src/, e.g. 'component/Button.js'.`);
    }
    // Only components are compiled; a data store's module is served as-is.
    if (mod.type === 'data') {
        throw new Error(`Data store '${mod.ref}' cannot use 'src' — only components are compiled. Use 'path' or inline 'data'.`);
    }
    return compiledPath(mod.src);
}
