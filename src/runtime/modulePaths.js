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
 * The ref a component source registers itself as, by convention.
 *
 *   'components/ListBlock.js'  -> 'list-block'
 *   'pages/HomePage.js'        -> 'home-page'
 *   'Home.js'                  -> null
 *
 * A ref becomes a custom element name, which must contain a hyphen, so a
 * single-word file has no valid convention name and gets null -- the caller
 * reports it and the author either renames the file or registers it by hand.
 * Only the basename is used: a ref is a name, not a location.
 *
 * @param {string} src - path under src/, e.g. 'components/ListBlock.js'
 * @returns {string|null}
 */
export function refFromSource(src) {
    // Split on either separator: callers hand us whatever path.relative() gave them,
    // which on Windows is backslashes.
    const base = src.split('\\').join('/').split('/').pop().replace(/\.js$/, '');
    const ref = base
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/[_\s]+/g, '-')
        .toLowerCase();
    return ref.includes('-') ? ref : null;
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
