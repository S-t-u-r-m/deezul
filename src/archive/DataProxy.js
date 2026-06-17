// --- Symbols for proxy metadata ---
export const IS_PROXY = Symbol('isProxy');
export const TARGET = Symbol('target');
export const PARENT_PROXY = Symbol('parentProxy');
export const PARENT_KEY = Symbol('parentKey');

// --- Symbols for rebinding support ---
export const REBINDABLE = Symbol('rebindable');
export const REBIND = Symbol('rebind');

/**
 * DataProxy2.js - Minimal Reactive Proxy
 *
 * Ultra-thin proxy layer - intercepts and delegates to type-specific callbacks.
 * ALL logic lives in callbacks (ReactivityBridge), not here.
 *
 * The proxy only:
 * - Type-checks once at creation to select appropriate handlers
 * - Handles symbol access for metadata (IS_PROXY, TARGET, etc.)
 * - Delegates get/set/delete to the type-specific callbacks
 *
 * Symbols exported for external use:
 * - IS_PROXY: Check if object is already a proxy
 * - TARGET: Get raw target object from proxy
 * - PARENT_PROXY: Get parent proxy reference (for nested objects)
 * - PARENT_KEY: Get key name on parent (for building paths)
 */

import { isObject } from './helpers.js';

/**
 * Creates a proxy factory with handlers captured in closure.
 * Returns an object with a createProxy method and access to the cache.
 *
 * @param {Map} handlers - Map of constructors to handler objects
 * Keys: Constructor functions (Array, Map, Date, Object, etc.)
 * Values: { get, set, delete } handler objects
 * Unknown constructors will fall back to the Object handler
 *
 * @example
 * const handlers = new Map([
 *   [Array, { get: ..., set: ..., delete: ... }],
 *   [Map, { get: ..., set: ..., delete: ... }],
 *   [Date, { get: ..., set: ..., delete: ... }],
 *   [MyClass, { get: ..., set: ..., delete: ... }],
 *   [Object, { get: ..., set: ..., delete: ... }]  // Fallback for plain objects
 * ]);
 *
 * @returns {object} Factory object: { createProxy, cache }
 */
export function createProxyFactory(handlers) {
    // Cache scoped to this factory instance
    const proxyCache = new WeakMap();

    /**
     * Creates a reactive proxy for an object.
     *
     * @param {object} obj - The object to proxy
     * @param {Proxy} [parentProxy] - Parent proxy reference (for nested objects)
     * @param {string} [parentKey] - Key name on parent
     * @returns {Proxy} Reactive proxy
     */
    function createProxy(obj, parentProxy = null, parentKey = null) {
        // Return cached proxy if exists (prevents infinite loops on circular refs)
        if (proxyCache.has(obj)) {
            return proxyCache.get(obj);
        }

        if (obj[IS_PROXY]) {
            return obj;
        }

        if (!isObject(obj)) {
            throw new Error('createProxy requires an object or collection');
        }

        // O(1) lookup by constructor
        const ctor = obj.constructor;
        let typeHandler = handlers.get(ctor);

        // Fallback to Object handler for unknown types
        if (!typeHandler) {
            typeHandler = handlers.get(Object);
        }

        if (!typeHandler) {
            throw new Error(`No handler found for constructor: ${ctor.name} (and no Object fallback handler)`);
        }

        let proxyInstance = null;
        let cachedRebindFn = null;

        // Wrapper has closure access to handlers, delegates to type-specific handler
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

                // Call handler to get the value
                const value = typeHandler.get(target, key, proxyInstance);

                // Centralized wrapping: if value is an object and not already a proxy, wrap it
                if (isObject(value) && !value[IS_PROXY]) {
                    return createProxy(value, proxyInstance, String(key));
                }

                return value;
            },
            set(target, key, value) {
                return typeHandler.set(target, key, value, proxyInstance);
            },
            deleteProperty(target, key) {
                return typeHandler.delete(target, key, proxyInstance);
            }
        };

        proxyInstance = new Proxy(obj, handler);
        proxyCache.set(obj, proxyInstance);

        return proxyInstance;
    }

    return {
        createProxy,
        cache: proxyCache
    };
}