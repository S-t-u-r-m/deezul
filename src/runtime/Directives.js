/**
 * Directives.js - Custom Directive System
 *
 * Runtime detection of custom directives within ATTR/ATTR_EVAL bindings.
 * No compiler changes needed — the compiler already emits ATTR/ATTR_EVAL for
 * :name bindings and EVENT for @name events. At runtime, we check if the
 * attribute/event name is a registered directive.
 *
 * Directive lifecycle: created → mounted (deferred) → updated → unmounted
 */

import { createLogger } from './Logger.js';

const logger = createLogger('Directives');

// ============================================================================
// DIRECTIVE REGISTRY
// ============================================================================

const directiveRegistry = new Map();

// Reserved names that cannot be used as directives
const RESERVED_NAMES = new Set([
	'for', 'if', 'else-if', 'else', 'bind', 'ref', 'model', 'slot'
]);

/**
 * Register a custom directive
 * @param {string} name - Directive name (e.g., 'focus', 'tooltip')
 * @param {Object} definition - Directive hooks
 * @param {Function} [definition.created] - After element created, before mounted
 * @param {Function} [definition.mounted] - After element inserted into DOM
 * @param {Function} [definition.updated] - When bound value changes
 * @param {Function} [definition.unmounted] - Before element removed
 */
export function registerDirective(name, definition) {
	if (!name || typeof name !== 'string') {
		logger.error('registerDirective: name must be a non-empty string');
		return;
	}

	if (RESERVED_NAMES.has(name)) {
		logger.error(`registerDirective: '${name}' is a reserved name`);
		return;
	}

	if (!definition || typeof definition !== 'object') {
		logger.error('registerDirective: definition must be an object');
		return;
	}

	// Must have at least one lifecycle hook
	const hasHook = definition.created || definition.mounted ||
	                definition.updated || definition.unmounted;
	if (!hasHook) {
		logger.error(`registerDirective: '${name}' must define at least one lifecycle hook`);
		return;
	}

	directiveRegistry.set(name, definition);
}

/**
 * Unregister a custom directive
 * @param {string} name - Directive name
 */
export function unregisterDirective(name) {
	directiveRegistry.delete(name);
}

/**
 * Get a directive definition
 * @param {string} name - Directive name
 * @returns {Object|undefined}
 */
export function getDirective(name) {
	return directiveRegistry.get(name);
}

/**
 * Get all registered directive names
 * @returns {string[]}
 */
export function getDirectiveNames() {
	return [...directiveRegistry.keys()];
}

// ============================================================================
// MODIFIER PARSER
// ============================================================================

/**
 * Parse a directive name that may include dot modifiers.
 * Returns null if the base name is not a registered directive.
 *
 * "focus"             → { name: "focus", modifiers: {} }
 * "focus.lazy"        → { name: "focus", modifiers: { lazy: true } }
 * "tooltip.top.anim"  → { name: "tooltip", modifiers: { top: true, anim: true } }
 *
 * @param {string} fullName - Attribute name possibly with dot modifiers
 * @returns {{ name: string, modifiers: Object }|null}
 */
export function parseDirectiveName(fullName) {
	// Fast path: exact match, no dots
	if (directiveRegistry.has(fullName)) {
		return { name: fullName, modifiers: {} };
	}

	// Check for dot modifiers
	const dotIndex = fullName.indexOf('.');
	if (dotIndex === -1) return null;

	const baseName = fullName.substring(0, dotIndex);
	if (!directiveRegistry.has(baseName)) return null;

	const modifiers = {};
	const parts = fullName.substring(dotIndex + 1).split('.');
	for (let i = 0, len = parts.length; i < len; i++) {
		if (parts[i]) modifiers[parts[i]] = true;
	}

	return { name: baseName, modifiers };
}

// ============================================================================
// ELEMENT CLEANUP TRACKER
// ============================================================================

/**
 * Per-element cleanup tracking (WeakMap for GC).
 * Tracks event listeners, timeouts, intervals, and custom cleanup functions
 * added by directives. All cleaned up automatically on unmount.
 */
const elementCleanupMap = new WeakMap();

