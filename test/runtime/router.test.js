/**
 * router.test.js — Router behavior on happy-dom: query parsing, wildcard
 * routes, config redirects (incl. loop detection), and history URL updates.
 */

import { Window } from 'happy-dom';

const window = new Window({ url: 'http://localhost/' });
globalThis.window = window;
globalThis.document = window.document;
globalThis.CustomEvent = window.CustomEvent;

const { createRouter } = await import('../../src/runtime/Router.js');

let failures = 0;
function check(name, cond) {
    if (cond) console.log(`  ok    ${name}`);
    else { failures++; console.error(`  FAIL  ${name}`); }
}

const router = createRouter({
    routes: [
        { path: '/', component: 'home' },
        { path: '/users/:id', component: 'user' },
        { path: '/docs/*', component: 'docs' },
        { path: '/old', redirect: '/' },
        { path: '/legacy/:id', redirect: (to) => `/users/${to.params.id}` },
        { path: '/loop-a', redirect: '/loop-b' },
        { path: '/loop-b', redirect: '/loop-a' }
    ]
});

// ── Params + query ──
{
    const ok = await router.navigate('/users/42?tab=posts&page=2');
    const current = router.getCurrentRoute();
    check('param route matches', ok && current.route.component === 'user');
    check('params parsed', current.params.id === '42');
    check('query parsed', current.query.tab === 'posts' && current.query.page === '2');
    check('query preserved in URL', window.location.search === '?tab=posts&page=2');
}

// ── Wildcards ──
{
    await router.navigate('/docs/guide/getting-started');
    const current = router.getCurrentRoute();
    check('wildcard route matches subpaths', current.route.component === 'docs');
    check('wildcard remainder in params.pathMatch', current.params.pathMatch === 'guide/getting-started');
}

// ── Redirects ──
{
    await router.navigate('/old');
    check('string redirect lands on target', router.getCurrentRoute().route.component === 'home');

    await router.navigate('/legacy/7');
    const current = router.getCurrentRoute();
    check('function redirect receives params', current.route.component === 'user' && current.params.id === '7');

    const ok = await router.navigate('/loop-a');
    check('redirect loop aborts instead of recursing', ok === false);
}

// ── Query-only change re-targets the leaf ──
{
    await router.navigate('/users/9?q=a');
    const pathA = router._navigatedPath;
    await router.navigate('/users/9?q=b');
    check('query-only change produces a new navigated path', router._navigatedPath !== pathA && router.getCurrentRoute().query.q === 'b');
}

if (failures > 0) {
    console.error(`\n${failures} router check(s) failed`);
    process.exit(1);
}
console.log('\nAll router checks passed');
