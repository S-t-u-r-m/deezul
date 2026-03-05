/**
 * Deezul.js - Framework Entry Point
 *
 * Two modes:
 *   SPA Mode (with routes):
 *     Deezul.init({ rootElement, modules, routes, ... })
 *
 *   Root Component Mode (no routes):
 *     Deezul.init({ rootElement, component, modules })
 */

import { componentRegistry, dataRegistry } from './registries.js';
import { createRouter, getRouter } from './Router.js';
import { onReady } from './helpers.js';
import { createLogger, setLogLevel, setModuleLogLevel, LOG_LEVEL } from './Logger.js';
import { registerDirective, unregisterDirective, getDirective, getDirectiveNames } from './Directives.js';
import { registerGlobalErrorHandler, unregisterGlobalErrorHandler } from './ErrorBoundary.js';
import { configure, getConfig, directives, logging, errors, framework } from './Configuration.js';
import { REBINDABLE, REBIND, PARENT_PROXY } from './DataProxy.js';
import { dz404 } from './LibraryComponents.js';
import './DzComponent.js';
import './RouterComponent.js';

const logger = createLogger('Deezul');

let initialized = false;

/**
 * Initialize the Deezul framework
 * @param {Object} options
 * @param {string} options.rootElement - ID of the root DOM element
 * @param {Array} [options.modules] - Array of { ref, data, type? } to register
 *   - type: 'data' → registers in dataRegistry (shared reactive stores)
 *   - type: omitted → registers in componentRegistry (UI components)
 * @param {Array} [options.routes] - Route definitions (enables SPA mode)
 * @param {string} [options.component] - Root component type (non-SPA mode)
 * @param {Function} [options.beforeNavigate] - Route guard
 * @param {Function} [options.afterNavigate] - Post-navigation hook
 * @param {string} [options.notFoundComponent] - Custom 404 component type
 * @param {string} [options.basePath] - Base path prefix for subpath deployment (e.g. '/deezul')
 * @param {Object} [options.logging] - Logging config overrides (see Configuration.js)
 * @param {Object} [options.errors] - Error handling config overrides
 * @param {Object} [options.directives] - Directive prefix overrides
 */
function init(options = {}) {
	const {
		rootElement,
		modules = [],
		routes,
		component,
		beforeNavigate,
		afterNavigate,
		notFoundComponent,
		basePath
	} = options;

	initialized = true;

	// Apply configuration overrides before anything else
	configure({
		logging: options.logging,
		errors: options.errors,
		directives: options.directives,
		framework: rootElement ? { rootElement } : undefined
	});

	// Register modules — route to correct registry by type
	for (let i = 0, len = modules.length; i < len; i++) {
		const mod = modules[i];
		if (mod.type === 'data') {
			dataRegistry.register(
				mod.ref,
				mod.path || mod.data,
				{
					persistent: mod.persistent !== false,
					localStorage: mod.localStorage || false,
					localStorageKey: mod.localStorageKey
				}
			);
		} else {
			componentRegistry.register(mod.ref, mod.path || mod.data);
		}
	}

	// Register built-in dz-404 if not already provided
	if (!componentRegistry.has('dz-404')) {
		componentRegistry.register('dz-404', dz404);
	}

	onReady(() => {
		const root = document.getElementById(rootElement);
		if (!root) {
			logger.error(`Root element "#${rootElement}" not found`);
			return;
		}

		if (routes) {
			// SPA Mode — create router and inject <router-component>
			initSPA(root, {
				routes,
				beforeNavigate,
				afterNavigate,
				notFoundComponent,
				basePath
			});
		} else if (component) {
			// Root Component Mode — render single component
			initRootComponent(root, component);
		} else {
			logger.warn('No routes or component specified in Deezul.init()');
		}
	});
}

/**
 * SPA Mode initialization
 */
function initSPA(root, { routes, beforeNavigate, afterNavigate, notFoundComponent, basePath }) {
	logger.info('Initializing SPA mode');

	const router = createRouter({
		routes,
		beforeNavigate,
		afterNavigate,
		notFoundComponent: notFoundComponent || 'dz-404',
		basePath
	});

	// Clear root and inject router-component
	root.innerHTML = '';
	const routerEl = document.createElement('router-component');
	root.appendChild(routerEl);

	// Navigate to current URL
	router.init();
}

