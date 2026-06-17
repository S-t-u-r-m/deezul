/**
 * constants.js - Framework Constants & Shared Binding Utilities
 *
 * Central location for constants shared across DzComponent.js and render.js
 * to avoid duplication and provide a single source of truth.
 */

// ============================================================================
// Binding Type Constants (must match compiler output)
// ============================================================================

export const BindingType = {
	TEXT: 1,
	TEXT_EVAL: 2,
	ATTR: 3,
	ATTR_EVAL: 4,
	TWO_WAY: 5,
	EVENT: 6,
	PROP: 7,
	PROP_SYNC: 8
};

// ============================================================================
// Shared Binding Apply Functions
// ============================================================================

// Defined once, shared across all bindings of each type (avoids per-binding closure allocation)
export function applyText(value, b) { b.node.textContent = value; }
export function resolveDottedPath(obj, path) {
    if (!path || path.indexOf('.') === -1) return obj ? obj[path] : undefined;
    const parts = path.split('.');
    let v = obj;
    for (let i = 0; i < parts.length && v != null; i++) v = v[parts[i]];
    return v;
}
export function setAttrMerged(node, attr, value) {
    if (attr === 'class') {
        if (node._staticClass === undefined) {
            node._staticClass = node.getAttribute('class') || '';
        }
        const dyn = value == null || value === false ? '' : String(value);
        const full = node._staticClass + (dyn && node._staticClass ? ' ' : '') + dyn;
        // Skip writing class="" — the common case for a conditional :class that
        // resolves to nothing (e.g. every non-selected row in a large list).
        // removeAttribute is a no-op on a fresh node and correctly clears a
        // previously-set class on update.
        if (full) node.setAttribute('class', full);
        else node.removeAttribute('class');
    } else {
        node.setAttribute(attr, value);
    }
}
export function applyAttr(value, b) { setAttrMerged(b.node, b.attributeName, value); }
export function applyBoolAttr(value, b) {
    if (value) b.node.setAttribute(b.attributeName, '');
    else b.node.removeAttribute(b.attributeName);
}

// ============================================================================
// Two-Way Input Value Access
// ============================================================================

/**
 * Write a model value into a form control, respecting the control type:
 * checkboxes/radios use `checked`, everything else uses `value`.
 */
export function setInputValue(node, value) {
    const type = node.type;
    if (type === 'checkbox') {
        node.checked = !!value;
    } else if (type === 'radio') {
        node.checked = value != null && node.value === String(value);
    } else {
        node.value = value == null ? '' : value;
    }
}

/**
 * Read the model value out of a form control, respecting the control type:
 * checkboxes report `checked`, number/range inputs coerce to Number
 * (falling back to the raw string when the field isn't a valid number).
 */
export function readInputValue(node) {
    const type = node.type;
    if (type === 'checkbox') return node.checked;
    if (type === 'number' || type === 'range') {
        if (node.value === '') return '';
        const n = node.valueAsNumber;
        return Number.isNaN(n) ? node.value : n;
    }
    return node.value;
}

export function applyValue(value, b) { setInputValue(b.node, value); }

// ============================================================================
// Path-Based Node Access
// ============================================================================

/**
 * Navigate to a node using a tree path.
 * Returns null when the path runs off the tree (stale path / changed DOM)
 * so callers can skip the binding instead of crashing mid-walk.
 * @param {Node} root - Root node to start from
 * @param {number[]} path - Array of childNodes indices
 * @returns {Node|null} Target node
 */
export function getNodeByPath(root, path) {
	let node = root;
	for (let i = 0, len = path.length; i < len && node; i++) {
		node = node.childNodes[path[i]];
	}
	return node || null;
}

// ============================================================================
// Bytecode Data Length
// ============================================================================

/**
 * Get base data length for a binding type (excluding variable-length deps)
 * @param {number} type - BindingType value
 * @returns {number}
 */
export function getBindingDataLength(type) {
	switch (type) {
		case BindingType.ATTR:
		case BindingType.ATTR_EVAL:
		case BindingType.EVENT:
		case BindingType.PROP:
		case BindingType.PROP_SYNC:
		case BindingType.TWO_WAY:
			return 2;
		default:
			return 1;
	}
}
