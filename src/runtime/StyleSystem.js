/**
 * StyleSystem.js - Style Injection for Shadow DOM Components
 *
 * Handles injecting CSS into Shadow DOM with proper cascade ordering.
 * All CSS parsing, filtering, and slot splitting is done at compile time.
 * The runtime only handles string injection and ordering.
 *
 * Cascade order (first → last, last wins):
 *   1. Slot styles (parent CSS for projected content)
 *   2. Cascaded route styles (inherited from parent routes)
 *   3. Component's own styles (highest precedence)
 */

// ── Global stylesheets ───────────────────────────────────────────────────────
// Shared CSSStyleSheets adopted into EVERY component's shadow root. A global
// stylesheet doesn't cross shadow boundaries on its own, so register it here
// (via Deezul.addGlobalStyles) and each component adopts the same sheet object —
// one sheet shared across all shadow roots, no per-component duplication, and
// it covers runtime-applied classes (unlike compile-time usage extraction).
const globalSheets = [];

/**
 * Register a global stylesheet applied to all component shadow roots.
 * Accepts a CSS string or an existing CSSStyleSheet. Returns the sheet so the
 * caller can later mutate it (e.g. sheet.replaceSync) and have every adopting
 * shadow root update live.
 * @param {string|CSSStyleSheet} css
 * @returns {CSSStyleSheet}
 */
export function addGlobalStyles(css) {
	let sheet = css;
	if (!(css instanceof CSSStyleSheet)) {
		sheet = new CSSStyleSheet();
		sheet.replaceSync(String(css));
	}
	if (!globalSheets.includes(sheet)) globalSheets.push(sheet);
	return sheet;
}

/**
 * Adopt all registered global stylesheets into a shadow root. Adopted sheets
 * sit below the shadow tree's own <style> elements in the cascade, so a
 * component's scoped styles still win on conflicts.
 * @param {ShadowRoot} shadowRoot
 */
export function adoptGlobalStyles(shadowRoot) {
	if (!globalSheets.length || !shadowRoot) return;
	const existing = shadowRoot.adoptedStyleSheets || [];
	const missing = globalSheets.filter(s => !existing.includes(s));
	if (missing.length) shadowRoot.adoptedStyleSheets = [...existing, ...missing];
}

/**
 * Create and append a <style> element to a shadow root.
 * @param {ShadowRoot} shadowRoot
 * @param {string} css
 */
function appendStyle(shadowRoot, css) {
	const el = document.createElement('style');
	el.textContent = css;
	shadowRoot.appendChild(el);
}

/**
 * Inject styles into a shadow root in the correct cascade order.
 * Slot styles first (lowest precedence), component styles last (highest).
 *
 * @param {ShadowRoot} shadowRoot - Target shadow root
 * @param {string|null} slotStyles - Pre-decoded slot CSS from parent (future)
 * @param {string|null} cascadedStyles - Route-inherited CSS
 * @param {string|null} componentStyles - Component's own CSS
 */
export function renderStylesIntoShadow(shadowRoot, slotStyles, cascadedStyles, componentStyles) {
	if (!slotStyles && !cascadedStyles && !componentStyles) return;

	if (slotStyles) appendStyle(shadowRoot, slotStyles);
	if (cascadedStyles) appendStyle(shadowRoot, cascadedStyles);
	if (componentStyles) appendStyle(shadowRoot, componentStyles);
}

/**
 * Decode compiled slot styles bytecode into a map of slot name → CSS string.
 * Format: { rules: string[], names: string[], code: Uint16Array }
 * Bytecode: [slotNameIndex, ruleCount, ...ruleIndices, ...]
 *
 * @param {Object|null} slotStylesDef - Compiled slotStyles definition
 * @returns {Object|null} Map of { slotName: cssString } or null
 */
export function decodeSlotStyles(slotStylesDef) {
	if (!slotStylesDef) return null;

	const { rules, names, code } = slotStylesDef;
	if (!code || code.length === 0) return null;

	const result = {};
	let i = 0;

	while (i < code.length) {
		const slotName = names[code[i++]];
		const count = code[i++];
		const parts = [];
		for (let j = 0; j < count; j++) {
			parts.push(rules[code[i++]]);
		}
		result[slotName] = parts.join('\n');
	}

	return result;
}

/**
 * Inject a single slot's styles into a child component's shadow root.
 * Prepends before existing styles so child's own styles win on conflicts.
 *
 * @param {ShadowRoot} childShadowRoot - Child component's shadow root
 * @param {string} slotName - Slot name to look up
 * @param {Object} decodedSlotStyles - Map from decodeSlotStyles()
 * @returns {boolean} Whether styles were injected
 */
export function injectSlotStyles(childShadowRoot, slotName, decodedSlotStyles) {
	if (!decodedSlotStyles) return false;

	const css = decodedSlotStyles[slotName];
	if (!css) return false;

	const el = document.createElement('style');
	el.textContent = css;

	// Prepend: insert before first child so component styles (appended later) win
	childShadowRoot.insertBefore(el, childShadowRoot.firstChild);
	return true;
}

export default { renderStylesIntoShadow, decodeSlotStyles, injectSlotStyles, addGlobalStyles, adoptGlobalStyles };
