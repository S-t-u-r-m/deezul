/**
 * ModuleRegistry.js - Generic Module Registry Factory
 *
 * Creates registry instances for managing modules (components, views, data stores).
 * Each instance has its own isolated storage and configuration.
 *
 * Features:
 * - Lazy loading from module paths
 * - Persistence options (transient vs persistent)
 * - Reference counting for garbage collection
 * - Data stores: localStorage persistence, proxy wrapping, getCopy
 *
 * Usage:
 * const componentRegistry = createModuleRegistry('components');
 * const dataRegistry = createModuleRegistry('data', { enableLocalStorage: true });
 */

import { createProxyFactory, TARGET } from './DataProxy.js';
import { deepClone } from './helpers.js';
import { TYPEOF } from './constants.js';
import { createLogger } from './Logger.js';
import { isReservedPrefix } from './LibraryComponents.js';

/**
 * Create a new module registry instance
 * @param {string} name - Registry name (for logging)
 * @param {Object} options - Registry options
 * @param {boolean} options.enableLocalStorage - Enable localStorage for data stores
 * @param {boolean} options.enableProxy - Wrap data in proxy (for data stores)
 * @param {Function} options.onLoad - Callback when module loads
 * @returns {Object} Registry instance
 */
export function createModuleRegistry(name, options = {}) {
    const logger = createLogger(`Registry:${name}`);

    const {
        enableLocalStorage = false,
        enableProxy = false,
        onLoad = null
    } = options;

    // Internal storage
    const registry = new Map();
    const persistentModules = new Set();
    const transientModules = new Set();
    const transientInstances = new Map();  // ref -> Set<instanceId>
    const proxyCache = new Map();  // For data stores - cache proxied instances
    const persistTimers = new Map();  // For debounced localStorage saves
    const waiters = new Map();  // ref -> Set<resolve> for awaiting registration

    // ========================================================================
    // Core Registry Methods
    // ========================================================================

    /**
     * Register a module
     * @param {string} ref - Unique reference name
     * @param {string|Object} pathOrData - Module path or inline data/config
     * @param {Object} opts - Registration options
     */
    function register(ref, pathOrData, opts = {}) {
        const {
            persistent = true,
            metadata = {},
            localStorage = false,
            localStorageKey = null
        } = opts;

        // Validate: 'dz:' prefix is reserved for library components
        if (isReservedPrefix(ref)) {
            throw new Error(`Cannot register component with reserved 'dz:' prefix: '${ref}'. The 'dz:' prefix is reserved for Deezul library components.`);
        }

        if (registry.has(ref)) {
            logger.warn(`'${ref}' already registered, skipping`);
            return;
        }

        const entry = {
            ref,
            persistent,
            metadata,
            loaded: false,
            module: null,
            // Data store specific
            localStorage: enableLocalStorage && localStorage,
            localStorageKey: localStorageKey || `deezul_${name}_${ref}`
        };

        // String = module path for lazy loading
        if (typeof pathOrData === TYPEOF.STRING) {
            entry.modulePath = pathOrData;
        }
        // Object = inline data/config (already loaded)
        else if (typeof pathOrData === TYPEOF.OBJECT && pathOrData !== null) {
            entry.module = pathOrData;
            entry.loaded = true;
        }

        registry.set(ref, entry);

        if (persistent) {
            persistentModules.add(ref);
        } else {
            transientModules.add(ref);
        }

        // Restore from localStorage if enabled and has persisted data
        if (entry.localStorage && !entry.loaded) {
            const persisted = _loadFromLocalStorage(entry.localStorageKey);
            if (persisted) {
                entry.module = persisted;
                entry.loaded = true;
                logger.debug(`Restored '${ref}' from localStorage`);
            }
        }

        logger.debug(`Registered '${ref}' (${persistent ? 'persistent' : 'transient'})`);

        // Notify any waiters
        if (waiters.has(ref)) {
            for (const resolve of waiters.get(ref)) resolve();
            waiters.delete(ref);
        }
    }

    /**
     * Wait for a module to be registered
     * Resolves immediately if already registered, otherwise waits
     * @param {string} ref - Module reference
     * @returns {Promise<void>}
     */
    function whenRegistered(ref) {
        if (registry.has(ref)) return Promise.resolve();
        return new Promise(resolve => {
            if (!waiters.has(ref)) {
                waiters.set(ref, new Set());
            }
            waiters.get(ref).add(resolve);
        });
    }

    /**
     * Register multiple modules
     * @param {Array} modules - Array of module configs
     */
    function registerAll(modules) {
        for (let i = 0, len = modules.length; i < len; i++) {
            const mod = modules[i];
            register(
                mod.ref,
                mod.path || mod.data || mod.config,
                {
                    persistent: mod.persistent !== false,
                    metadata: mod.metadata || {},
                    localStorage: mod.localStorage || false,
                    localStorageKey: mod.localStorageKey
                }
            );
        }
    }

    /**
     * Get a module, loading if necessary
     * For data stores with enableProxy: returns shared proxy
     * @param {string} ref - Module reference
     * @returns {Promise<any>} Module content
     */
    async function get(ref) {
        // For data stores, check proxy cache first
        if (enableProxy && proxyCache.has(ref)) {
            return proxyCache.get(ref);
        }

        const entry = await _ensureLoaded(ref);
        if (!entry) {
            logger.error(`'${ref}' not found`);
            return null;
        }

        // For data stores, wrap in proxy and cache
        if (enableProxy) {
            const proxy = _createProxy(entry);
            proxyCache.set(ref, proxy);
            return proxy;
        }

        return entry.module;
    }

    /**
     * Get a copy of a data store (isolated, changes don't affect original)
     * Only available for data registries with enableProxy
     * @param {string} ref - Module reference
     * @returns {Promise<Proxy>} Proxied copy
     */
    async function getCopy(ref) {
        if (!enableProxy) {
            logger.warn('getCopy() only available for data registries');
            return null;
        }

        const entry = await _ensureLoaded(ref);
        if (!entry) {
            logger.error(`'${ref}' not found`);
            return null;
        }

        // Unwrap if proxied, then deep clone
        const raw = entry.module[TARGET] || entry.module;
        const cloned = deepClone(raw);
        const factory = createProxyFactory();
        return factory.createProxy(cloned);
    }

    /**
     * Replace a module's content
     * @param {string} ref - Module reference
     * @param {any} newContent - New content
     */
    function set(ref, newContent) {
        const entry = registry.get(ref);
        if (!entry) {
            logger.error(`'${ref}' not found`);
            return;
        }

        entry.module = newContent;
        entry.loaded = true;

        // Clear proxy cache to force re-creation
        proxyCache.delete(ref);

        // Persist if localStorage enabled
        if (entry.localStorage) {
            _saveToLocalStorage(entry.localStorageKey, newContent);
        }

        logger.debug(`'${ref}' replaced`);
    }

    /**
     * Check if module exists
     * @param {string} ref - Module reference
     * @returns {boolean}
     */
    function has(ref) {
        return registry.has(ref);
    }

    /**
     * Remove a module
     * @param {string} ref - Module reference
     */
    function remove(ref) {
        const entry = registry.get(ref);
        if (entry) {
            if (entry.localStorage) {
                localStorage.removeItem(entry.localStorageKey);
            }
        }

        registry.delete(ref);
        persistentModules.delete(ref);
        transientModules.delete(ref);
        transientInstances.delete(ref);
        proxyCache.delete(ref);
        logger.debug(`'${ref}' removed`);
    }

    /**
     * Get all registered refs
     * @returns {string[]}
     */
    function list() {
        return Array.from(registry.keys());
    }

    /**
     * Get module metadata
     * @param {string} ref - Module reference
     * @returns {Object|null}
     */
    function getMetadata(ref) {
        const entry = registry.get(ref);
        return entry ? entry.metadata : null;
    }

    // ========================================================================
    // Instance Tracking (for component GC)
    // ========================================================================

    /**
     * Register an active instance (for transient modules)
     * @param {string} ref - Module reference
     * @param {string} instanceId - Unique instance ID
     */
    function registerInstance(ref, instanceId) {
        if (!transientModules.has(ref)) return;

        if (!transientInstances.has(ref)) {
            transientInstances.set(ref, new Set());
        }

        transientInstances.get(ref).add(instanceId);
        logger.debug(`+1 instance of '${ref}' (${transientInstances.get(ref).size})`);
    }

    /**
     * Unregister an instance
     * @param {string} ref - Module reference
     * @param {string} instanceId - Instance ID
     */
    function unregisterInstance(ref, instanceId) {
        const instances = transientInstances.get(ref);
        if (instances) {
            instances.delete(instanceId);
            if (instances.size === 0) {
                transientInstances.delete(ref);
            }
            logger.debug(`-1 instance of '${ref}' (${instances.size})`);
        }
    }

    /**
     * Get instance count
     * @param {string} ref - Module reference
     * @returns {number}
     */
    function getInstanceCount(ref) {
        const instances = transientInstances.get(ref);
        return instances ? instances.size : 0;
    }

    /**
     * Garbage collect unused transient modules
     * @returns {Object} { collected, skipped }
     */
    function gc() {
        logger.info('Garbage collecting unused transient modules...');
        let collected = 0;
        let skipped = 0;

        for (const ref of transientModules) {
            const instances = transientInstances.get(ref);
            const inUse = instances && instances.size > 0;
            const entry = registry.get(ref);

            if (!inUse && entry && entry.loaded) {
                entry.module = null;
                entry.loaded = false;
                proxyCache.delete(ref);
                collected++;
                logger.info(`Collected '${ref}'`);
            } else if (inUse) {
                skipped++;
            }
        }

        logger.info(`GC complete: ${collected} collected, ${skipped} skipped`);
        return { collected, skipped };
    }

    // ========================================================================
    // LocalStorage Methods (for data stores)
    // ========================================================================

    /**
     * Force persist to localStorage
     * @param {string} ref - Module reference
     */
    function persist(ref) {
        const entry = registry.get(ref);
        if (!entry || !entry.localStorage) {
            logger.warn(`Cannot persist '${ref}' - not configured for localStorage`);
            return;
        }

        const raw = entry.module[TARGET] || entry.module;
        _saveToLocalStorage(entry.localStorageKey, raw);
        logger.debug(`'${ref}' persisted`);
    }

    /**
     * Force restore from localStorage
     * @param {string} ref - Module reference
     */
    function restore(ref) {
        const entry = registry.get(ref);
        if (!entry || !entry.localStorage) {
            logger.warn(`Cannot restore '${ref}' - not configured for localStorage`);
            return;
        }

        const persisted = _loadFromLocalStorage(entry.localStorageKey);
        if (persisted) {
            entry.module = persisted;
            proxyCache.delete(ref);
            logger.debug(`'${ref}' restored`);
        }
    }

    /**
     * Clear persisted data
     * @param {string} ref - Module reference
     */
    function clearPersisted(ref) {
        const entry = registry.get(ref);
        if (entry && entry.localStorage) {
            localStorage.removeItem(entry.localStorageKey);
            logger.debug(`Cleared localStorage for '${ref}'`);
        }
    }

    // ========================================================================
    // Stats & Utilities
    // ========================================================================

    /**
     * Get registry statistics
     * @returns {Object}
     */
    function getStats() {
        const loaded = Array.from(registry.values()).filter(e => e.loaded).length;
        const totalInstances = Array.from(transientInstances.values())
            .reduce((sum, instances) => sum + instances.size, 0);

        return {
            total: registry.size,
            persistent: persistentModules.size,
            transient: transientModules.size,
            loaded,
            activeInstances: totalInstances
        };
    }

    /**
     * Clear the registry
     */
    function clear() {
        // Clear localStorage for modules that have it enabled
        for (const [, entry] of registry) {
            if (entry.localStorage) {
                localStorage.removeItem(entry.localStorageKey);
            }
        }

        registry.clear();
        persistentModules.clear();
        transientModules.clear();
        transientInstances.clear();
        proxyCache.clear();
        logger.info('Registry cleared');
    }

    // ========================================================================
    // Internal Methods
    // ========================================================================

    /**
     * Ensure module is loaded
     * @param {string} ref - Module reference
     * @returns {Promise<Object>} Entry
     */
    async function _ensureLoaded(ref) {
        const entry = registry.get(ref);
        if (!entry) return null;

        if (entry.loaded) return entry;

        if (entry.modulePath) {
            try {
                logger.info(`Loading '${ref}' from ${entry.modulePath}`);

                // Artificial delay for demos
                if (entry.metadata?.lazyLoadDelay) {
                    await new Promise(r => setTimeout(r, entry.metadata.lazyLoadDelay));
                }

                const module = await import(entry.modulePath);
                let loadedModule = module.default || module;

                // If it's a factory function, call it to get the component definition
                if (typeof loadedModule === TYPEOF.FUNCTION && !loadedModule.prototype?.render) {
                    loadedModule = loadedModule();
                }

                entry.module = loadedModule;
                entry.loaded = true;

                // Check localStorage override
                if (entry.localStorage) {
                    const persisted = _loadFromLocalStorage(entry.localStorageKey);
                    if (persisted) {
                        entry.module = persisted;
                    }
                }

                if (onLoad) onLoad(ref, entry.module);

            } catch (error) {
                logger.error(`Failed to load '${ref}'`, error);
                return null;
            }
        }

        return entry;
    }

    /**
     * Create proxy for data store with localStorage persistence
     * @param {Object} entry - Registry entry
     * @returns {Proxy}
     */
    function _createProxy(entry) {
        // Create proxy with localStorage persistence on set/delete
        const factory = createProxyFactory(new Map([
            [Object, {
                get: (target, key) => target[key],
                set: (target, key, value) => {
                    target[key] = value;
                    if (entry.localStorage) {
                        _debouncedPersist(entry);
                    }
                    return true;
                },
                delete: (target, key) => {
                    delete target[key];
                    return true;
                }
            }]
        ]));
        return factory.createProxy(entry.module);
    }

    /**
     * Debounced localStorage persist
     * @param {Object} entry - Registry entry
     */
    function _debouncedPersist(entry) {
        if (persistTimers.has(entry.ref)) {
            clearTimeout(persistTimers.get(entry.ref));
        }

        const timer = setTimeout(() => {
            const raw = entry.module[TARGET] || entry.module;
            _saveToLocalStorage(entry.localStorageKey, raw);
            persistTimers.delete(entry.ref);
        }, 500);

        persistTimers.set(entry.ref, timer);
    }

    /**
     * Save to localStorage
     */
    function _saveToLocalStorage(key, data) {
        try {
            localStorage.setItem(key, JSON.stringify(data));
        } catch (e) {
            logger.error(`Failed to save to localStorage: ${key}`, e);
        }
    }

    /**
     * Load from localStorage
     */
    function _loadFromLocalStorage(key) {
        try {
            const stored = localStorage.getItem(key);
            return stored ? JSON.parse(stored) : null;
        } catch (e) {
            logger.error(`Failed to load from localStorage: ${key}`, e);
            return null;
        }
    }

    // ========================================================================
    // Return Registry Instance
    // ========================================================================

    return {
        // Core
        register,
        registerAll,
        get,
        getCopy: enableProxy ? getCopy : undefined,
        set,
        has,
        remove,
        list,
        getMetadata,
        whenRegistered,

        // Instance tracking
        registerInstance,
        unregisterInstance,
        getInstanceCount,
        gc,

        // LocalStorage (data stores)
        persist: enableLocalStorage ? persist : undefined,
        restore: enableLocalStorage ? restore : undefined,
        clearPersisted: enableLocalStorage ? clearPersisted : undefined,

        // Utilities
        getStats,
        clear,

        // Internal access (for advanced use)
        _registry: registry
    };
}

export default createModuleRegistry;
