/**
 * render.js - DOM Rendering Runtime
 *
 * Handles all DOM manipulation for Deezul components:
 * - Initial rendering of templates
 * - :for loop rendering and surgical updates
 * - :if conditional rendering
 * - Binding application
 *
 * Architecture:
 *   Reactivity.js (detects changes, decides what to call)
 *       ↓
 *   render.js (performs actual DOM updates)
 *       ↓
 *   DOM
 */

import { setRenderUpdates, addArrayForLoop, addBinding, addDynamicStructure } from './Reactivity.js';
import { parseDirectiveName, getDirective, createDirectiveBinding, callDirectiveHook, runElementCleanup } from './Directives.js';
import { BindingType, getNodeByPath, getBindingDataLength, applyText, applyAttr, applyBoolAttr, applyValue } from './constants.js';
import { createLogger } from './Logger.js';

const logger = createLogger('Render');

// JS reserved words/literals to exclude when extracting identifiers from condition expressions
const JS_RESERVED = new Set(['true', 'false', 'null', 'undefined', 'typeof', 'instanceof', 'new', 'this']);

/**
 * Resolve a property value in a :for loop iteration context.
 * Returns the iterator item, index, or parent proxy value depending on the property name.
 */
function resolveIterationValue(prop, iteratorVar, item, indexVar, index, parentProxy) {
    if (prop === iteratorVar) return item;
    if (prop === indexVar) return index;
    return parentProxy[prop];
}

// ============================================================================
// EVENT ARGUMENT RESOLUTION
// ============================================================================

/**
 * Resolve an event handler argument from scope
 * Handles: scope variables, $event, string literals, numbers, booleans, null/undefined
 * @param {string} arg - Argument string from compiled event config
 * @param {Object} scope - Scope proxy (iteration scope or component proxy)
 * @param {Event} event - DOM event object
 * @returns {*} Resolved value
 */
function resolveEventArg(arg, scope, event) {
    if (arg === '$event') return event;
    // String literal (single or double quotes)
    if ((arg.startsWith("'") && arg.endsWith("'")) || (arg.startsWith('"') && arg.endsWith('"'))) {
        return arg.slice(1, -1);
    }
    // Boolean/null/undefined literals
    if (arg === 'true') return true;
    if (arg === 'false') return false;
    if (arg === 'null') return null;
    if (arg === 'undefined') return undefined;
    // Number literal
    if (arg !== '' && !isNaN(arg)) return Number(arg);
    // Scope property lookup
    return scope[arg];
}

/**
 * Attach an event listener from a compiled event config
 * @param {Node} node - DOM node to attach listener to
 * @param {Array|Object} eventConfig - Compiled event config
 * @param {Object} scope - Scope proxy for resolving values and methods
 */
function attachEvent(node, eventConfig, scope) {
    if (Array.isArray(eventConfig)) {
        // METHOD or CALL format: [eventName, methodName, ...args]
        const [eventName, methodName, ...argNames] = eventConfig;
        if (argNames.length === 0) {
            // METHOD: simple method reference, pass event as arg
            node.addEventListener(eventName, (e) => {
                try { scope[methodName](e); }
                catch (err) { logger.error(`Error in event handler ${methodName}`, err); }
            });
        } else {
            // CALL: resolve args from scope
            node.addEventListener(eventName, (e) => {
                try {
                    const args = new Array(argNames.length);
                    for (let i = 0; i < argNames.length; i++) args[i] = resolveEventArg(argNames[i], scope, e);
                    scope[methodName](...args);
                } catch (err) { logger.error(`Error in event handler ${methodName}`, err); }
            });
        }
    } else if (eventConfig && eventConfig.event) {
        // INLINE format: { event, eval }
        node.addEventListener(eventConfig.event, (e) => {
            try { eventConfig.eval.call(scope, e); }
            catch (err) { logger.error('Error in inline event handler', err); }
        });
    }
}

// ============================================================================
// FOR LOOP INSTANCE
// ============================================================================

/**
 * Represents a single rendered item in a :for loop
 * @typedef {Object} ForLoopInstance
 * @property {*} item - The data item
 * @property {number} index - Current index
 * @property {Node[]} nodes - Root-level DOM nodes for this item
 * @property {Object[]} bindings - Active bindings for this instance
 */

// ============================================================================
// FOR LOOP RENDERING
// ============================================================================

