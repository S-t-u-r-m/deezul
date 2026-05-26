/**
 * DataProxy.js - Reactive Proxy + Change Chain
 *
 * Design:
 *
 * 1. Equality pre-check lives in the proxy's set trap. Type handlers are
 *    not called for redundant assignments (`proxy.x = proxy.x`, primitive
 *    set to same value, proxy-wrapped re-assignment of the same target).
 *
 * 2. The proxy owns a deduplicating change chain.
 *    Property changes accumulate in `Map<rawTarget, Map<key, {oldValue, value}>>`
 *    keyed for O(1) coalescing: repeated writes to the same (target, key)
 *    keep the original oldValue and overwrite to the latest value.
 *    Collection mutations (push/splice/Map.set/...) accumulate in an ordered
 *    list — deduplication is unsafe for :for reconciliation.
 *
 * 3. Auto-batched flush via queueMicrotask.
 *    The first change in a synchronous turn schedules a microtask flush;
 *    every subsequent change in the same turn lands in the same chain.
 *    No developer involvement, no entry-point wrapping. Runs once per
 *    user trigger (click, method call, async resumption — each is a microtask).
 *
 * 4. Pruning at flush. Entries whose value === oldValue after coalescing
 *    are dropped — a "set, then set back" sequence collapses to a no-op.
 *
 * Reactivity.js registers application logic via setFlushHandlers() once
 * at module init. DataProxy stays oblivious to bindings, computed, watchers,
 * and DOM — it only owns the chain.
 */

import { isObject } from './helpers.js';

// ============================================================================
// SYMBOLS
// ============================================================================

export const IS_PROXY = Symbol('isProxy');
export const TARGET = Symbol('target');
export const PARENT_PROXY = Symbol('parentProxy');
export const PARENT_KEY = Symbol('parentKey');

export const REBINDABLE = Symbol('rebindable');
export const REBIND = Symbol('rebind');

// ============================================================================
// CHANGE CHAIN
// ============================================================================

/**
 * Property change chain — deduplicating per (target, key).
 *
 *   Map<rawTarget, Map<key, { oldValue, value }>>
 */
let changeChain = new Map();

/**
 * Collection mutation log — ordered, no deduplication.
 *
 *   Array<{ target, type, meta, proxyInstance }>
 */
let mutationLog = [];

let flushScheduled = false;
let flushHandlers = null;

/**
 * Reactivity.js registers flush behavior here once at module init.
 *
 * @param {object} handlers
 *   @param {(target, propertyMap) => void} handlers.applyChanges
 *     Invoked once per target with that target's deduplicated, no-op-pruned
 *     Map<key, {oldValue, value}>.
 *   @param {(target, type, meta, proxyInstance) => void} handlers.applyMutation
 *     Invoked once per mutation entry, in original insertion order.
 *   @param {(localChain, localMutations) => void} [handlers.afterFlush]
 *     Optional hook fired after all changes & mutations apply
 *     (used for $updated lifecycle callbacks).
 */
export function setFlushHandlers(handlers) {
    flushHandlers = handlers;
}

/**
 * Optional hook fired the first time a proxy is created for a target.
 * Receives the raw target and its parent's raw target (or null for the root).
 *
 * Reactivity.js uses this to propagate ComputedManager registration from a
 * parent target down to nested targets. Without it, a change deep in the
 * data tree (e.g., `state.user.name = 'Bob'`) wouldn't find its manager —
 * `getManager(userTarget)` would miss the manager registered on `state`.
 */
let onProxyCreated = null;

export function setOnProxyCreated(hook) {
    onProxyCreated = hook;
}

/**
 * Record a property change. Called by handlers AFTER mutating the target.
 * The proxy's set trap is responsible for the equality pre-check, so by the
 * time this runs we already know `oldValue !== value` (modulo the no-op
 * prune at flush time, which catches the set-then-set-back case).
 *
 * @param {boolean} [force=false]
 *   Bypass the value === oldValue prune at flush. Used by handlers that
 *   reuse a reference but mutate contents (e.g., array reassignment that
 *   reconciles in place — the parent property still needs its bindings
 *   fired even though the array reference is unchanged).
 */
export function recordChange(target, key, oldValue, value, force = false) {
    let propertyMap = changeChain.get(target);
    if (!propertyMap) {
        propertyMap = new Map();
        changeChain.set(target, propertyMap);
    }
    const existing = propertyMap.get(key);
    if (existing) {
        existing.value = value;
        if (force) existing.force = true;
    } else {
        propertyMap.set(key, { oldValue, value, force });
    }
    if (!flushScheduled) {
        flushScheduled = true;
        queueMicrotask(flush);
    }
}

/**
 * Record a collection mutation (push/splice/Map.set/Set.add/Date.setX/...).
 * Mutations are not deduplicated — push+pop is not a no-op for forLoop
 * reconciliation, and order matters for in-place updates.
 */