/**
 * Root Component Mode initialization
 */
function initRootComponent(root, componentType) {
	logger.info('Initializing root component mode', { component: componentType });

	root.innerHTML = '';
	const dzComponent = document.createElement('dz-component');
	dzComponent.setAttribute('dz-type', componentType);
	root.appendChild(dzComponent);
}

/**
 * Programmatic navigation (convenience wrapper)
 * @param {string} path - Path to navigate to
 * @param {Object} [options] - { replace: boolean }
 */
function navigate(path, options) {
	const router = getRouter();
	if (router) {
		router.navigate(path, options);
	} else {
		logger.warn('navigate() called but no router initialized');
	}
}

/**
 * Get current route info
 * @returns {{ route, params, path } | null}
 */
function getCurrentRoute() {
	const router = getRouter();
	return router ? router.getCurrentRoute() : null;
}

/**
 * Get 404 info if currently on a not-found page
 * @returns {{ path, backPath } | null}
 */
function getNotFoundInfo() {
	const router = getRouter();
	if (router && router.isNotFound) {
		return {
			path: router.notFoundPath,
			backPath: router.notFoundBackPath
		};
	}
	return null;
}

/**
 * Get a reactive data store by reference
 * @param {string} ref - Data store reference name
 * @returns {Promise<Proxy>} Reactive proxy of the data store
 */
function getDataStore(ref) {
	return dataRegistry.get(ref);
}

/**
 * Get an isolated deep clone of a data store (mutations don't affect original)
 * @param {string} ref - Data store reference name
 * @returns {Promise<Proxy>} Proxied deep clone
 */
function cloneStore(ref) {
	return dataRegistry.getCopy(ref);
}

/**
 * Programmatically create a dz-component element
 * @param {string} type - Component type name
 * @param {Object} [options]
 * @param {HTMLElement} [options.parent] - Parent element to append to
 * @param {Object} [options.attrs] - Attributes to set on the element
 * @returns {HTMLElement} The created dz-component element
 */
function createComponent(type, options = {}) {
	const el = document.createElement('dz-component');
	el.setAttribute('dz-type', type);

	if (options.attrs) {
		const attrEntries = Object.entries(options.attrs);
		for (let i = 0, len = attrEntries.length; i < len; i++) {
			el.setAttribute(attrEntries[i][0], attrEntries[i][1]);
		}
	}

	if (options.parent) {
		options.parent.appendChild(el);
	}

	return el;
}

/**
 * Check if the framework has been initialized
 * @returns {boolean}
 */
function isInitialized() {
	return initialized;
}

const Deezul = {
	init,
	navigate,
	getCurrentRoute,
	getNotFoundInfo,
	registerDirective,
	unregisterDirective,
	getDirective,
	getDirectiveNames,
	registerGlobalErrorHandler,
	unregisterGlobalErrorHandler,
	registry: componentRegistry,
	getRouter,

	// Data store access
	getDataStore,
	cloneStore,

	// Component creation
	createComponent,

	// Framework state
	isInitialized,

	// Rebinding symbols
	REBINDABLE,
	REBIND,
	PARENT_PROXY,

	// Configuration API
	configure,
	getConfig,
	setLogLevel,
	setModuleLogLevel,
	LOG_LEVEL,

	// Configuration state (read-only references)
	directives,
	logging,
	errors,
	framework
};

// Expose globally so compiled components can access the Deezul API at runtime
if (typeof window !== 'undefined') window.Deezul = Deezul;
else if (typeof globalThis !== 'undefined') globalThis.Deezul = Deezul;

export default Deezul;
export { init, navigate, getCurrentRoute, getNotFoundInfo, registerDirective, unregisterDirective, getDirective, getDirectiveNames, registerGlobalErrorHandler, unregisterGlobalErrorHandler, getDataStore, cloneStore, createComponent, isInitialized, REBINDABLE, REBIND, PARENT_PROXY, configure, getConfig };