/**
 * Render a single :for loop instance
 *
 * No per-row Proxy. Iteration variables (item, index) are resolved by
 * index into the source collection. Event handlers close over the
 * instance so they always read the current index.
 *
 * @param {Object} structure - For loop structure
 * @param {*} item - Data item to render
 * @param {number} index - Item index
 * @param {Object} parentProxy - Parent component proxy
 * @returns {ForLoopInstance} Rendered instance
 */
function renderForLoopInstance(structure, item, index, parentProxy) {
    const iteratorVar = structure.iterator;
    const indexVar = structure.indexVar || 'index';

    // ── One-time setup: stamp + binding descriptors (first call only) ──
    if (!structure._stamp) {
        const stampContainer = document.createElement('div');
        stampContainer.innerHTML = structure.template;
        structure._stamp = stampContainer;
        structure._stampChildCount = stampContainer.childNodes.length;

        // Pre-resolve bytecode into binding descriptors
        const strings = structure.binding.strings;
        const bytecode = structure.binding.code;
        const evalFunctions = structure.eval || [];
        const descs = [];

        let offset = 0;
        while (offset < bytecode.length) {
            const type = bytecode[offset];
            const pathLen = bytecode[offset + 1];
            const path = new Array(pathLen);
            for (let i = 0; i < pathLen; i++) {
                path[i] = bytecode[offset + 2 + i];
            }
            const dataOffset = offset + 2 + pathLen;

            const desc = { type, path };

            switch (type) {
                case BindingType.TEXT:
                    desc.prop = strings[bytecode[dataOffset]];
                    desc.applyFn = applyText;
                    break;
                case BindingType.TEXT_EVAL:
                    desc.evalFn = evalFunctions[bytecode[dataOffset]];
                    break;
                case BindingType.ATTR: {
                    desc.attr = strings[bytecode[dataOffset]];
                    desc.prop = strings[bytecode[dataOffset + 1]];
                    const attrParsed = parseDirectiveName(desc.attr);
                    if (attrParsed) {
                        desc.directiveParsed = attrParsed;
                        desc.directive = getDirective(attrParsed.name);
                    } else {
                        desc.applyFn = applyAttr;
                    }
                    break;
                }
                case BindingType.ATTR_EVAL: {
                    desc.attr = strings[bytecode[dataOffset]];
                    desc.evalFn = evalFunctions[bytecode[dataOffset + 1]];
                    const evalParsed = parseDirectiveName(desc.attr);
                    if (evalParsed) {
                        desc.directiveParsed = evalParsed;
                        desc.directive = getDirective(evalParsed.name);
                    }
                    break;
                }
                case BindingType.TWO_WAY:
                    desc.prop = strings[bytecode[dataOffset]];
                    desc.applyFn = applyValue;
                    break;
                case BindingType.EVENT:
                    desc.eventConfig = structure.event[bytecode[dataOffset + 1]];
                    break;
            }

            descs.push(desc);

            // EVAL types have variable-length deps: [evalIdx, depsLen, ...depIndices]
            if (type === BindingType.TEXT_EVAL) {
                offset += 2 + pathLen + 2 + bytecode[dataOffset + 1];
            } else if (type === BindingType.ATTR_EVAL) {
                offset += 2 + pathLen + 3 + bytecode[dataOffset + 2];
            } else {
                offset += 2 + pathLen + getBindingDataLength(type);
            }
        }

        structure._descs = descs;
    }

    // ── Per-row: clone + apply pre-resolved descriptors ──
    const container = structure._stamp.cloneNode(true);
    const root = container.firstElementChild || container.firstChild;

    const instance = { item, index, nodes: null, bindings: [], directiveInstances: null };
    const bindings = instance.bindings;
    const descs = structure._descs;
    let dirInsts = null;

    for (let d = 0; d < descs.length; d++) {
        const desc = descs[d];
        const bindNode = getNodeByPath(root, desc.path);
        if (!bindNode) continue;

        switch (desc.type) {
            case BindingType.TEXT: {
                const value = resolveIterationValue(desc.prop, iteratorVar, item, indexVar, index, parentProxy);
                bindNode.textContent = value;
                bindings.push({ node: bindNode, property: desc.prop, applyFn: desc.applyFn });
                break;
            }
            case BindingType.TEXT_EVAL:
                bindNode.textContent = desc.evalFn.call(parentProxy, item, index);
                break;
            case BindingType.ATTR: {
                if (desc.directiveParsed) {
                    const value = resolveIterationValue(desc.prop, iteratorVar, item, indexVar, index, parentProxy);
                    const dBinding = createDirectiveBinding(bindNode, value, { modifiers: desc.directiveParsed.modifiers });
                    callDirectiveHook('created', desc.directive, bindNode, dBinding);
                    callDirectiveHook('mounted', desc.directive, bindNode, dBinding);
                    if (!dirInsts) dirInsts = [];
                    dirInsts.push({ el: bindNode, directive: desc.directive, binding: dBinding });
                } else {
                    const value = resolveIterationValue(desc.prop, iteratorVar, item, indexVar, index, parentProxy);
                    const isBool = typeof value === 'boolean';
                    if (isBool) {
                        if (value) bindNode.setAttribute(desc.attr, '');
                        else bindNode.removeAttribute(desc.attr);
                    } else {
                        bindNode.setAttribute(desc.attr, value);
                    }
                    bindings.push({ node: bindNode, property: desc.prop, attributeName: desc.attr, applyFn: isBool ? applyBoolAttr : applyAttr });
                }
                break;
            }
            case BindingType.ATTR_EVAL: {
                if (desc.directiveParsed) {
                    const value = desc.evalFn.call(parentProxy, item, index);
                    const dBinding = createDirectiveBinding(bindNode, value, { modifiers: desc.directiveParsed.modifiers });
                    callDirectiveHook('created', desc.directive, bindNode, dBinding);
                    callDirectiveHook('mounted', desc.directive, bindNode, dBinding);
                    if (!dirInsts) dirInsts = [];
                    dirInsts.push({ el: bindNode, directive: desc.directive, binding: dBinding });
                } else {
                    const evalValue = desc.evalFn.call(parentProxy, item, index);
                    if (typeof evalValue === 'boolean') {
                        if (evalValue) bindNode.setAttribute(desc.attr, '');
                        else bindNode.removeAttribute(desc.attr);
                    } else {
                        bindNode.setAttribute(desc.attr, evalValue);
                    }
                }
                break;
            }
            case BindingType.TWO_WAY: {
                const prop = desc.prop;
                const value = resolveIterationValue(prop, iteratorVar, item, indexVar, index, parentProxy);
                bindNode.value = value;
                bindNode.addEventListener('input', (e) => {
                    if (prop !== iteratorVar && prop !== indexVar) {
                        parentProxy[prop] = e.target.value;
                    }
                });
                bindings.push({ node: bindNode, property: prop, applyFn: desc.applyFn });
                break;
            }
            case BindingType.EVENT: {
                const eventConfig = desc.eventConfig;
                if (!eventConfig) break;
                if (Array.isArray(eventConfig)) {
                    const [eventName, methodName, ...argNames] = eventConfig;
                    if (argNames.length === 0) {
                        bindNode.addEventListener(eventName, (e) => {
                            parentProxy[methodName](e);
                        });
                    } else {
                        bindNode.addEventListener(eventName, (e) => {
                            const args = new Array(argNames.length);
                            for (let i = 0; i < argNames.length; i++) {
                                const a = argNames[i];
                                if (a === iteratorVar) args[i] = parentProxy[structure.source][instance.index];
                                else if (a === indexVar) args[i] = instance.index;
                                else if (a === '$event') args[i] = e;
                                else args[i] = resolveEventArg(a, parentProxy, e);
                            }
                            parentProxy[methodName](...args);
                        });
                    }
                } else if (eventConfig.event) {
                    bindNode.addEventListener(eventConfig.event, (e) => {
                        eventConfig.eval.call(parentProxy, item, index, e);
                    });
                }
                break;
            }
        }
    }

    // Store directive instances for cleanup
    instance.directiveInstances = dirInsts;

    // Collect root-level nodes — manual iteration avoids Array.from allocation
    const childCount = structure._stampChildCount;
    if (childCount === 1) {
        instance.nodes = [root];
    } else {
        const nodes = new Array(childCount);
        let child = container.firstChild;
        for (let i = 0; i < childCount; i++) {
            nodes[i] = child;
            child = child.nextSibling;
        }
        instance.nodes = nodes;
    }

    return instance;
}

