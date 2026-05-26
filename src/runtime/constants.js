/**
 * constants.js - Framework Constants & Shared Binding Utilities
 *
 * Central location for constants shared across DzComponent.js and render.js
 * to avoid duplication and provide a single source of truth.
 */

// ============================================================================
// JavaScript typeof Result Constants
// ============================================================================

export const TYPEOF = Object.freeze({
	OBJECT: 'object',
	FUNCTION: 'function',
	STRING: 'string',
	NUMBER: 'number',
	BOOLEAN: 'boolean',
	SYMBOL: 'symbol',
	UNDEFINED: 'undefined'
});

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
        node.setAttribute('class', node._staticClass + (dyn && node._staticClass ? ' ' : '') + dyn);
    } else {
        node.setAttribute(attr, value);
    }
}
export function applyAttr(value, b) { setAttrMerged(b.node, b.attributeName, value); }
export function applyBoolAttr(value, b) {
    if (value) b.node.setAttribute(b.attributeName, '');
    else b.node.removeAttribute(b.attributeName);
}
export function applyValue(value, b) { b.node.value = value; }

// ============================================================================
// Path-Based Node Access
// ============================================================================

/**
 * Navigate to a node using a tree path
 * @param {Node} root - Root node to start from
 * @param {number[]} path - Array of childNodes indices
 * @returns {Node} Target node
 */
export function getNodeByPath(root, path) {
	let node = root;
	for (let i = 0, len = path.length; i < len; i++) {
		node = node.childNodes[path[i]];
	}
	return node;
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
