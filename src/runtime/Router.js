/**
 * Router.js - History API Based Router
 *
 * Features:
 * - History API navigation (no hash)
 * - Nested routes with parent layouts
 * - Route params (:id, :slug, etc.)
 * - beforeNavigate guard with next() pattern
 * - Route matching with Map for O(1) lookup
 * - Style cascade from parent routes
 * - layouts: ['layout1', 'layout2'] - Wraps component in layout components
 * - basePath: '/subdir' - Base path prefix for deployment on subpaths (e.g. GitHub Pages)
 *
 * Inheritance Control:
 * - inheritLayouts: false - Breaks layout chain (renders at depth 0). Default: true
 * - inheritStyles: true - Enables style cascade from parents. Default: false (for efficiency)
 * - inherit: false - Shorthand for both inheritLayouts: false AND inheritStyles: false
 */

import { createLogger } from './Logger.js';
import { TYPEOF } from './constants.js';

const logger = createLogger('Router');

class Router {
    // ========================================================================
    // Constructor
    // ========================================================================

    constructor(options = {}) {
        this.basePath = (options.basePath || '').replace(/\/+$/, '');
        this.routes = [];
        this.routeMap = new Map();
        this.currentRoute = null;
        this.currentParams = {};
        this.beforeNavigate = options.beforeNavigate || null;
        this.afterNavigate = options.afterNavigate || null;
        this.isInitialized = false;
        this.notFoundComponent = options.notFoundComponent || null;
        this.isNotFound = false;
        this.notFoundPath = null;
        this.notFoundBackPath = '/';

        // Route change listeners (improved over old callback chain)
        this._listeners = [];

        // Track active router-components for nested rendering
        this.routerComponents = [];

        // Track route chains for optimized re-rendering
        this._previousRouteChain = [];
        this._currentRouteChain = [];
        this._divergenceDepth = 0;
        this._navigatedPath = null;
        this._previousNavigatedPath = null;
        this._navigating = false;

        // Initialize routes if provided
        if (options.routes) {
            this.registerRoutes(options.routes);
        }

        // Bind event handlers (stored for cleanup in destroy())
        this._popstateHandler = (e) => this._handlePopState(e);
        this._clickHandler = (e) => this._handleLinkClick(e);

        window.addEventListener('popstate', this._popstateHandler);
        document.addEventListener('click', this._clickHandler);

        logger.info('Router created');
    }

    // ========================================================================
    // Route Registration
    // ========================================================================

    /**
     * Register routes from config array
     * @param {Array} routes - Routes configuration array
     * @param {string} parentPath - Parent path for nested routes
     * @param {Object} parentRoute - Parent route entry
     */
    registerRoutes(routes, parentPath = '', parentRoute = null) {
        for (let i = 0, len = routes.length; i < len; i++) {
            const route = routes[i];
            const fullPath = this._normalizePath(parentPath + route.path);

            // Determine inheritance
            const inheritLayouts = route.inheritLayouts !== false && route.inherit !== false;
            const inheritStyles = route.inheritStyles === true && route.inherit !== false;

            // Layout chain: if inheritLayouts is false, this route starts at depth 0
            const effectiveParent = inheritLayouts ? parentRoute : null;

            // Style chain
            const cascadedStyles = inheritStyles
                ? this._collectCascadedStyles(route, parentRoute)
                : (route.styles || '');

            const normalizedLayouts = this._normalizeLayouts(route.layouts);
            const component = route.component || route.view;

            const routeEntry = {
                ...route,
                component,
                fullPath,
                parent: effectiveParent,
                cascadedStyles,
                normalizedLayouts,
                inheritLayouts,
                inheritStyles
            };

            this.routes.push(routeEntry);

            const pattern = this._createRoutePattern(fullPath);
            routeEntry.pattern = pattern;

            // O(1) lookup for non-param routes
            if (!fullPath.includes(':')) {
                this.routeMap.set(fullPath, routeEntry);
            }

            logger.debug('Registered route', { path: fullPath, component, layouts: normalizedLayouts?.length || 0 });

            // Register children recursively
            if (route.children && route.children.length > 0) {
                this.registerRoutes(route.children, fullPath, routeEntry);
            }
        }
    }

    /**
     * Normalize layouts array
     * @param {Array} layouts - Array of layout component names
     * @returns {Array|null}
     */
    _normalizeLayouts(layouts) {
        if (!layouts || !Array.isArray(layouts) || layouts.length === 0) {
            return null;
        }
        return layouts.filter(layout => {
            if (typeof layout === TYPEOF.STRING) return true;
            logger.warn('Invalid layout entry (must be string), skipping', { layout });
            return false;
        });
    }