// Shared apply functions imported from constants.js

// ── Helpers: batch rendering, insert point resolution, reindexing ──

/**
 * Render a batch of items into a DocumentFragment
 */
function renderBatch(structure, items, startIndex) {
    const { parentProxy } = structure;
    const fragment = document.createDocumentFragment();
    const newInstances = new Array(items.length);
    for (let i = 0; i < items.length; i++) {
        const instance = renderForLoopInstance(structure, items[i], startIndex + i, parentProxy);
        newInstances[i] = instance;
        const nodes = instance.nodes;
        for (let n = 0; n < nodes.length; n++) fragment.appendChild(nodes[n]);
    }
    return { newInstances, fragment };
}

/**
 * Get the DOM node to insertBefore at a given instance index
 */
function getInsertPoint(instances, index, anchor) {
    if (index < instances.length) return instances[index].nodes[0];
    if (instances.length > 0) {
        const last = instances[instances.length - 1];
        return last.nodes[last.nodes.length - 1].nextSibling;
    }
    return anchor.nextSibling;
}

/**
 * Update instance indices from a given position
 */
function reindex(instances, from) {
    for (let i = from; i < instances.length; i++) {
        instances[i].index = i;
    }
}

/**
 * Initial render of a :for loop
 * @param {Object} structure - For loop structure from compiled output
 * @param {Array|Map|Set} collection - Source collection
 * @param {Object} parentProxy - Parent component proxy
 * @param {Node} anchor - Comment node marker
 */
