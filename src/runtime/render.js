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

import { setRenderUpdates, addArrayForLoop, addBinding, addDynamicStructure, unregisterStructure, removeBinding } from './Reactivity.js';
import { parseDirectiveName, getDirective, createDirectiveBinding, callDirectiveHook, runElementCleanup } from './Directives.js';
import { BindingType, getNodeByPath, getBindingDataLength, applyText, applyAttr, applyBoolAttr, applyValue, setAttrMerged, resolveDottedPath } from './constants.js';
import { createLogger } from './Logger.js';

const logger = createLogger('Render');

// Local apply function for PROP/PROP_SYNC bindings inside :for loops.
// Mirrors applyPropValue in DzComponent.js (duplicated to avoid circular import).
function applyPropValueLocal(value, b) {
    if (b.node.component && b.node.component.isMounted) {
        b.node._propUpdating = true;
        b.node.component.proxy[b.propName] = value;
        b.node._propUpdating = false;
    } else {
        if (!b.node._props) b.node._props = {};
        b.node._props[b.propName] = value;
    }
}

/**
 * Resolve a property value in a :for loop iteration context.
 * Returns the iterator item, index, or parent proxy value depending on the property name.
 */
function resolveIterationValue(prop, iteratorVar, item, indexVar, index, parentProxy) {
    if (prop === iteratorVar) return item;
    if (prop === indexVar) return index;
    return parentProxy[prop];
}

/**
 * Build a "scope" object for nested dynamics inside a :for iteration.
 *
 * Nested dynamics (a :for or :if whose source/condition references the outer
 * iterator variable, e.g. `:for="mid in root.children"` or `:if="root.expanded"`)
 * are compiled as `function() { return this.root.children; }` — the runtime is
 * expected to provide a `this` that exposes the iterator's binding. Top-level
 * dynamics use `this = parentProxy`; nested ones need a scoped `this` that
 * overrides the iterator name with the current iteration's item.
 *
 * We wrap parentProxy in a Proxy so other property accesses fall through to
 * the outer component proxy unchanged. Nesting composes naturally: an inner
 * for can wrap THIS scope to add its own iterator, giving `this.root` AND
 * `this.mid` access at the leaf level.
 */
function makeIterScope(parentProxy, iteratorVar, item, indexVar, index) {
    return new Proxy(parentProxy, {
        get(target, prop, receiver) {
            if (prop === iteratorVar) return item;
            if (prop === indexVar) return index;
            return Reflect.get(target, prop, receiver);
        },
        has(target, prop) {
            if (prop === iteratorVar || prop === indexVar) return true;
            return Reflect.has(target, prop);
        }
    });
}

/**
 * Extract the first-level property names accessed on `iteratorVar` inside a
 * compiled eval function's source. Used to register nested dynamics against
 * the iteration's actual item (so mutating `item.expanded` fires the right
 * `:if`) — the compiler currently only records `deps: [iteratorVar]`, which
 * isn't enough granularity to wire reactivity correctly.
 *
 * Cached on the function. Source matching is `this.<iter>.<prop>` only — good
 * enough for the patterns the compiler emits today. If the compiler grows to
 * support deeper access patterns, this regex needs to widen too.
 */
