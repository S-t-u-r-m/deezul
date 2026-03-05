/**
 * RouterComponent.js - <router-component> Custom Element
 *
 * Placeholder element where route components are rendered.
 * Uses light DOM (no Shadow DOM) - just a simple container.
 * Supports nested routes - each level has its own <router-component>.
 *
 * Usage:
 * <router-component></router-component>
 *
 * For nested routes, the parent layout includes its own router-component:
 * <!-- dashboard-layout template -->
 * <div class="dashboard">
 *     <nav>...</nav>
 *     <router-component></router-component>  <!-- children render here -->
 * </div>
 */

import { createLogger } from './Logger.js';
import { getRouter } from './Router.js';

const logger = createLogger('RouterComponent');

class RouterComponent extends HTMLElement {
    constructor() {
        super();
        this.depth = 0;
        this.currentComponent = null;
        this.router = null;
        this._unsubscribe = null;
    }

    connectedCallback() {
        logger.debug('RouterComponent connected');
        this._registerWithParentComponent();
        this._initializeWhenReady();
    }

    /**
     * Notify parent dz-component that this router-component has mounted
     */
    _registerWithParentComponent() {
        this.dispatchEvent(new CustomEvent('router-component-mounted', {
            bubbles: true,
            composed: true,
            detail: { routerComponent: this }
        }));
    }

    /**
     * Initialize when router is ready
     * Router may not exist yet if element is in HTML before Deezul.init()
     */
    _initializeWhenReady(attempts = 0) {
        this.router = getRouter();

        if (!this.router) {
            if (attempts >= 200) {
                logger.error('Router not available after 2s — is Deezul.init() called with routes?');
                return;
            }
            setTimeout(() => this._initializeWhenReady(attempts + 1), 10);
            return;
        }

        logger.debug('Router ready, initializing RouterComponent');

        this.depth = this._calculateDepth();
        logger.debug('RouterComponent depth', { depth: this.depth });

        this.router.registerRouterComponent(this, this.depth);

        // Subscribe to route changes (returns unsubscribe function)
        this._unsubscribe = this.router.subscribe((to, from) => {
            this._handleRouteChange(to, from);
        });

        // Render current route immediately
        this._renderRoute();
    }

    disconnectedCallback() {
        logger.debug('RouterComponent disconnected', { depth: this.depth });

        if (this.router) {
            this.router.unregisterRouterComponent(this.depth);
        }
        if (this._unsubscribe) {
            this._unsubscribe();
            this._unsubscribe = null;
        }
        this._clearContent();
    }

    /**
     * Calculate nesting depth by counting ancestor router-components
     * Walks through both light DOM and Shadow DOM boundaries
     * @returns {number} Depth (0 = root)
     */
    _calculateDepth() {
        let depth = 0;
        let parent = this.parentElement;

        while (parent) {
            if (parent.tagName === 'ROUTER-COMPONENT') {
                depth++;
            }
            if (parent.parentElement) {
                parent = parent.parentElement;
            } else if (parent.getRootNode() instanceof ShadowRoot) {
                parent = parent.getRootNode().host;
            } else {
                parent = null;
            }
        }

        return depth;
    }

    /**
     * Handle route change events
     * @param {Object} to - New route
     * @param {Object} from - Previous route
     */
    _handleRouteChange(to, from) {
        logger.debug('Route changed', { depth: this.depth, to: to?.fullPath });
        this._renderRoute();
    }

    /**
     * Render the appropriate route component for this depth
     */
    _renderRoute() {
        // Don't render before router has initialized (prevents spurious 404 flash)
        if (!this.router.isInitialized) return;

        // Check for global 404 at root depth
        if (this.depth === 0 && this.router.isNotFound) {
            const backPath = this.router.notFoundBackPath || '/';
            logger.info('Rendering 404 page', { path: this.router.notFoundPath, backPath });
            this._show404(this.router.notFoundPath, backPath);
            return;
        }

        const routeChain = this.router.getRouteChain();
        const routeForThisDepth = routeChain[this.depth];

        logger.debug('_renderRoute check', {
            depth: this.depth,
            chainLength: routeChain.length,
            routeForThisDepth: routeForThisDepth?.component,
            chain: routeChain.map(r => r.component)
        });

        // Nested 404 - parent route exists but no child for this depth
        if (!routeForThisDepth) {
            const currentPath = window.location.pathname;
            const lastValidRoute = routeChain[this.depth - 1];
            const backPath = lastValidRoute?.fullPath || '/';
            logger.info('Rendering nested 404 page', { depth: this.depth, currentPath, backPath });
            this._show404(currentPath, backPath);
            return;
        }

        // Skip re-render before divergence point (preserves component state)
        const divergenceDepth = this.router.getDivergenceDepth();
        if (this.depth < divergenceDepth) {
            logger.debug('Skipping re-render (before divergence)', { depth: this.depth, divergenceDepth });
            return;
        }

        const componentRef = routeForThisDepth.component;
        const params = this.router.currentParams;

        logger.info('Rendering route', { depth: this.depth, component: componentRef, params, divergenceDepth });

        this._clearContent();

        // Create dz-component (uses dz-type attribute for new framework)
        const dzComponent = document.createElement('dz-component');
        dzComponent.setAttribute('dz-type', componentRef);

        // Pass route params
        if (params && Object.keys(params).length > 0) {
            dzComponent._routeParams = params;
        }

        // Pass cascaded styles
        if (routeForThisDepth.cascadedStyles) {
            dzComponent._cascadedStyles = routeForThisDepth.cascadedStyles;
        }

        this.appendChild(dzComponent);
        this.currentComponent = dzComponent;

        // Mark pending router validation for nested routes
        if (routeChain.length > this.depth + 1) {
            const childRoute = routeChain[this.depth + 1];
            dzComponent._pendingRouterValidation = {
                parentComponent: routeForThisDepth.component,
                childPath: childRoute?.fullPath
            };
        }
    }

    /**
     * Clear current content
     */
    _clearContent() {
        if (this.currentComponent) {
            this.currentComponent.remove();
            this.currentComponent = null;
        }
        this.innerHTML = '';
    }

    /**
     * Show 404 page
     * @param {string} path - The path that wasn't found
     * @param {string} backPath - Path to link back to
     */
    _show404(path, backPath = '/') {
        this._clearContent();

        const notFoundType = this.router.notFoundComponent || 'dz-404';

        const dzComponent = document.createElement('dz-component');
        dzComponent.setAttribute('dz-type', notFoundType);
        dzComponent._routeParams = {
            path: path || 'unknown',
            backPath
        };

        this.appendChild(dzComponent);
        this.currentComponent = dzComponent;
    }
}

// Register the custom element
if (!customElements.get('router-component')) {
    customElements.define('router-component', RouterComponent);
}

export default RouterComponent;