export function renderForLoop(structure, collection, parentProxy, anchor) {
    structure.anchor = anchor;
    structure.instances = [];
    structure.parentProxy = parentProxy;
    if (!structure.indexVar) structure.indexVar = 'index';

    addArrayForLoop(collection, structure);

    const items = Array.isArray(collection) ? collection :
                  collection instanceof Map ? Array.from(collection.entries()) :
                  collection instanceof Set ? Array.from(collection) : [];

    if (items.length > 0) {
        const { newInstances, fragment } = renderBatch(structure, items, 0);
        structure.instances = newInstances;
        anchor.parentNode.insertBefore(fragment, anchor.nextSibling);
    }
}

// ============================================================================
// FOR LOOP UPDATE FUNCTIONS (called by Reactivity)
// ============================================================================

/**
 * Handle array.push() - append nodes at end
 */
function forLoopPush(structure, items) {
    const { instances, anchor } = structure;
    const insertPoint = getInsertPoint(instances, instances.length, anchor);
    const { newInstances, fragment } = renderBatch(structure, items, instances.length);
    instances.push(...newInstances);
    anchor.parentNode.insertBefore(fragment, insertPoint);
}

/**
 * Handle array.pop() - remove last node
 */
function forLoopPop(structure, removed) {
    const { instances } = structure;
    if (instances.length === 0) return;

    const instance = instances.pop();
    removeInstance(instance);
}

/**
 * Handle array.shift() - remove first node
 */
function forLoopShift(structure, removed) {
    const { instances } = structure;
    if (instances.length === 0) return;

    removeInstance(instances.shift());
    reindex(instances, 0);
}

/**
 * Handle array.unshift() - prepend nodes at start
 */
function forLoopUnshift(structure, items) {
    const { instances, anchor } = structure;
    const { newInstances, fragment } = renderBatch(structure, items, 0);
    anchor.parentNode.insertBefore(fragment, anchor.nextSibling);
    instances.unshift(...newInstances);
    reindex(instances, items.length);
}

/**
 * Handle array.splice() - targeted insert/remove
 */
function forLoopSplice(structure, start, deleteCount, items, removed) {
    const { instances, anchor } = structure;

    // Remove instances
    for (let i = 0; i < deleteCount && start < instances.length; i++) {
        removeInstance(instances[start]);
        instances.splice(start, 1);
    }

    // Insert new instances
    if (items.length > 0) {
        const insertPoint = getInsertPoint(instances, start, anchor);
        const { newInstances, fragment } = renderBatch(structure, items, start);
        anchor.parentNode.insertBefore(fragment, insertPoint);
        instances.splice(start, 0, ...newInstances);
    }

    reindex(instances, start);
}

/**
 * Handle array.sort() or array.reverse() - reuse DOM via reconcile
 * Same length, different order → just update bindings in place
 */
function forLoopReorder(structure, array) {
    forLoopReconcile(structure, array);
}

/**
 * Handle array[index] = value - update single node
 */
