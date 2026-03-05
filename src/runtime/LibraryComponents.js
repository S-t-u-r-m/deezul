/**
 * LibraryComponents.js - Built-in Deezul Library Components
 *
 * Provides styled HTML templates for framework-level UI:
 *   dz:error   — Error display with retry button
 *   dz:loading — Loading indicator with spinner
 *
 * These are template generators, not full reactive components.
 * They inject HTML + <style> into shadow roots.
 */

/**
 * Escape HTML for safe insertion
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
	return String(str)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

// ============================================================================
// dz:error — Error display with retry
// ============================================================================

const ERROR_STYLE = `
.dz-error { padding: 16px; border: 2px solid #e74c3c; border-radius: 8px; background: #fdf2f2; font-family: system-ui, sans-serif; color: #333; }
.dz-error h3 { margin: 0 0 8px; color: #c0392b; font-size: 16px; }
.dz-error p { margin: 0 0 4px; font-size: 14px; }
.dz-error .dz-error-msg { color: #e74c3c; margin-bottom: 12px; }
.dz-error button { padding: 6px 14px; background: #3498db; color: #fff; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; }
.dz-error button:hover { background: #2980b9; }
.dz-error .dz-error-exhausted { margin: 0; color: #999; font-size: 13px; }
`;

/**
 * Render error fallback HTML with embedded styles
 * @param {Object} errorInfo - { type, phase, message }
 * @param {boolean} canRetry - Whether retry is available
 * @param {number} attemptsLeft - Number of retry attempts remaining
 * @returns {string} HTML string with <style> + markup
 */
export function renderError(errorInfo, canRetry, attemptsLeft) {
	return `<style>${ERROR_STYLE}</style>
<div class="dz-error">
	<h3>Component Error</h3>
	<p><strong>Component:</strong> ${escapeHtml(errorInfo.type)}</p>
	<p><strong>Phase:</strong> ${escapeHtml(errorInfo.phase)}</p>
	<p class="dz-error-msg"><strong>Error:</strong> ${escapeHtml(errorInfo.message)}</p>
	${canRetry
		? `<button data-dz-retry>Retry (${attemptsLeft} left)</button>`
		: `<p class="dz-error-exhausted">Max recovery attempts reached.</p>`
	}
</div>`;
}

// ============================================================================
// dz:loading — Loading indicator with spinner
// ============================================================================

const LOADING_STYLE = `
.dz-loading { display: flex; align-items: center; gap: 10px; padding: 16px; font-family: system-ui, sans-serif; color: #666; font-size: 14px; }
.dz-spinner { width: 20px; height: 20px; border: 2px solid #e0e0e0; border-top-color: #3498db; border-radius: 50%; animation: dz-spin 0.6s linear infinite; }
@keyframes dz-spin { to { transform: rotate(360deg); } }
`;

/**
 * Render loading indicator HTML with embedded styles
 * @param {string} type - Component type name being loaded
 * @returns {string} HTML string with <style> + markup
 */
export function renderLoading(type) {
	return `<style>${LOADING_STYLE}</style>
<div class="dz-loading">
	<div class="dz-spinner"></div>
	<span>Loading ${escapeHtml(type)}\u2026</span>
</div>`;
}

// ============================================================================
// dz-404 — Not Found page component (precompiled)
// ============================================================================

const dz404 = {
	template: '<div class="dz-404"><h1>404</h1><h2>Page Not Found</h2><p>The path <code>\u200B</code> could not be found.</p><a href="/">\u200B</a></div>',

	binding: {
		strings: ["path", "href", "backPath", "backLabel"],
		code: new Uint16Array([
			// TEXT: path → code text node at [2,1,0]
			1, 3, 2, 1, 0, 0,
			// ATTR: href=backPath on <a> at [3]
			3, 1, 3, 1, 2,
			// TEXT: backLabel → <a> text node at [3,0]
			1, 2, 3, 0, 3
		])
	},

	eval: [],
	event: [],
	dynamics: [],

	style: `.dz-404 {
	text-align: center;
	padding: 60px 20px;
	font-family: system-ui, -apple-system, sans-serif;
}
.dz-404 h1 {
	font-size: 72px;
	margin: 0;
	color: #e74c3c;
}
.dz-404 h2 {
	font-size: 24px;
	color: #333;
	margin: 10px 0 20px;
}
.dz-404 p {
	color: #666;
	margin-bottom: 30px;
}
.dz-404 code {
	background: #f0f0f0;
	padding: 2px 8px;
	border-radius: 4px;
	font-size: 14px;
}
.dz-404 a {
	display: inline-block;
	padding: 10px 24px;
	background: #3498db;
	color: white;
	text-decoration: none;
	border-radius: 6px;
}
.dz-404 a:hover {
	background: #2980b9;
}`
};

dz404.data = () => ({
	path: 'unknown',
	backPath: '/',
	backLabel: 'Go Home'
});

dz404.$created = function () {
	if (this.$route) {
		this.path = this.$route.params.path || this.$route.path || 'unknown';
		this.backPath = this.$route.params.backPath || '/';
	}
	this.backLabel = this.backPath === '/' ? 'Go Home' : 'Go Back';
};

export { dz404 };

// ============================================================================
// Reserved prefix check
// ============================================================================

/**
 * Check if a component ref uses the reserved 'dz:' prefix
 * @param {string} ref - Component reference name
 * @returns {boolean}
 */
export function isReservedPrefix(ref) {
	return ref.startsWith('dz:');
}
