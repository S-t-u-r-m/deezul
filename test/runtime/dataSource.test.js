/**
 * dataSource.test.js (runtime) — a data store read from the server.
 *
 * The runtime had no way to say where data came from. A store was an inline object or a
 * lazily imported module, plus optional localStorage, and nothing in src/runtime called
 * fetch at all -- so "static" and "dynamic" were the same thing, and the production
 * calendar store says as much in its own header: "Persisting is the host's job for now."
 *
 * A store declared with a `source` is now read over HTTP. That also settles what the
 * transient/gc machinery was for: component code cannot be discarded, because an
 * evaluated ES module stays in the module map for the life of the document -- but a
 * server-backed store CAN be, because the server holds the truth and the store can be
 * read again. Reference counting belongs to this layer, not that one.
 *
 * Two properties matter more than the plumbing:
 *   - a re-read MERGES into the existing target, because every bound component holds a
 *     proxy over it and swapping the object would leave them all reading the old one
 *   - a failed read keeps the last good content rather than emptying the store
 */

import { createModuleRegistry } from '../../src/runtime/ModuleRegistry.js';
import { configure } from '../../src/runtime/Configuration.js';

let failures = 0;
function check(name, cond) {
    if (cond) console.log(`  ok    ${name}`);
    else { failures++; console.error(`  FAIL  ${name}`); }
}

/** A fetch that serves queued responses and records what was asked for. */
function stubFetch() {
    const calls = [];
    let queue = [];
    globalThis.fetch = async (url) => {
        calls.push(url);
        const next = queue.length > 1 ? queue.shift() : queue[0];
        if (!next) throw new Error('nothing queued');
        if (next.fail) return { ok: false, status: next.fail, statusText: 'Nope' };
        if (next.throws) throw new Error('network down');
        return { ok: true, status: 200, json: async () => next.body };
    };
    return {
        calls,
        serve: (...responses) => { queue = responses; },
    };
}

const quiet = () => {
    const e = console.error, w = console.warn;
    console.error = () => {}; console.warn = () => {};
    return () => { console.error = e; console.warn = w; };
};

// ── A store is read from its source ──────────────────────────────────────────
{
    const net = stubFetch();
    net.serve({ body: { total: 3, items: ['a', 'b', 'c'] } });
    configure({ data: { base: '', ttl: 0 } });

    const reg = createModuleRegistry('t1', { enableProxy: true });
    reg.register('events', null, { source: '/api/events' });

    const store = await reg.get('events');
    check('a source store loads over fetch', store.total === 3);
    check('nested content survives', String(store.items) === 'a,b,c');
    check('the source url was requested', net.calls[0] === '/api/events');
    check('a second get does not re-read', (await reg.get('events')) && net.calls.length === 1);
}

// ── base resolution ──────────────────────────────────────────────────────────
{
    const net = stubFetch();
    net.serve({ body: { ok: 1 } });
    configure({ data: { base: 'https://host/api/' } });

    const reg = createModuleRegistry('t2', { enableProxy: true });
    reg.register('rel', null, { source: '/events' });
    await reg.get('rel');
    check('a relative source resolves against base', net.calls[0] === 'https://host/api/events');

    net.serve({ body: { ok: 1 } });
    const reg2 = createModuleRegistry('t3', { enableProxy: true });
    reg2.register('abs', null, { source: 'https://elsewhere/x.json' });
    await reg2.get('abs');
    check('an absolute source ignores base', net.calls[1] === 'https://elsewhere/x.json');

    configure({ data: { base: '' } });
}

// ── staleness and in-place refresh ───────────────────────────────────────────
{
    const net = stubFetch();
    net.serve({ body: { n: 1, gone: true } }, { body: { n: 2 } });

    const reg = createModuleRegistry('t4', { enableProxy: true });
    reg.register('live', null, { source: '/api/live', ttl: 0 });

    const first = await reg.get('live');
    check('first read', first.n === 1);

    const ok = await reg.refresh('live');
    check('refresh reports success', ok === true);
    check('the SAME object now holds the new content', first.n === 2);
    check('a key the server dropped is removed', first.gone === undefined);
    check('refresh re-read the source', net.calls.length === 2);
}

// ── ttl drives a re-read without being asked ─────────────────────────────────
{
    const net = stubFetch();
    net.serve({ body: { v: 'old' } }, { body: { v: 'new' } });

    const reg = createModuleRegistry('t5', { enableProxy: true });
    // A ttl in the past: the entry is stale the moment it is read.
    reg.register('ttl', null, { source: '/api/ttl', ttl: 0.001 });

    const s = await reg.get('ttl');
    check('fresh read', s.v === 'old');
    await new Promise((r) => setTimeout(r, 20));
    await reg.get('ttl');
    check('a stale store is re-read on the next get', s.v === 'new');
}

// ── a failed read keeps the last good content ────────────────────────────────
{
    const net = stubFetch();
    net.serve({ body: { kept: 'yes' } });
    const reg = createModuleRegistry('t6', { enableProxy: true });
    reg.register('flaky', null, { source: '/api/flaky' });
    const s = await reg.get('flaky');
    check('loaded once', s.kept === 'yes');

    const restore = quiet();
    net.serve({ fail: 500 });
    const ok = await reg.refresh('flaky');
    restore();
    check('a failed refresh reports false', ok === false);
    check('and the last good content is still there', s.kept === 'yes');

    const restore2 = quiet();
    net.serve({ throws: true });
    const ok2 = await reg.refresh('flaky');
    restore2();
    check('a thrown request is caught', ok2 === false);
    check('content still intact', s.kept === 'yes');
}

// ── gc() only collects what can be read again ────────────────────────────────
{
    const net = stubFetch();
    net.serve({ body: { from: 'server' } });

    const reg = createModuleRegistry('t7', { enableProxy: true });
    reg.register('remote', null, { source: '/api/remote', persistent: false });
    reg.register('inline', { from: 'inline' }, { persistent: false });

    await reg.get('remote');
    await reg.get('inline');

    const restore = quiet();
    const log = console.log; console.log = () => {};
    const result = reg.gc();
    console.log = log;
    restore();

    check('the server-backed store is collected', result.collected === 1);
    check('the inline store is skipped, not destroyed', result.skipped === 1);

    const back = await reg.get('remote');
    check('a collected store reads again', back.from === 'server');

    // The bug this replaces: gc() nulled an inline module that had no path and no
    // source, so every later get() returned null and the content was unrecoverable.
    const survived = await reg.get('inline');
    check('the inline store still has its content', survived && survived.from === 'inline');
}

// ── a store with no source cannot be refreshed ───────────────────────────────
{
    const reg = createModuleRegistry('t8', { enableProxy: true });
    reg.register('static', { a: 1 });
    const restore = quiet();
    const ok = await reg.refresh('static');
    const missing = await reg.refresh('nope');
    restore();
    check('refreshing a sourceless store is refused', ok === false);
    check('refreshing an unknown ref is refused', missing === false);
}

if (failures > 0) {
    console.error(`\n  ${failures} failure(s)`);
    process.exit(1);
}