function forLoopSet(structure, index, value, oldValue) {
    const { instances, anchor } = structure;
    if (index < 0 || index >= instances.length) return;

    const oldInstance = instances[index];
    const insertPoint = getInsertPoint(instances, index + 1, anchor);
    removeInstance(oldInstance);

    const newInstance = renderForLoopInstance(structure, value, index, structure.parentProxy);
    instances[index] = newInstance;

    const nodes = newInstance.nodes;
    for (let i = 0; i < nodes.length; i++) {
        anchor.parentNode.insertBefore(nodes[i], insertPoint);
    }
}

/**
 * Handle Map.set() - add or update entry
 */
function forLoopMapSet(structure, key, value, isNew) {
    if (isNew) {
        // Add new entry at end
        forLoopPush(structure, [[key, value]]);
    } else {
        // Update existing entry - find by key
        const { instances } = structure;
        for (let i = 0, len = instances.length; i < len; i++) {
            if (instances[i].item[0] === key) {
                forLoopSet(structure, i, [key, value], instances[i].item);
                break;
            }
        }
    }
}

/**
 * Handle Map.delete() - remove entry
 */
function forLoopMapDelete(structure, key) {
    const { instances } = structure;
    for (let i = 0, len = instances.length; i < len; i++) {
        if (instances[i].item[0] === key) {
            forLoopSplice(structure, i, 1, [], [instances[i].item]);
            break;
        }
    }
}

/**
 * Handle Set.add() - add value
 */
function forLoopSetAdd(structure, value) {
    forLoopPush(structure, [value]);
}

/**
 * Handle Set.delete() - remove value
 */
function forLoopSetDelete(structure, value) {
    const { instances } = structure;
    for (let i = 0, len = instances.length; i < len; i++) {
        if (instances[i].item === value) {
            forLoopSplice(structure, i, 1, [], [value]);
            break;
        }
    }
}

/**
 * Handle clear() - remove all nodes
 */
function forLoopClear(structure) {
    const { instances } = structure;
    for (let i = instances.length - 1; i >= 0; i--) {
        removeInstance(instances[i]);
    }
    instances.length = 0;
}

/**
 * Handle array reassignment - reconcile existing nodes in place
 * Only creates/removes nodes when lengths differ
 * @param {Object} structure - For loop structure
 * @param {Array} newArray - New array values to reconcile against
 */
function forLoopReconcile(structure, newArray) {
    const { instances, anchor, parentProxy } = structure;
    const oldLen = instances.length;
    const newLen = newArray.length;
    const minLen = Math.min(oldLen, newLen);
    const iteratorVar = structure.iterator;
    const indexVar = structure.indexVar || 'index';

    // Phase 1: Update existing instances (reuse DOM nodes)
    for (let i = 0; i < minLen; i++) {
        const instance = instances[i];
        const newItem = newArray[i];

        // Update instance so events/bindings see new values
        instance.item = newItem;
        instance.index = i;

        // Re-apply all bindings with resolved value
        const bindings = instance.bindings;
        for (let b = 0, bLen = bindings.length; b < bLen; b++) {
            const binding = bindings[b];
            if (binding.applyFn) {
                const value = resolveIterationValue(binding.property, iteratorVar, newItem, indexVar, i, parentProxy);
                binding.applyFn(value, binding);
            }
        }
    }

    // Phase 2: Add new instances (newLen > oldLen)
    if (newLen > oldLen) {
        const insertPoint = getInsertPoint(instances, oldLen, anchor);
        const { newInstances, fragment } = renderBatch(structure, newArray.slice(oldLen), oldLen);
        instances.push(...newInstances);
        anchor.parentNode.insertBefore(fragment, insertPoint);
    }

    // Phase 3: Remove excess instances (newLen < oldLen)
    if (oldLen > newLen) {
        for (let i = oldLen - 1; i >= newLen; i--) {
            removeInstance(instances.pop());
        }
    }
}

/**
 * Remove an instance from the DOM and cleanup
 */
function removeInstance(instance) {
    // Cleanup directives before DOM removal
    if (instance.directiveInstances) {
        for (let i = 0, len = instance.directiveInstances.length; i < len; i++) {
            const { el, directive, binding } = instance.directiveInstances[i];
            callDirectiveHook('unmounted', directive, el, binding);
            runElementCleanup(el);
        }
    }

    const nodes = instance.nodes;
    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        if (node.parentNode) node.parentNode.removeChild(node);
    }
}

// ============================================================================
// CONDITIONAL RENDERING (:if/:else-if/:else)
// ============================================================================