function extractIteratorDeps(fn, iteratorVar) {
    if (fn._iterDepsVar === iteratorVar) return fn._iterDeps;
    const src = String(fn);
    const re = new RegExp(`\\bthis\\.${iteratorVar}\\.([a-zA-Z_$][a-zA-Z0-9_$]*)`, 'g');
    const deps = [];
    let m;
    while ((m = re.exec(src)) !== null) {
        if (deps.indexOf(m[1]) === -1) deps.push(m[1]);
    }
    fn._iterDeps = deps;
    fn._iterDepsVar = iteratorVar;
    return deps;
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
    // Member path (e.g. post.id, $event.target.value, obj.a.b): resolve the head
    // segment from scope/$event, then walk the remaining segments.
    const dot = arg.indexOf('.');
    if (dot !== -1) {
        const head = arg.slice(0, dot);
        let value = head === '$event' ? event : scope[head];
        const rest = arg.slice(dot + 1).split('.');
        for (let i = 0; i < rest.length && value != null; i++) value = value[rest[i]];
        return value;
    }
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
        // Parse via a <template> element, not a <div>. Setting `.innerHTML` on
        // a <div> drops table-context elements (<tr>, <td>, <tbody>, <thead>,
        // <tfoot>, <col>, <colgroup>) because the HTML parser only accepts
        // them in `in table` insertion mode. <template>.innerHTML uses the
        // template insertion mode which preserves them. We then move the
        // parsed content into a div so cloneNode + path traversal work the
        // same as before for every other template shape.
        const tpl = document.createElement('template');
        tpl.innerHTML = structure.template;
        const stampContainer = document.createElement('div');
        stampContainer.appendChild(tpl.content);
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
                    desc.isDotted = bytecode[dataOffset + 1] === 1;
                    if (desc.isDotted) {
                        desc.evalIdx = bytecode[dataOffset];
                    } else {
                        desc.prop = strings[bytecode[dataOffset]];
                    }
                    desc.applyFn = applyValue;
                    break;
                case BindingType.EVENT:
                    desc.eventConfig = structure.event[bytecode[dataOffset + 1]];
                    break;
                case BindingType.PROP:
                case BindingType.PROP_SYNC:
                    desc.propName = strings[bytecode[dataOffset]];
                    desc.prop = strings[bytecode[dataOffset + 1]];
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

        // Path-group descs: when multiple bindings target the same node (e.g. a
        // text binding and an event handler on the same <li>), there's no need
        // to walk the tree twice per row. We assign each desc a `pathIdx`
        // keyed on path-equality, then sort so same-path descs are adjacent —
        // per row we then only re-resolve when pathIdx changes.
        const pathKey = new Map();
        for (let i = 0; i < descs.length; i++) {
            const key = descs[i].path.join(',');
            let idx = pathKey.get(key);
            if (idx === undefined) {
                idx = pathKey.size;
                pathKey.set(key, idx);
            }
            descs[i].pathIdx = idx;
        }
        descs.sort((a, b) => a.pathIdx - b.pathIdx);

        structure._descs = descs;
    }

    // ── Per-row: clone + apply pre-resolved descriptors ──
    // Use the cloned container itself as the path root — paths from the compiler
    // are always sibling-indexed against the template container, regardless of
    // whether the user wrote one top-level element or many in the loop body.
    const container = structure._stamp.cloneNode(true);
    const root = container;

    const instance = { item, index, nodes: null, bindings: [], directiveInstances: null };
    const bindings = instance.bindings;
    const descs = structure._descs;
    let dirInsts = null;

    let lastPathIdx = -1;
    let bindNode = null;
    for (let d = 0; d < descs.length; d++) {
        const desc = descs[d];
        if (desc.pathIdx !== lastPathIdx) {
            bindNode = getNodeByPath(root, desc.path);
            lastPathIdx = desc.pathIdx;
        }
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
                bindings.push({ node: bindNode, evalFn: desc.evalFn });
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
                        setAttrMerged(bindNode, desc.attr, value);
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
                        setAttrMerged(bindNode, desc.attr, evalValue);
                    }
                    bindings.push({ node: bindNode, evalFn: desc.evalFn, attributeName: desc.attr });
                }
                break;
            }
            case BindingType.TWO_WAY: {
                if (desc.isDotted) {
                    const accessor = structure.eval[desc.evalIdx];
                    const bindTarget = accessor.target.call(parentProxy);
                    const bindKey = accessor.key;
                    bindNode.value = bindTarget[bindKey];
                    const eventName = (bindNode.tagName === 'SELECT' || bindNode.type === 'checkbox' || bindNode.type === 'radio') ? 'change' : 'input';
                    bindNode.addEventListener(eventName, (e) => {
                        bindTarget[bindKey] = e.target.value;
                    });
                    bindings.push({ node: bindNode, property: bindKey, applyFn: desc.applyFn });
                } else {
                    const prop = desc.prop;
                    const value = resolveIterationValue(prop, iteratorVar, item, indexVar, index, parentProxy);
                    bindNode.value = value;
                    const eventName = (bindNode.tagName === 'SELECT' || bindNode.type === 'checkbox' || bindNode.type === 'radio') ? 'change' : 'input';
                    bindNode.addEventListener(eventName, (e) => {
                        if (prop !== iteratorVar && prop !== indexVar) {
                            parentProxy[prop] = e.target.value;
                        }
                    });
                    bindings.push({ node: bindNode, property: prop, applyFn: desc.applyFn });
                }
                break;
            }
            case BindingType.PROP:
            case BindingType.PROP_SYNC: {
                const value = resolveIterationValue(desc.prop, iteratorVar, item, indexVar, index, parentProxy);
                if (!bindNode._props) bindNode._props = {};
                bindNode._props[desc.propName] = value;
                if (bindNode.component && bindNode.component.isMounted) {
                    bindNode._propUpdating = true;
                    bindNode.component.proxy[desc.propName] = value;
                    bindNode._propUpdating = false;
                }
                bindings.push({ node: bindNode, property: desc.prop, propName: desc.propName, applyFn: applyPropValueLocal });
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
                            // Resolve args against an iteration-aware scope so the loop
                            // variable resolves both bare (`post`) and as a member path
                            // (`post.id`). Built per-fire to read the row's current
                            // item/index after reorders.
                            const scope = makeIterScope(parentProxy, iteratorVar, instance.item, indexVar, instance.index);
                            const args = new Array(argNames.length);
                            for (let i = 0; i < argNames.length; i++) {
                                args[i] = resolveEventArg(argNames[i], scope, e);
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

    // Process nested dynamics (:if or :for inside this loop iteration's body).
    //
    // Build an iterScope so condition/source eval functions can read
    // `this.<iterator>` and any outer iterators via the proxy chain. For
    // reactivity registration, iterator-scoped deps route to the iteration
    // item (the actual data proxy) so per-row mutations only fire that row's
    // structures; non-iterator deps fall back to parentProxy.
    let instanceNestedDynamics = null;
    if (structure.dynamics && structure.dynamics.length > 0) {
        const iterScope = makeIterScope(parentProxy, iteratorVar, item, indexVar, index);
        instanceNestedDynamics = [];

        for (let d = 0, dLen = structure.dynamics.length; d < dLen; d++) {
            const dynamic = structure.dynamics[d];
            const anchor = dynamic.markerPath
                ? getNodeByPath(root, dynamic.markerPath)
                : null;

            if (!anchor) {
                logger.warn('Nested marker not found for dynamic', dynamic);
                continue;
            }

            if (dynamic.type === 'for') {
                const resolveSource = dynamic.sourceFn
                    ? () => dynamic.sourceFn.call(iterScope)
                    : () => resolveDottedPath(iterScope, dynamic.source);
                const collection = resolveSource();
                if (collection) {
                    const nestedStructure = {
                        ...dynamic,
                        instances: [],
                        anchor,
                        parentProxy: iterScope
                    };
                    nestedStructure.updateFn = () => {
                        const newCollection = resolveSource();
                        if (Array.isArray(newCollection)) forLoopReconcile(nestedStructure, newCollection);
                    };
                    renderForLoop(nestedStructure, collection, iterScope, anchor);
                    instanceNestedDynamics.push(nestedStructure);

                    const baseProp = dynamic.sourceBase
                        || (dynamic.source && dynamic.source.indexOf('.') !== -1
                            ? dynamic.source.substring(0, dynamic.source.indexOf('.'))
                            : dynamic.source);
                    if (baseProp === iteratorVar && dynamic.sourceFn) {
                        const iterDeps = extractIteratorDeps(dynamic.sourceFn, iteratorVar);
                        for (let k = 0; k < iterDeps.length; k++) {
                            addDynamicStructure(item, iterDeps[k], nestedStructure);
                        }
                    } else if (baseProp) {
                        addDynamicStructure(parentProxy, baseProp, nestedStructure);
                    }
                }
            } else if (dynamic.type === 'if') {
                const nestedStructure = {
                    ...dynamic,
                    anchor,
                    parentProxy: iterScope,
                    activeInstance: null,
                    activeBranchIndex: -1,
                    updateFn: () => updateConditional(nestedStructure, iterScope)
                };
                renderConditional(nestedStructure, iterScope, anchor);
                instanceNestedDynamics.push(nestedStructure);

                const ids = nestedStructure.deps || [];
                for (let k = 0, kLen = ids.length; k < kLen; k++) {
                    const id = ids[k];
                    if (id === iteratorVar) {
                        const condEvals = nestedStructure.condEvals || [];
                        const seen = new Set();
                        for (let c = 0; c < condEvals.length; c++) {
                            const iterDeps = extractIteratorDeps(condEvals[c], iteratorVar);
                            for (let p = 0; p < iterDeps.length; p++) {
                                if (!seen.has(iterDeps[p])) {
                                    seen.add(iterDeps[p]);
                                    addDynamicStructure(item, iterDeps[p], nestedStructure);
                                }
                            }
                        }
                    } else {
                        addDynamicStructure(parentProxy, id, nestedStructure);
                    }
                }
            }
        }
    }
    instance.nestedDynamics = instanceNestedDynamics;

    // Collect root-level nodes — manual iteration avoids Array.from allocation.
    // Root is always the container now, so always walk its children.
    const childCount = structure._stampChildCount;
    const nodes = new Array(childCount);
    let child = container.firstChild;
    for (let i = 0; i < childCount; i++) {
        nodes[i] = child;
        child = child.nextSibling;
    }
    instance.nodes = nodes;

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

    const isMap = collection instanceof Map;
    const isSet = collection instanceof Set;

    // Side-map for O(1) Map.delete/Map.set-existing and Set.delete lookups.
    // Stores instance references — instance.index is kept current by reindex(),
    // so we never have to renumber this side-map after a splice.
    if (isMap || isSet) structure._keyMap = new Map();

    const items = Array.isArray(collection) ? collection :
                  isMap ? Array.from(collection.entries()) :
                  isSet ? Array.from(collection) : [];

    if (items.length > 0) {
        const { newInstances, fragment } = renderBatch(structure, items, 0);
        structure.instances = newInstances;

        if (isMap) {
            for (let i = 0, len = newInstances.length; i < len; i++) {
                structure._keyMap.set(newInstances[i].item[0], newInstances[i]);
            }
        } else if (isSet) {
            for (let i = 0, len = newInstances.length; i < len; i++) {
                structure._keyMap.set(newInstances[i].item, newInstances[i]);
            }
        }

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

    // Remove instances — DOM teardown happens per node, but the array shift
    // is a single splice (was O(n*deleteCount) when called once per item).
    const actualDelete = Math.min(deleteCount, Math.max(0, instances.length - start));
    if (actualDelete > 0) {
        for (let i = 0; i < actualDelete; i++) {
            removeInstance(instances[start + i]);
        }
        instances.splice(start, actualDelete);
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
 * Handle Map.set() - add or update entry.
 * Uses structure._keyMap (Map<key, instance>) for O(1) lookup of the existing
 * entry; instance.index is kept current by reindex(), so no side-map renumber
 * is needed after a splice.
 */
function forLoopMapSet(structure, key, value, isNew) {
    if (isNew) {
        forLoopPush(structure, [[key, value]]);
        const { instances } = structure;
        structure._keyMap.set(key, instances[instances.length - 1]);
    } else {
        const inst = structure._keyMap.get(key);
        if (!inst) return;
        forLoopSet(structure, inst.index, [key, value], inst.item);
        // forLoopSet replaced the instance at the same index — point _keyMap at the new one.
        structure._keyMap.set(key, structure.instances[inst.index]);
    }
}

/**
 * Handle Map.delete() - remove entry. O(1) via _keyMap.
 */
function forLoopMapDelete(structure, key) {
    const inst = structure._keyMap.get(key);
    if (!inst) return;
    structure._keyMap.delete(key);
    forLoopSplice(structure, inst.index, 1, [], [inst.item]);
}

/**
 * Handle Set.add() - add value
 */
function forLoopSetAdd(structure, value) {
    forLoopPush(structure, [value]);
    const { instances } = structure;
    structure._keyMap.set(value, instances[instances.length - 1]);
}

/**
 * Handle Set.delete() - remove value. O(1) via _keyMap.
 */
function forLoopSetDelete(structure, value) {
    const inst = structure._keyMap.get(value);
    if (!inst) return;
    structure._keyMap.delete(value);
    forLoopSplice(structure, inst.index, 1, [], [value]);
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
    if (structure._keyMap) structure._keyMap.clear();
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

        // Skip re-binding when nothing about this slot changed. After a
        // surgical splice/push/pop, the array's remaining slots still hold
        // the same item references at the same indices — the proxy chain
        // walk on the parent triggers this reconcile anyway, but the per-row
        // work is wasted. Saves O(rows × bindings) on every collection
        // mutation that the dispatcher already handled directly.
        if (instance.item === newItem && instance.index === i) continue;

        // Update instance so events/bindings see new values
        instance.item = newItem;
        instance.index = i;

        // Re-apply all bindings with resolved value
        const bindings = instance.bindings;
        for (let b = 0, bLen = bindings.length; b < bLen; b++) {
            const binding = bindings[b];
            if (binding.evalFn) {
                const evalValue = binding.evalFn.call(parentProxy, newItem, i);
                if (binding.attributeName) {
                    if (typeof evalValue === 'boolean') {
                        if (evalValue) binding.node.setAttribute(binding.attributeName, '');
                        else binding.node.removeAttribute(binding.attributeName);
                    } else {
                        binding.node.setAttribute(binding.attributeName, evalValue);
                    }
                } else {
                    binding.node.textContent = evalValue;
                }
            } else if (binding.applyFn) {
                const value = resolveIterationValue(binding.property, iteratorVar, newItem, indexVar, i, parentProxy);
                binding.applyFn(value, binding);
            } else if (binding.attributeName) {
                const value = resolveIterationValue(binding.property, iteratorVar, newItem, indexVar, i, parentProxy);
                setAttrMerged(binding.node, binding.attributeName, value);
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
        if (newLen === 0) {
            // Full clear — single Range.deleteContents() detaches every instance
            // node in one C++ call, instead of N separate parentNode.removeChild
            // calls that the browser may interleave with incremental layout.
            // Significant win for clearing large lists (Clear 1k goes from ~30 ms
            // to ~10 ms in the krausest bench).
            clearAllInstances(structure);
        } else {
            for (let i = oldLen - 1; i >= newLen; i--) {
                removeInstance(instances.pop());
            }
        }
    }
}

/**
 * Bulk-clear all instances using Range.deleteContents() for the DOM removal.
 * Directive cleanup still runs per-instance before the bulk detach so unmounted
 * hooks fire while nodes still have parents.
 */
function clearAllInstances(structure) {
    const instances = structure.instances;
    const n = instances.length;
    if (n === 0) return;

    // Per-instance directive cleanup before the bulk DOM removal.
    for (let i = 0; i < n; i++) {
        const inst = instances[i];
        if (!inst.directiveInstances) continue;
        const dis = inst.directiveInstances;
        for (let j = 0, jLen = dis.length; j < jLen; j++) {
            const { el, directive, binding } = dis[j];
            callDirectiveHook('unmounted', directive, el, binding);
            runElementCleanup(el);
        }
    }

    // Range covering [first node, last node] across all instances.
    const firstNodes = instances[0].nodes;
    const lastNodes = instances[n - 1].nodes;
    const firstNode = firstNodes[0];
    const lastNode = lastNodes[lastNodes.length - 1];
    if (firstNode && lastNode && firstNode.parentNode) {
        const range = document.createRange();
        range.setStartBefore(firstNode);
        range.setEndAfter(lastNode);
        range.deleteContents();
    }

    instances.length = 0;
}

/**
 * Tear down a :for or :if structure: walk its rendered instances and
 * recursively tear them down, then unregister the structure itself from
 * the Reactivity maps. Exported so DzComponent.unmount() can wind up the
 * component's top-level dynamics (the unmount path that this fix
 * originally missed for nested structures).
 */
export function teardownStructure(structure) {
    if (structure.instances) {
        for (let i = 0, len = structure.instances.length; i < len; i++) {
            teardownInstance(structure.instances[i]);
        }
    }
    if (structure.activeInstance) {
        teardownInstance(structure.activeInstance);
    }
    unregisterStructure(structure);
}

/**
 * Tear down an instance's directives + nested :if/:for structures without
 * touching the DOM. Used by removeInstance (which then detaches the
 * instance's nodes) and by the recursive descent so deeply-nested
 * subtrees don't redundantly call removeChild on every inner node — the
 * outer DOM removal sweeps them all in one shot.
 *
 * Critically, this unregisters each nested structure from the Reactivity
 * maps. Without it, `addDynamicStructure` entries leak across collapse /
 * remove cycles because dataBindMap has no lazy pruning (forLoopMap has
 * some via forEachLiveForLoop, but only when the collection is mutated).
 */
function teardownInstance(instance) {
    if (instance.directiveInstances) {
        for (let i = 0, len = instance.directiveInstances.length; i < len; i++) {
            const { el, directive, binding } = instance.directiveInstances[i];
            callDirectiveHook('unmounted', directive, el, binding);
            runElementCleanup(el);
        }
    }
    // Drop bindings registered via addBinding. Chain items (:if branches) push
    // their addBinding return values onto instance.bindings; for-loop rows
    // push plain local objects that have no `_set`, so removeBinding is a
    // safe no-op for those. Without this, addBinding entries accumulate on
    // every :if branch swap and applyBindings iterates over detached nodes.
    if (instance.bindings) {
        for (let i = 0, len = instance.bindings.length; i < len; i++) {
            removeBinding(instance.bindings[i]);
        }
    }
    if (instance.nestedDynamics) {
        for (let i = 0, len = instance.nestedDynamics.length; i < len; i++) {
            teardownStructure(instance.nestedDynamics[i]);
        }
    }
}

/**
 * Remove an instance from the DOM and cleanup
 */
function removeInstance(instance) {
    teardownInstance(instance);

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
    const { chain, condEvals, anchor, activeBranchIndex } = structure;

    // Find first truthy chain item
    let newChainIndex = -1;
    for (let i = 0; i < chain.length; i++) {
        const item = chain[i];
        if (item.condIdx === undefined) {
            // :else (no condition) - always matches
            newChainIndex = i;
            break;
        }
        try {
            if (condEvals[item.condIdx].call(parentProxy)) {
                newChainIndex = i;
                break;
            }
        } catch (e) {
            logger.warn('Condition evaluation failed', e);
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
    // Parse via <template> to preserve table-context elements (<tr>, <td>, …)
    // that <div>.innerHTML would otherwise discard.
    const tpl = document.createElement('template');
    tpl.innerHTML = item.template;
    const container = document.createElement('div');
    container.appendChild(tpl.content);

    // Root is the container itself — paths are sibling-indexed against it.
    const root = container;

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
                            const dirBinding = addBinding(parentProxy, prop, bindNode, {
                                type: 'directive',
                                directiveRef: directive,
                                directiveBinding: dBinding,
                                applyFn: (newValue, b) => {
                                    b.directiveBinding.oldValue = b.directiveBinding.value;
                                    b.directiveBinding.value = newValue;
                                    callDirectiveHook('updated', b.directiveRef, b.node, b.directiveBinding);
                                }
                            });
                            bindings.push(dirBinding);
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
                case BindingType.TWO_WAY: {
                    const refIdx = code[dataOffset];
                    const isDotted = code[dataOffset + 1] === 1;
                    let bindTarget, bindKey;

                    if (isDotted) {
                        const accessor = item.eval[refIdx];
                        bindTarget = accessor.target.call(parentProxy);
                        bindKey = accessor.key;
                    } else {
                        bindTarget = parentProxy;
                        bindKey = strings[refIdx];
                    }

                    bindNode.value = bindTarget[bindKey];
                    const eventName = (bindNode.tagName === 'SELECT' || bindNode.type === 'checkbox' || bindNode.type === 'radio') ? 'change' : 'input';
                    bindNode.addEventListener(eventName, (e) => {
                        bindTarget[bindKey] = e.target.value;
                    });
                    bindings.push(addBinding(bindTarget, bindKey, bindNode, {
                        type: 'two-way',
                        applyFn: applyValue
                    }));
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

    // Process nested dynamics inside an :if branch (e.g., a :for or :if inside
    // an :if body). parentProxy may already be an iterScope from an outer :for —
    // the proxy chain provides iterator-var access to source/condition evals
    // transparently. We register against parentProxy directly here; per-row
    // reactivity routing for iter-scoped deps is handled in
    // renderForLoopInstance, not in chain branches.
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
                const resolveSource = dynamic.sourceFn
                    ? () => dynamic.sourceFn.call(parentProxy)
                    : () => resolveDottedPath(parentProxy, dynamic.source);
                const collection = resolveSource();
                if (collection) {
                    const structure = {
                        ...dynamic,
                        instances: [],
                        anchor,
                        parentProxy
                    };
                    structure.updateFn = () => {
                        const newCollection = resolveSource();
                        if (Array.isArray(newCollection)) forLoopReconcile(structure, newCollection);
                    };
                    renderForLoop(structure, collection, parentProxy, anchor);
                    nestedDynamics.push(structure);

                    const baseProp = dynamic.sourceBase
                        || (dynamic.source && dynamic.source.indexOf('.') !== -1
                            ? dynamic.source.substring(0, dynamic.source.indexOf('.'))
                            : dynamic.source);
                    if (baseProp) addDynamicStructure(parentProxy, baseProp, structure);
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

                const ids = structure.deps || [];
                for (let k = 0, kLen = ids.length; k < kLen; k++) {
                    addDynamicStructure(parentProxy, ids[k], structure);
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
    forLoopReconcile,
    BindingType
};