    /**
     * Collect cascaded styles from parent chain
     * @param {Object} route - Current route
     * @param {Object} parentRoute - Parent route
     * @returns {string} Combined CSS
     */
    _collectCascadedStyles(route, parentRoute) {
        let styles = '';
        if (parentRoute && parentRoute.cascadedStyles) {
            styles += parentRoute.cascadedStyles;
        }
        if (route.styles) {
            styles += route.styles;
        }
        return styles;
    }

    /**
     * Create a regex pattern for route matching
     * @param {string} path - Route path (may contain :params)
     * @returns {Object} { regex, paramNames }
     */
    _createRoutePattern(path) {
        const paramNames = [];
        let regexStr = path
            .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            .replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (match, paramName) => {
                paramNames.push(paramName);
                return '([^/]+)';
            });
        regexStr = '^' + regexStr + '$';
        return { regex: new RegExp(regexStr), paramNames };
    }

    /**
     * Normalize a path
     * @param {string} path
     * @returns {string}
     */
    _normalizePath(path) {
        if (!path.startsWith('/')) path = '/' + path;
        if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
        path = path.replace(/\/+/g, '/');
        return path;
    }

    /**
     * Strip basePath prefix from a browser pathname to get internal path
     * @param {string} pathname - Full browser pathname
     * @returns {string} Internal path without basePath
     */
    _stripBase(pathname) {
        if (this.basePath && pathname.startsWith(this.basePath)) {
            return pathname.slice(this.basePath.length) || '/';
        }
        return pathname;
    }

    /**
     * Prepend basePath to an internal path for browser URL
     * @param {string} path - Internal path
     * @returns {string} Full browser path
     */
    _addBase(path) {
        return this.basePath + path;
    }

    // ========================================================================
    // Route Matching & Navigation
    // ========================================================================

    /**
     * Match a path to a route
     * @param {string} path
     * @returns {Object|null} { route, params } or null
     */
    matchRoute(path) {
        path = this._normalizePath(path);

        // O(1) exact match
        if (this.routeMap.has(path)) {
            return { route: this.routeMap.get(path), params: {} };
        }

        // Regex fallback for param routes
        for (let r = 0, rLen = this.routes.length; r < rLen; r++) {
            const route = this.routes[r];
            const match = path.match(route.pattern.regex);
            if (match) {
                const params = {};
                const paramNames = route.pattern.paramNames;
                for (let i = 0, len = paramNames.length; i < len; i++) {
                    params[paramNames[i]] = match[i + 1];
                }
                return { route, params };
            }
        }

        return null;
    }

    /**
     * Navigate to a path
     * @param {string} path
     * @param {Object} options - { replace: boolean }
     * @returns {Promise<boolean>}
     */
    async navigate(path, options = {}) {
        path = this._normalizePath(path);

        // Re-entrancy guard: skip if already navigating to same path
        if (this._navigating) {
            logger.debug('Navigation already in progress, skipping', { path });
            return false;
        }
        this._navigating = true;

        try {
            logger.info('Navigating to', { path });

            const matched = this.matchRoute(path);
            if (!matched) {
                logger.warn('No route matched - showing 404', { path });
                this._handleNotFound(path, options);
                return false;
            }

            this.isNotFound = false;

            const { route, params } = matched;
            const from = this.currentRoute ? { ...this.currentRoute, params: this.currentParams } : null;
            const to = { ...route, params };

            // Run beforeNavigate guard
            if (this.beforeNavigate) {
                const result = await this._runBeforeNavigate(to, from);
                if (result === false) {
                    logger.debug('Navigation cancelled by beforeNavigate');
                    return false;
                }
                if (typeof result === TYPEOF.STRING) {
                    logger.debug('Redirecting to', { path: result });
                    this._navigating = false; // Allow redirect to proceed
                    return this.navigate(result, options);
                }
            }

            this._updateHistory(path, {}, options.replace);
            this.currentRoute = route;
            this.currentParams = params;
            this._navigatedPath = path;

            // Compute divergence BEFORE notifying listeners
            this._computeRouteChainAndDivergence();
            this._notifyListeners(to, from);

            if (this.afterNavigate) {
                this.afterNavigate(to, from);
            }

            logger.info('Navigation complete', { path, component: route.component, params });
            return true;
        } finally {
            this._navigating = false;
        }
    }

    /**
     * Handle 404 - route not found
     * @param {string} path
     * @param {Object} options
     */
    _handleNotFound(path, options = {}) {
        const from = this.currentRoute ? { ...this.currentRoute, params: this.currentParams } : null;

        this.isNotFound = true;
        this.notFoundPath = path;

        const closestRoute = this._findClosestRoute(path);
        this.notFoundBackPath = closestRoute ? closestRoute.fullPath : '/';

        const notFoundRoute = {
            path,
            fullPath: path,
            component: this.notFoundComponent || null,
            meta: { title: 'Page Not Found', isNotFound: true }
        };

        this.currentRoute = notFoundRoute;
        this.currentParams = {};
        this._navigatedPath = path;

        // Clear route chains so navigating away from 404 triggers full re-render
        this._previousRouteChain = [];
        this._currentRouteChain = [];

        this._updateHistory(path, { notFound: true }, options.replace);
        this._notifyListeners({ ...notFoundRoute, params: {} }, from);

        logger.info('404 - Page not found', { path, backPath: this.notFoundBackPath });
    }

    /**
     * Find the closest matching route for a path (for 404 back links)
     * @param {string} path
     * @returns {Object|null}
     */
    _findClosestRoute(path) {
        path = this._normalizePath(path);
        const segments = path.split('/').filter(s => s);
        let bestMatch = null;

        for (let i = segments.length - 1; i >= 0; i--) {
            const testPath = '/' + segments.slice(0, i).join('/');
            const normalizedTestPath = this._normalizePath(testPath);

            if (this.routeMap.has(normalizedTestPath)) {
                bestMatch = this.routeMap.get(normalizedTestPath);
                break;
            }

            for (let r = 0, rLen = this.routes.length; r < rLen; r++) {
                if (normalizedTestPath.match(this.routes[r].pattern.regex)) {
                    bestMatch = this.routes[r];
                    break;
                }
            }
            if (bestMatch) break;
        }

        return bestMatch;
    }

    /**
     * Run beforeNavigate guard with next() pattern
     * @param {Object} to
     * @param {Object} from
     * @returns {Promise<boolean|string>}
     */
    _runBeforeNavigate(to, from) {
        return new Promise((resolve) => {
            let resolved = false;
            const next = (redirectPath) => {
                if (resolved) {
                    logger.warn('next() called multiple times in beforeNavigate');
                    return;
                }
                resolved = true;
                if (redirectPath === undefined) {
                    resolve(true);
                } else if (typeof redirectPath === TYPEOF.STRING) {
                    resolve(redirectPath);
                } else {
                    resolve(true);
                }
            };
            this.beforeNavigate(to, from, next);
            setTimeout(() => {
                if (!resolved) {
                    logger.warn('beforeNavigate did not call next() - cancelling navigation');
                    resolve(false);
                }
            }, 5000);
        });
    }

    /**
     * Handle browser back/forward
     * @param {PopStateEvent} e
     */
    _handlePopState(e) {
        const path = this._stripBase(window.location.pathname);
        logger.debug('Popstate', { path, state: e.state });
        this.navigate(path, { replace: true });
    }

    /**
     * Handle link clicks for SPA navigation
     * @param {MouseEvent} e
     */
    _handleLinkClick(e) {
        if (e.button !== 0) return;
        if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;

        // composedPath() crosses Shadow DOM boundaries
        const anchor = e.composedPath().find(el => el.tagName === 'A');
        if (!anchor) return;

        const href = anchor.getAttribute('href');
        if (!href) return;
        if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('//')) return;
        if (href.startsWith('#')) return;
        if (anchor.hasAttribute('download')) return;
        if (anchor.getAttribute('target') === '_blank') return;
        if (anchor.hasAttribute('data-no-router')) return;

        e.preventDefault();
        this.navigate(this._stripBase(href));
    }

    // ========================================================================
    // Listener Management
    // ========================================================================

    /**
     * Subscribe to route changes
     * @param {Function} callback - (to, from) => void
     * @returns {Function} Unsubscribe function
     */
    subscribe(callback) {
        this._listeners.push(callback);
        return () => this.unsubscribe(callback);
    }

    /**
     * Unsubscribe from route changes
     * @param {Function} callback
     */
    unsubscribe(callback) {
        const idx = this._listeners.indexOf(callback);
        if (idx !== -1) this._listeners.splice(idx, 1);
    }

    /**
     * Notify all route change listeners
     * @param {Object} to
     * @param {Object} from
     */
    _notifyListeners(to, from) {
        for (let i = 0; i < this._listeners.length; i++) {
            this._listeners[i](to, from);
        }
    }

    // ========================================================================
    // Route Chain & Divergence
    // ========================================================================

    /**
     * Get current route info
     * @returns {Object} { route, params, path }
     */
    getCurrentRoute() {
        return {
            route: this.currentRoute,
            params: this.currentParams,
            path: this.currentRoute ? this.currentRoute.fullPath : null
        };
    }

    /**
     * Get route chain for nested rendering
     * @returns {Array} Routes/layouts from root to current
     */
    getRouteChain() {
        return this._currentRouteChain || [];
    }

    /**
     * Get the divergence depth for the current navigation
     * @returns {number}
     */
    getDivergenceDepth() {
        return this._divergenceDepth;
    }

    /**
     * Build the route chain and compute divergence depth
     * Called once per navigation before notifying listeners
     */
    _computeRouteChainAndDivergence() {
        const chain = [];
        let route = this.currentRoute;

        while (route) {
            chain.unshift(route);
            route = route.parent;
        }

        // Expand layouts
        const expandedChain = [];
        for (let i = 0, len = chain.length; i < len; i++) {
            const routeEntry = chain[i];
            const layouts = routeEntry.normalizedLayouts;
            if (layouts && layouts.length > 0) {
                for (let j = 0, lLen = layouts.length; j < lLen; j++) {
                    expandedChain.push({
                        component: layouts[j],
                        fullPath: routeEntry.fullPath,
                        cascadedStyles: routeEntry.cascadedStyles,
                        isLayout: true
                    });
                }
                expandedChain.push(routeEntry);
            } else {
                expandedChain.push(routeEntry);
            }
        }

        this._divergenceDepth = this._computeDivergenceDepth(expandedChain);
        this._previousNavigatedPath = this._navigatedPath;
        this._previousRouteChain = expandedChain;
        this._currentRouteChain = expandedChain;

        logger.debug('Route chain computed', {
            length: expandedChain.length,
            divergenceDepth: this._divergenceDepth,
            components: expandedChain.map(e => e.component)
        });
    }

    /**
     * Compute the depth at which old and new route chains diverge
     * @param {Array} newChain
     * @returns {number}
     */
    _computeDivergenceDepth(newChain) {
        const oldChain = this._previousRouteChain;
        if (!oldChain || oldChain.length === 0) return 0;

        const minLength = Math.min(oldChain.length, newChain.length);

        for (let i = 0; i < minLength; i++) {
            const oldEntry = oldChain[i];
            const newEntry = newChain[i];

            if (oldEntry.component !== newEntry.component) return i;
            if (oldEntry.fullPath !== newEntry.fullPath) return i;
            if (oldEntry.cascadedStyles !== newEntry.cascadedStyles) return i;
        }

        if (newChain.length !== oldChain.length) return minLength;

        // Same route chain but different actual path (e.g., /users/42 → /users/99)
        // Force re-render of leaf component
        if (this._previousNavigatedPath !== this._navigatedPath) return newChain.length - 1;

        return newChain.length;
    }

    // ========================================================================
    // Router Component Management
    // ========================================================================

    /**
     * Register a router-component instance
     * @param {HTMLElement} component
     * @param {number} depth
     */
    registerRouterComponent(component, depth) {
        this.routerComponents[depth] = component;
        logger.debug('Registered router-component', { depth });
    }

    /**
     * Unregister a router-component instance
     * @param {number} depth
     */
    unregisterRouterComponent(depth) {
        this.routerComponents[depth] = null;
        logger.debug('Unregistered router-component', { depth });
    }

    // ========================================================================
    // History Navigation
    // ========================================================================

    back() { window.history.back(); }
    forward() { window.history.forward(); }
    go(delta) { window.history.go(delta); }

    /**
     * Update browser history state
     * @param {string} path
     * @param {Object} state
     * @param {boolean} replace
     */
    _updateHistory(path, state = {}, replace = false) {
        const url = this._addBase(path);
        const historyState = { path, ...state };
        if (replace) {
            window.history.replaceState(historyState, '', url);
        } else {
            window.history.pushState(historyState, '', url);
        }
    }

    /**
     * Initialize router with current URL
     */
    init() {
        this.isInitialized = true;
        const path = this._stripBase(window.location.pathname);
        logger.info('Initializing with current path', { path });
        this.navigate(path, { replace: true });
    }

    /**
     * Destroy router and clean up event listeners
     */
    destroy() {
        window.removeEventListener('popstate', this._popstateHandler);
        document.removeEventListener('click', this._clickHandler);
        this._listeners.length = 0;
        this.routerComponents.length = 0;
        routerInstance = null;
        logger.info('Router destroyed');
    }
}

// ============================================================================
// Singleton
// ============================================================================

let routerInstance = null;

/**
 * Get the singleton router instance
 * @returns {Router|null}
 */
export function getRouter() {
    return routerInstance;
}

/**
 * Create a new router instance and set as singleton
 * @param {Object} options
 * @returns {Router}
 */
export function createRouter(options) {
    routerInstance = new Router(options);
    return routerInstance;
}

export default Router;
