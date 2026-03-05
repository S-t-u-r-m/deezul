/**
 * Configuration.js - Centralized Framework Configuration
 *
 * Default configuration for logging, error handling, framework behavior,
 * and directives. Call configure() to apply overrides — Deezul.init()
 * does this automatically when config sections are provided.
 *
 * Usage:
 *   import { configure, getConfig } from './Configuration.js';
 *
 *   // Apply overrides
 *   configure({
 *       logging: { level: 'DEBUG', modules: { Router: 'TRACE' } },
 *       errors: { maxRecoveryAttempts: 5 }
 *   });
 *
 *   // Or via Deezul.init:
 *   Deezul.init({
 *       rootElement: 'app',
 *       logging: { level: 'DEBUG' },
 *       ...
 *   });
 */

import { setLogLevel, setModuleLogLevel, LOG_LEVEL } from './Logger.js';

// ============================================================================
// DIRECTIVE CONFIGURATION
// ============================================================================

export const directives = {
	bind: ':',       // Property binding prefix (:class, :style, :for, :if)
	event: '@',      // Event binding prefix (@click, @input)
	reserved: ['for', 'if', 'else-if', 'else', 'bind', 'ref', 'model', 'slot']
};

// ============================================================================
// LOGGING CONFIGURATION
// ============================================================================

export const logging = {
	level: 'WARN',   // Global log level (NONE, ERROR, WARN, INFO, DEBUG, TRACE)
	modules: {}      // Per-module overrides: { Router: 'DEBUG', Reactivity: 'TRACE' }
};

// ============================================================================
// ERROR HANDLING CONFIGURATION
// ============================================================================

export const errors = {
	logToConsole: true,        // Log errors to console
	showStackTrace: true,      // Include stack traces in error output
	maxRecoveryAttempts: 3     // Max retry attempts for component recovery
};

// ============================================================================
// FRAMEWORK DEFAULTS
// ============================================================================

export const framework = {
	rootElement: 'app'         // Default root element ID
};

// ============================================================================
// CONFIGURATION API
// ============================================================================

/**
 * Apply configuration overrides.
 * Merges provided config into defaults and wires changes to Logger.
 *
 * @param {Object} config - Configuration overrides
 * @param {Object} [config.logging] - Logging overrides
 * @param {string|number} [config.logging.level] - Global log level
 * @param {Object} [config.logging.modules] - Per-module log levels
 * @param {Object} [config.errors] - Error handling overrides
 * @param {boolean} [config.errors.logToConsole] - Log errors to console
 * @param {boolean} [config.errors.showStackTrace] - Show stack traces
 * @param {number} [config.errors.maxRecoveryAttempts] - Max recovery attempts
 * @param {Object} [config.directives] - Directive prefix overrides
 * @param {string} [config.directives.bind] - Bind prefix (default ':')
 * @param {string} [config.directives.event] - Event prefix (default '@')
 * @param {Object} [config.framework] - Framework defaults
 * @param {string} [config.framework.rootElement] - Root element ID
 */
export function configure(config = {}) {
	if (config.logging) {
		if (config.logging.level !== undefined) {
			logging.level = config.logging.level;
			setLogLevel(config.logging.level);
		}
		if (config.logging.modules) {
			Object.assign(logging.modules, config.logging.modules);
			const modEntries = Object.entries(config.logging.modules);
			for (let i = 0, len = modEntries.length; i < len; i++) {
				setModuleLogLevel(modEntries[i][0], modEntries[i][1]);
			}
		}
	}

	if (config.errors) {
		if (config.errors.logToConsole !== undefined) errors.logToConsole = config.errors.logToConsole;
		if (config.errors.showStackTrace !== undefined) errors.showStackTrace = config.errors.showStackTrace;
		if (config.errors.maxRecoveryAttempts !== undefined) errors.maxRecoveryAttempts = config.errors.maxRecoveryAttempts;
	}

	if (config.directives) {
		if (config.directives.bind) directives.bind = config.directives.bind;
		if (config.directives.event) directives.event = config.directives.event;
	}

	if (config.framework) {
		if (config.framework.rootElement !== undefined) framework.rootElement = config.framework.rootElement;
	}
}

/**
 * Get a snapshot of the current configuration.
 * Returns a new object (not a reference to the internal state).
 *
 * @returns {Object} Current configuration snapshot
 */
export function getConfig() {
	return {
		directives: { ...directives, reserved: [...directives.reserved] },
		logging: { level: logging.level, modules: { ...logging.modules } },
		errors: { ...errors },
		framework: { ...framework }
	};
}

export default { directives, logging, errors, framework, configure, getConfig };
