/**
 * Logger.js - Advanced Logger
 *
 * Configurable log levels, namespaced loggers, stack traces,
 * error context tracking, and type validation.
 *
 * Usage:
 *   import { createLogger, setLogLevel, LOG_LEVEL } from './Logger.js';
 *   setLogLevel(LOG_LEVEL.DEBUG); // Enable debug output globally
 *   const logger = createLogger('MyModule');
 *   logger.debug('working', { key: 'value' });
 */

// ============================================================================
// LOG LEVELS
// ============================================================================

export const LOG_LEVEL = {
	NONE: 0,
	ERROR: 1,
	WARN: 2,
	INFO: 3,
	DEBUG: 4,
	TRACE: 5
};

const LEVEL_NAMES = ['NONE', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'];

// ============================================================================
// GLOBAL STATE
// ============================================================================

let globalLevel = LOG_LEVEL.WARN;
const moduleOverrides = new Map();

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * Set the global log level.
 * @param {number|string} level - LOG_LEVEL constant or name string
 */
export function setLogLevel(level) {
	globalLevel = resolveLevel(level);
}

/**
 * Get the current global log level.
 * @returns {number}
 */
export function getLogLevel() {
	return globalLevel;
}

/**
 * Override log level for a specific module.
 * @param {string} moduleName - Module namespace
 * @param {number|string} level - LOG_LEVEL constant or name string
 */
export function setModuleLogLevel(moduleName, level) {
	if (typeof moduleName !== 'string') return;
	moduleOverrides.set(moduleName, resolveLevel(level));
}

/**
 * Clear a module-level override (reverts to global level).
 * @param {string} moduleName
 */
export function clearModuleLogLevel(moduleName) {
	moduleOverrides.delete(moduleName);
}

/**
 * Resolve a level value from number or string.
 * @param {number|string} level
 * @returns {number}
 */
function resolveLevel(level) {
	if (typeof level === 'string') {
		const resolved = LOG_LEVEL[level.toUpperCase()];
		if (resolved !== undefined) return resolved;
	}
	if (typeof level === 'number' && level >= 0 && level <= 5) return level;
	return globalLevel;
}

/**
 * Get effective level for a module.
 * @param {string} moduleName
 * @returns {number}
 */
function getEffectiveLevel(moduleName) {
	const override = moduleOverrides.get(moduleName);
	return override !== undefined ? override : globalLevel;
}

// ============================================================================
// CORE LOGGING
// ============================================================================

/**
 * Log a message at a given level.
 * @param {string} module - Module namespace
 * @param {number} level - LOG_LEVEL constant
 * @param {string} message - Log message
 * @param {*} [data] - Optional data payload
 */
export function log(module, level, message, data = null) {
	if (level > getEffectiveLevel(module)) return;

	const prefix = `[${module}]`;
	const args = data !== null ? [prefix, message, data] : [prefix, message];

	switch (level) {
		case LOG_LEVEL.ERROR: console.error(...args); break;
		case LOG_LEVEL.WARN:  console.warn(...args); break;
		case LOG_LEVEL.INFO:  console.info(...args); break;
		case LOG_LEVEL.DEBUG: console.debug(...args); break;
		case LOG_LEVEL.TRACE: console.debug(...args); break;
	}
}

/**
 * Log an error with optional Error object and context.
 * Includes stack trace when an Error is provided.
 * @param {string} module - Module namespace
 * @param {string} message - Error description
 * @param {Error|null} [error] - Error object
 * @param {*} [context] - Additional context
 */
export function logError(module, message, error = null, context = null) {
	if (LOG_LEVEL.ERROR > getEffectiveLevel(module)) return;

	const prefix = `[${module}]`;
	console.error(prefix, message);
	if (context !== null) console.error(prefix, 'Context:', context);
	if (error) {
		console.error(prefix, 'Error:', error.message || error);
		if (error.stack) console.error(prefix, 'Stack:', error.stack);
	}
}

// ============================================================================
// NAMESPACED LOGGER FACTORY
// ============================================================================

/**
 * Create a namespaced logger instance.
 * @param {string} moduleName - Namespace for all log output
 * @returns {object} Logger with error, warn, info, debug, trace methods
 */
export function createLogger(moduleName) {
	if (typeof moduleName !== 'string' || !moduleName) {
		moduleName = 'Unknown';
	}

	return {
		error: (message, error = null, context = null) => logError(moduleName, message, error, context),
		warn:  (message, data = null) => log(moduleName, LOG_LEVEL.WARN, message, data),
		info:  (message, data = null) => log(moduleName, LOG_LEVEL.INFO, message, data),
		debug: (message, data = null) => log(moduleName, LOG_LEVEL.DEBUG, message, data),
		trace: (message, data = null) => log(moduleName, LOG_LEVEL.TRACE, message, data)
	};
}

export default { LOG_LEVEL, log, logError, createLogger, setLogLevel, getLogLevel, setModuleLogLevel, clearModuleLogLevel };