/**
 * Get or create a cleanup tracker for an element
 * @param {Element} el - DOM element
 * @returns {{ events: Array, timeouts: Array, intervals: Array, fns: Array }}
 */
function getCleanupTracker(el) {
	let tracker = elementCleanupMap.get(el);
	if (!tracker) {
		tracker = { events: [], timeouts: [], intervals: [], fns: [] };
		elementCleanupMap.set(el, tracker);
	}
	return tracker;
}

/**
 * Run all cleanup for an element and remove the tracker
 * @param {Element} el - DOM element
 */
export function runElementCleanup(el) {
	const tracker = elementCleanupMap.get(el);
	if (!tracker) return;

	// Remove event listeners
	for (let i = 0, len = tracker.events.length; i < len; i++) {
		const { target, event, handler, options } = tracker.events[i];
		target.removeEventListener(event, handler, options);
	}

	// Clear timeouts
	for (let i = 0, len = tracker.timeouts.length; i < len; i++) {
		clearTimeout(tracker.timeouts[i]);
	}

	// Clear intervals
	for (let i = 0, len = tracker.intervals.length; i < len; i++) {
		clearInterval(tracker.intervals[i]);
	}

	// Run custom cleanup functions
	for (let i = 0, len = tracker.fns.length; i < len; i++) {
		try { tracker.fns[i](); } catch (e) {
			logger.warn('Cleanup function threw', e);
		}
	}

	elementCleanupMap.delete(el);
}

// ============================================================================
// DIRECTIVE BINDING CREATOR
// ============================================================================

/**
 * Create a directive binding object with DOM/timer/event helpers.
 * All helpers auto-track for cleanup on unmount.
 *
 * @param {Element} el - Target DOM element
 * @param {*} value - Current bound value
 * @param {Object} [options]
 * @param {*} [options.oldValue] - Previous value (for updated hook)
 * @param {Object} [options.modifiers] - Parsed modifiers { lazy: true, ... }
 * @returns {Object} Directive binding
 */
export function createDirectiveBinding(el, value, { oldValue, modifiers } = {}) {
	const tracker = getCleanupTracker(el);

	return {
		value,
		oldValue: oldValue !== undefined ? oldValue : undefined,
		modifiers: modifiers || {},

		// DOM helpers
		show() { el.style.display = ''; },
		hide() { el.style.display = 'none'; },
		toggle(condition) {
			el.style.display = (condition !== undefined ? condition : el.style.display === 'none') ? '' : 'none';
		},
		addClass(...classes) { el.classList.add(...classes); },
		removeClass(...classes) { el.classList.remove(...classes); },
		toggleClass(cls, force) { el.classList.toggle(cls, force); },
		setStyle(prop, val) { el.style[prop] = val; },
		setAttr(name, val) { el.setAttribute(name, val); },
		removeAttr(name) { el.removeAttribute(name); },

		// Event helper (auto-cleanup)
		onEvent(target, event, handler, options) {
			target.addEventListener(event, handler, options);
			tracker.events.push({ target, event, handler, options });
		},

		// Timer helpers (auto-cleanup)
		setTimeout(fn, delay) {
			const id = setTimeout(fn, delay);
			tracker.timeouts.push(id);
			return id;
		},
		setInterval(fn, interval) {
			const id = setInterval(fn, interval);
			tracker.intervals.push(id);
			return id;
		},

		// Custom cleanup registration
		onCleanup(fn) {
			tracker.fns.push(fn);
		}
	};
}

// ============================================================================
// HOOK EXECUTOR
// ============================================================================

/**
 * Safely call a directive lifecycle hook
 * @param {string} hookName - 'created', 'mounted', 'updated', 'unmounted'
 * @param {Object} directive - Directive definition
 * @param {Element} el - Target DOM element
 * @param {Object} binding - Directive binding object
 */
export function callDirectiveHook(hookName, directive, el, binding) {
	const hook = directive[hookName];
	if (!hook) return;

	try {
		hook(el, binding);
	} catch (e) {
		logger.error(`Directive hook '${hookName}' threw`, e, {
			element: el.tagName
		});
	}
}
