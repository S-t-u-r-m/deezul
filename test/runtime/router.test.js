/**
 * router.test.js — Router behavior on happy-dom: query parsing, wildcard
 * routes, config redirects (incl. loop detection), history URL updates, and
 * #fragments (kept in the address; a fragment-only change is not a navigation).
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

// ── #fragments ──
{
    let notified = 0;
    const unsubscribe = router.subscribe(() => { notified++; });

    const ok = await router.navigate('/users/5?tab=a#staff');
    const current = router.getCurrentRoute();
    check('a path with a fragment still matches its route', ok && current.route.component === 'user' && current.params.id === '5');
    check('query parsed before the fragment', current.query.tab === 'a');
    check('fragment kept in the URL', window.location.pathname === '/users/5' && window.location.search === '?tab=a' && window.location.hash === '#staff');

    await router.navigate('/users/5#bio');
    check('fragment without a query kept', window.location.search === '' && window.location.hash === '#bio');

    // An in-page link changes only the fragment; the browser fires popstate.
    notified = 0;
    window.history.pushState(null, '', '/users/5#contact');
    router._handlePopState({ state: null });
    await new Promise(resolve => setTimeout(resolve, 10));
    check('fragment-only popstate does not navigate', notified === 0);
    check('fragment-only popstate leaves the fragment in the URL', window.location.hash === '#contact');

    // Back to another page whose entry has a fragment: navigates, keeps it.
    window.history.pushState(null, '', '/users/6#staff');
    router._handlePopState({ state: null });
    await new Promise(resolve => setTimeout(resolve, 10));
    check('popstate to another page navigates', notified === 1 && router.getCurrentRoute().params.id === '6');
    check('popstate keeps the fragment of the page it lands on', window.location.hash === '#staff');

    // Loading a page with a fragment in the address.
    window.history.replaceState(null, '', '/docs/intro#install');
    router.init();
    await new Promise(resolve => setTimeout(resolve, 10));
    check('init keeps the fragment', router.getCurrentRoute().route.component === 'docs' && window.location.hash === '#install');

    unsubscribe();
}

if (failures > 0) {
    console.error(`\n${failures} router check(s) failed`);
    process.exit(1);
}
console.log('\nAll router checks passed');
