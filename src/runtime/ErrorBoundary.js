/**
 * ErrorBoundary.js - Component Error Handling
 *
 * Two-tier error handling:
 *   Fatal (during mount): Show error fallback UI in shadow DOM.
 *   Non-fatal (after mount): Log to console, call onError callback, keep component alive.
 *
 * Fallback chain (fatal only):
 *   component $error → global handlers → built-in error UI
 *
 * Recovery: retry button attempts remount (max 3 attempts).
 */

import { createLogger } from './Logger.js';
import { renderError } from './LibraryComponents.js';
import { errors as errorConfig } from './Configuration.js';

const logger = createLogger('ErrorBoundary');

// ============================================================================
// ERROR STATE TRACKING
// ============================================================================

/** @type {WeakMap<Element, { hasError: boolean, errorInfo: Object, recoveryAttempts: number }>} */
const componentErrorState = new WeakMap();

/**
 * Set error state on a component element
 * @param {Element} el - DzComponent element
 * @param {Object} errorInfo - Error info object
 */
function setErrorState(el, errorInfo) {
	componentErrorState.set(el, {
		hasError: true,
		errorInfo,
		recoveryAttempts: (componentErrorState.get(el)?.recoveryAttempts || 0)
	});
}

/**
 * Clear error state for a component element
 * @param {Element} el - DzComponent element
 */
export function clearErrorState(el) {
	componentErrorState.delete(el);
}

/**
 * Check if a component element has an error
 * @param {Element} el - DzComponent element
 * @returns {boolean}
 */
export function hasError(el) {
	const state = componentErrorState.get(el);
	return state ? state.hasError : false;
}

// ============================================================================
// GLOBAL ERROR HANDLERS
// ============================================================================

/** @type {Function[]} */
const globalErrorHandlers = [];

/**
 * Register a global error handler
 * Called for every component error after the component's own $error hook.
 * @param {Function} handler - (errorInfo) => true|string|void
 */
export function registerGlobalErrorHandler(handler) {
	if (typeof handler === 'function') {
		globalErrorHandlers.push(handler);
	}
}

/**
 * Unregister a global error handler
 * @param {Function} handler - Previously registered handler
 */
export function unregisterGlobalErrorHandler(handler) {
	const idx = globalErrorHandlers.indexOf(handler);
	if (idx !== -1) globalErrorHandlers.splice(idx, 1);
}

// ============================================================================
// ERROR INFO
// ============================================================================

/**
 * Create a standardized error info object
 * @param {Element} el - DzComponent element
 * @param {Error} error - The caught error
 * @param {string} phase - Lifecycle phase ('mount', 'created', 'mounted', 'unmounted', 'event', 'binding')
 * @returns {Object}
 */
function createErrorInfo(el, error, phase) {
	return {
		type: el.component?.type || el.getAttribute('dz-type') || 'unknown',
		phase,
		error,
		instanceId: el.component?.instanceId || null,
		message: error?.message || String(error)
	};
}

// ============================================================================
// HANDLE COMPONENT ERROR (fatal — mount-time)
// ============================================================================

/**
 * Handle a fatal component error (during mount).
 * Runs fallback chain: component $error → global handlers → built-in UI.
 *
 * @param {Element} el - DzComponent element
 * @param {Error} error - The caught error
 * @param {string} phase - Lifecycle phase where error occurred
 */
export function handleComponentError(el, error, phase) {
	const errorInfo = createErrorInfo(el, error, phase);

	logger.error(`Component error in '${errorInfo.type}' during ${phase}:`, error);

	// Set error state (preserves recovery attempt count)
	setErrorState(el, errorInfo);

	// 1. Try component's $error hook (only if proxy exists — error may occur before proxy setup)
	const onError = el.component?.onError;
	if (onError && el.component?.proxy) {
		try {
			const result = onError.call(el.component.proxy, errorInfo);
			if (result === true) return;          // handled — skip fallback
			if (typeof result === 'string') {      // custom HTML fallback
				renderCustomFallback(el, result);
				return;
			}
		} catch (hookError) {
			logger.warn('$error hook threw:', hookError);
		}
	}

	// 2. Try global handlers
	for (let i = 0, len = globalErrorHandlers.length; i < len; i++) {
		try {
			const result = globalErrorHandlers[i](errorInfo);
			if (result === true) return;
			if (typeof result === 'string') {
				renderCustomFallback(el, result);
				return;
			}
		} catch (handlerError) {
			logger.warn('Global error handler threw:', handlerError);
		}
	}

	// 3. Show built-in error fallback
	renderBuiltInFallback(el, errorInfo);
}

// ============================================================================
// FALLBACK RENDERING
// ============================================================================

/**
 * Render custom HTML fallback into shadow DOM
 * @param {Element} el - DzComponent element
 * @param {string} html - Custom HTML string
 */
function renderCustomFallback(el, html) {
	el.shadowRoot.innerHTML = html;
}

/**
 * Render built-in error fallback into shadow DOM.
 * Uses event delegation on the shadow root (set up once per element)
 * so there's no need to re-wire listeners after each innerHTML replace.
 *
 * @param {Element} el - DzComponent element
 * @param {Object} errorInfo - Error info object
 */
function renderBuiltInFallback(el, errorInfo) {
	const state = componentErrorState.get(el);
	const attempts = state ? state.recoveryAttempts : 0;
	const maxAttempts = errorConfig.maxRecoveryAttempts;
	const canRetry = attempts < maxAttempts;

	// Set up delegated click listener once — survives innerHTML changes
	if (!el._dz_retryDelegate) {
		el._dz_retryDelegate = (e) => {
			if (e.target.closest('[data-dz-retry]') && e.isTrusted) {
				attemptRecovery(el);
			}
		};
		el.shadowRoot.addEventListener('click', el._dz_retryDelegate);
	} else if (!el.shadowRoot) {
		// Element was remounted — re-attach listener to new shadowRoot
		el._dz_retryDelegate = null;
	}

	el.shadowRoot.innerHTML = renderError(errorInfo, canRetry, maxAttempts - attempts);
}

// ============================================================================
// RECOVERY
// ============================================================================

/**
 * Attempt to recover a component by unmounting and remounting.
 * Max 3 attempts before giving up.
 * @param {Element} el - DzComponent element
 */
function attemptRecovery(el) {
	const state = componentErrorState.get(el);
	if (!state) return;

	if (state.recoveryAttempts >= errorConfig.maxRecoveryAttempts) {
		logger.warn(`Recovery failed for '${state.errorInfo.type}' — max attempts reached`);
		return;
	}

	// Increment attempts
	state.recoveryAttempts++;

	const type = state.errorInfo.type;
	logger.info(`Recovery attempt ${state.recoveryAttempts}/3 for '${type}'`);

	// Clear error state (but keep attempts count in closure)
	const attempts = state.recoveryAttempts;
	componentErrorState.set(el, {
		hasError: false,
		errorInfo: null,
		recoveryAttempts: attempts
	});

	// Unmount current state (safe — already in error state)
	el.unmount();

	// Reset flags so loadComponent will proceed
	el._loading = null;
	el._mountError = false;

	// Attempt remount
	el.loadComponent(type);
}