/**
 * Render a conditional structure
 * @param {Object} structure - Conditional structure from compiled output
 * @param {Object} parentProxy - Parent component proxy
 * @param {Node} anchor - Comment node marker
 */
export function renderConditional(structure, parentProxy, anchor) {
    structure.anchor = anchor;
    structure.parentProxy = parentProxy;
    structure.activeInstance = null;
    structure.activeBranchIndex = -1;

    // Evaluate and render initial state
    updateConditional(structure, parentProxy);
}

/**
 * Update conditional based on current data
 */
export function updateConditional(structure, parentProxy) {
    const { chain, anchor, activeBranchIndex } = structure;

    // Find first truthy chain item
    let newChainIndex = -1;
    for (let i = 0; i < chain.length; i++) {
        const item = chain[i];
        if (!item.condition) {
            // :else (no condition) - always matches
            newChainIndex = i;
            break;
        }
        // Evaluate condition (cache the function on first use)
        try {
            if (!item._condFn) {
                item._condFn = new Function('data', `with(data) { return ${item.condition}; }`);
            }
            const result = item._condFn(parentProxy);
            if (result) {
                newChainIndex = i;
                break;
            }
        } catch (e) {
            logger.warn(`Condition evaluation failed: ${item.condition}`, e);
        }
    }

    // No change needed
    if (newChainIndex === activeBranchIndex) return;

    // Remove current content
    if (structure.activeInstance) {
        removeInstance(structure.activeInstance);
        structure.activeInstance = null;
    }

    // Render new chain item
    if (newChainIndex !== -1) {
        const item = chain[newChainIndex];
        const instance = renderChainItem(item, parentProxy);
        structure.activeInstance = instance;

        // Insert after anchor
        const nodes = instance.nodes;
        for (let i = 0, len = nodes.length; i < len; i++) {
            anchor.parentNode.insertBefore(nodes[i], anchor.nextSibling);
        }
    }

    structure.activeBranchIndex = newChainIndex;
}

/**
 * Render a conditional chain item (if/else-if/else)
 * @param {Object} item - Chain item from compiled output
 * @param {Object} parentProxy - Parent component proxy
 */
