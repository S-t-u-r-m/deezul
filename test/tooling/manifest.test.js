/**
 * manifest.test.js (tooling) — the module list is derived from src/, and agrees with what
 * a person would have written.
 *
 * The strongest check here is the last one: run the convention over the showcase, whose
 * twelve entries were typed by hand long before any of this existed, and the refs must
 * come out identical. A convention that disagrees with the names people already chose is
 * the wrong convention, however tidy its rule.
 */

import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { buildManifest, manifestSource } from '../../src/build/manifest.js';
import { refFromSource } from '../../src/runtime/modulePaths.js';

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let failures = 0;
function check(name, cond) {
    if (cond) console.log(`  ok    ${name}`);
    else { failures++; console.error(`  FAIL  ${name}`); }
}

// ── The naming rule ──────────────────────────────────────────────────────────
const BS = String.fromCharCode(92);  // a real backslash, whatever the shell did on the way in
check('PascalCase becomes kebab', refFromSource('components/ListBlock.js') === 'list-block');
check('nesting does not enter the ref', refFromSource('a/b/HomePage.js') === 'home-page');
check('windows separators split too', refFromSource(`a${BS}b${BS}HomePage.js`) === 'home-page');
check('underscores become hyphens', refFromSource('my_widget.js') === 'my-widget');
check('a one-word name has no valid ref', refFromSource('Home.js') === null);

// ── Walking a tree ───────────────────────────────────────────────────────────
{
    const dir = await mkdtemp(join(tmpdir(), 'dz-manifest-'));
    const src = join(dir, 'src');
    await mkdir(join(src, 'parts'), { recursive: true });

    const component = (body = '') => `export default Deezul.Component({ template: \`<p>x</p>\`${body} });`;
    await writeFile(join(src, 'AppLayout.js'), component());
    await writeFile(join(src, 'parts', 'ListBlock.js'), component());
    await writeFile(join(src, 'parts', 'helpers.js'), 'export const K = 1;');   // not a component
    await writeFile(join(src, 'Home.js'), component());                          // no hyphen

    const { modules, warnings } = await buildManifest(src);
    const refs = modules.map((m) => m.ref).sort();

    check('components are registered', String(refs) === 'app-layout,list-block');
    check('a helper module is not a component', !refs.includes('helpers'));
    check('src paths are posix', modules.every((m) => !m.src.includes(BS)));
    check('nested src path is kept whole', modules.some((m) => m.src === 'parts/ListBlock.js'));
    check('the one-word file is reported', warnings.some((w) => w.includes('Home.js')));
    check('and is left out rather than guessed at', !refs.includes('home'));

    // Two files cannot claim one ref: a ref is a name, not a location.
    await writeFile(join(src, 'ListBlock.js'), component());
    const clash = await buildManifest(src);
    check('a duplicate ref is reported', clash.warnings.some((w) => w.includes('already taken')));
    check('and only one of them registers', clash.modules.filter((m) => m.ref === 'list-block').length === 1);

    await rm(dir, { recursive: true, force: true });
}

// ── The generated source ─────────────────────────────────────────────────────
{
    const code = manifestSource([{ ref: 'home-page', src: 'pages/HomePage.js' }]);
    check('generated module is plain data', !code.includes('import '));
    check('generated module default-exports an array', code.includes('export default ['));
    check('entries are quoted properly', code.includes('{ ref: "home-page", src: "pages/HomePage.js" },'));
    check('it says not to edit it', code.toLowerCase().includes('do not edit'));
}

// ── Agreement with hand-written reality ──────────────────────────────────────
{
    const { modules, warnings } = await buildManifest(join(PKG, 'examples', 'showcase', 'src'));
    const refs = new Set(modules.map((m) => m.ref));
    const handWritten = [
        'app-layout', 'home-page', 'getting-started-page', 'components-page', 'reactivity-page',
        'template-page', 'loops-page', 'computed-page', 'routing-page', 'data-stores-page',
        'lifecycle-page',
    ];
    check('every hand-written showcase ref is derived identically', handWritten.every((r) => refs.has(r)));
    check('and nothing extra is invented', refs.size === handWritten.length);
    check('the showcase needs no hand registration at all', warnings.length === 0);
}

if (failures > 0) {
    console.error(`\n  ${failures} failure(s)`);
    process.exit(1);
}