export function recordMutation(target, type, meta, proxyInstance) {
    mutationLog.push({ target, type, meta, proxyInstance });
    if (!flushScheduled) {
        flushScheduled = true;
        queueMicrotask(flush);
    }
}

/**
 * Force a synchronous flush. Useful for tests, teardown, and any caller
 * that needs the DOM to reflect pending changes before the microtask runs.
 */
export function flushSync() {
    if (flushScheduled) flush();
}

function flush() {
    // Snapshot and reset BEFORE applying. Re-entrant changes (a watcher that
    // mutates) populate a fresh chain that flushes on the next microtask.
    const localChain = changeChain;
    const localMutations = mutationLog;
    changeChain = new Map();
    mutationLog = [];
    flushScheduled = false;

    if (!flushHandlers) return;

    const { applyChanges, applyMutation, afterFlush } = flushHandlers;

    // Phase A: replay collection mutations in original order.
    if (applyMutation) {
        for (let i = 0, len = localMutations.length; i < len; i++) {
            const m = localMutations[i];
            applyMutation(m.target, m.type, m.meta, m.proxyInstance);
        }
    }

    // Phase B: apply property changes per-target. Coalesced no-ops
    // (entry.value === entry.oldValue without `force`) are skipped inline
    // by the consumer's apply pass.
    if (applyChanges) {
        for (const [target, propertyMap] of localChain) {
            applyChanges(target, propertyMap);
        }
    }

    // Phase C: post-flush hook (e.g., $updated lifecycle callbacks).
    if (afterFlush) afterFlush(localChain, localMutations);
}

// ============================================================================
// PROXY FACTORY
// ============================================================================

/**
 * Creates a proxy factory with type-specific handlers captured in closure.
 *
 * @param {Map<Function, {get, set, delete}>} handlers
 *   Keys are constructors (Array, Map, Set, Date, Object, ...).
 *   Unknown constructors fall back to the Object handler.
 *
 * @returns {{ createProxy: Function, cache: WeakMap }}
 */
export function createProxyFactory(handlers) {
    const proxyCache = new WeakMap();

    function createProxy(obj, parentProxy = null, parentKey = null) {
        const cached = proxyCache.get(obj);
        if (cached) return cached;
        if (obj[IS_PROXY]) return obj;
        if (!isObject(obj)) {
            throw new Error('createProxy requires an object or collection');
        }

        const ctor = obj.constructor;
        let typeHandler = handlers.get(ctor);
        if (!typeHandler) typeHandler = handlers.get(Object);
        if (!typeHandler) {
            throw new Error(`No handler found for constructor: ${ctor.name} (and no Object fallback handler)`);
        }

        let proxyInstance = null;
        let cachedRebindFn = null;

        const handler = {
            get(target, key) {
                if (typeof key === 'symbol') {
                    if (key === IS_PROXY) return true;
                    if (key === TARGET) return target;
                    if (key === PARENT_PROXY) return parentProxy;
                    if (key === PARENT_KEY) return parentKey;
                    if (key === REBIND) {
                        if (!cachedRebindFn) {
                            cachedRebindFn = function(propertyName, newValue) {
                                if (newValue && typeof newValue === 'object') {
                                    newValue[REBINDABLE] = true;
                                }
                                proxyInstance[propertyName] = newValue;
                            };
                        }
                        return cachedRebindFn;
                    }
                    return target[key];
                }

                const value = typeHandler.get(target, key, proxyInstance);

                if (isObject(value) && !value[IS_PROXY]) {
                    return createProxy(value, proxyInstance, String(key));
                }

                return value;
            },
            set(target, key, value) {
                // Pre-check #1: identity equality (primitives, same reference).
                const oldValue = target[key];
                if (oldValue === value) return true;

                // Pre-check #2: proxy-wrapped re-assignment of the same target.
                // Catches `proxy.x = proxy.x` where the get trap returned a wrapped
                // child proxy. value[TARGET] returns the raw target for a proxy,
                // undefined otherwise.
                if (value !== null && typeof value === 'object' && value[TARGET] === oldValue) {
                    return true;
                }

                // Real change — delegate to the type-specific handler.
                // oldValue is forwarded so the handler doesn't have to read it again.
                return typeHandler.set(target, key, value, proxyInstance, oldValue);
            },
            deleteProperty(target, key) {
                return typeHandler.delete(target, key, proxyInstance);
            }
        };

        proxyInstance = new Proxy(obj, handler);
        proxyCache.set(obj, proxyInstance);

        if (onProxyCreated) {
            const parentTarget = parentProxy ? parentProxy[TARGET] : null;
            onProxyCreated(obj, parentTarget);
        }

        return proxyInstance;
    }

    return { createProxy, cache: proxyCache };
}