function renderChainItem(item, parentProxy) {
    const container = document.createElement('div');
    container.innerHTML = item.template;

    // Get root for path-based access
    const root = container.firstElementChild || container.firstChild;

    // Apply bindings using variable-length bytecode
    const bindings = [];
    const directiveInstances = [];
    const deferredMounts = [];
    const { strings, code } = item.binding;

    let offset = 0;
    while (offset < code.length) {
        const bindingType = code[offset];
        const pathLen = code[offset + 1];

        // Extract path
        const path = [];
        for (let i = 0; i < pathLen; i++) {
            path.push(code[offset + 2 + i]);
        }

        const dataOffset = offset + 2 + pathLen;

        // EVAL types have variable-length deps
        let entryLen;
        if (bindingType === BindingType.TEXT_EVAL) {
            entryLen = 2 + pathLen + 2 + code[dataOffset + 1];
        } else if (bindingType === BindingType.ATTR_EVAL) {
            entryLen = 2 + pathLen + 3 + code[dataOffset + 2];
        } else {
            entryLen = 2 + pathLen + getBindingDataLength(bindingType);
        }

        const bindNode = getNodeByPath(root, path);

        if (bindNode) {
            switch (bindingType) {
                case BindingType.TEXT: {
                    const propIdx = code[dataOffset];
                    const prop = strings[propIdx];
                    bindNode.textContent = parentProxy[prop];

                    const binding = addBinding(parentProxy, prop, bindNode, {
                        type: 'text',
                        applyFn: applyText
                    });
                    bindings.push(binding);
                    break;
                }
                case BindingType.ATTR: {
                    const attrIdx = code[dataOffset];
                    const propIdx = code[dataOffset + 1];
                    const attr = strings[attrIdx];
                    const prop = strings[propIdx];

                    const parsed = parseDirectiveName(attr);
                    if (parsed) {
                        const directive = getDirective(parsed.name);
                        const value = parentProxy[prop];
                        const dBinding = createDirectiveBinding(bindNode, value, { modifiers: parsed.modifiers });
                        callDirectiveHook('created', directive, bindNode, dBinding);
                        directiveInstances.push({ el: bindNode, directive, binding: dBinding, prop });
                        deferredMounts.push({ el: bindNode, directive, binding: dBinding });

                        if (directive.updated) {
                            addBinding(parentProxy, prop, bindNode, {
                                type: 'directive',
                                directiveRef: directive,
                                directiveBinding: dBinding,
                                applyFn: (newValue, b) => {
                                    b.directiveBinding.oldValue = b.directiveBinding.value;
                                    b.directiveBinding.value = newValue;
                                    callDirectiveHook('updated', b.directiveRef, b.node, b.directiveBinding);
                                }
                            });
                        }
                    } else {
                        const value = parentProxy[prop];
                        const isBool = typeof value === 'boolean';
                        if (isBool) {
                            if (value) bindNode.setAttribute(attr, '');
                            else bindNode.removeAttribute(attr);
                        } else {
                            bindNode.setAttribute(attr, value);
                        }
                        const binding = addBinding(parentProxy, prop, bindNode, {
                            type: 'attr',
                            attributeName: attr,
                            applyFn: isBool ? applyBoolAttr : applyAttr
                        });
                        bindings.push(binding);
                    }
                    break;
                }
                case BindingType.EVENT: {
                    const eventConfigIdx = code[dataOffset + 1];
                    const eventConfig = item.event[eventConfigIdx];
                    if (eventConfig) {
                        attachEvent(bindNode, eventConfig, parentProxy);
                    }
                    break;
                }
            }
        }

        offset += entryLen;
    }

    // Flush deferred directive mounted hooks
    for (let i = 0, len = deferredMounts.length; i < len; i++) {
        const { el, directive, binding } = deferredMounts[i];
        callDirectiveHook('mounted', directive, el, binding);
    }

    // Process nested dynamics (e.g., :for inside :if branch)
    const nestedDynamics = [];
    if (item.dynamics && item.dynamics.length > 0) {
        for (let d = 0, dLen = item.dynamics.length; d < dLen; d++) {
            const dynamic = item.dynamics[d];
            const anchor = dynamic.markerPath
                ? getNodeByPath(root, dynamic.markerPath)
                : null;

            if (!anchor) {
                logger.warn('Nested marker not found for dynamic', dynamic);
                continue;
            }

            if (dynamic.type === 'for') {
                const collection = parentProxy[dynamic.source];
                if (collection) {
                    const structure = {
                        ...dynamic,
                        instances: [],
                        anchor,
                        parentProxy
                    };
                    renderForLoop(structure, collection, parentProxy, anchor);
                    nestedDynamics.push(structure);
                }
            } else if (dynamic.type === 'if') {
                const structure = {
                    ...dynamic,
                    anchor,
                    parentProxy,
                    activeInstance: null,
                    activeBranchIndex: -1,
                    updateFn: () => updateConditional(structure, parentProxy)
                };
                renderConditional(structure, parentProxy, anchor);
                nestedDynamics.push(structure);

                // Register with reactivity for each property used in conditions
                const chainItems = structure.chain;
                for (let j = 0, cLen = chainItems.length; j < cLen; j++) {
                    if (chainItems[j].condition) {
                        const identifiers = chainItems[j].condition.match(/[a-zA-Z_$][a-zA-Z0-9_$]*/g) || [];
                        for (let k = 0, kLen = identifiers.length; k < kLen; k++) {
                            if (!JS_RESERVED.has(identifiers[k])) {
                                addDynamicStructure(parentProxy, identifiers[k], structure);
                            }
                        }
                    }
                }
            }
        }
    }

    // Collect child nodes without Array.from allocation
    const childNodes = container.childNodes;
    const nodes = new Array(childNodes.length);
    for (let i = 0, len = childNodes.length; i < len; i++) nodes[i] = childNodes[i];

    return {
        nodes,
        bindings,
        nestedDynamics,
        directiveInstances: directiveInstances.length > 0 ? directiveInstances : null
    };
}

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Register render update functions with Reactivity
 */
export function initRenderUpdates() {
    setRenderUpdates({
        // Array
        forLoopPush,
        forLoopPop,
        forLoopShift,
        forLoopUnshift,
        forLoopSplice,
        forLoopReorder,
        forLoopSet,

        // Map
        forLoopMapSet,
        forLoopMapDelete,

        // Set
        forLoopSetAdd,
        forLoopSetDelete,

        // Shared
        forLoopClear,

        // Reconciliation (array reassignment)
        forLoopReconcile
    });
}

// Auto-initialize when module loads
initRenderUpdates();

// ============================================================================
// EXPORTS
// ============================================================================

export {
    renderForLoopInstance,
    BindingType
};
