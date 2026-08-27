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
 *
 * The compiled binding bytecode is decoded ONCE per definition into
 * descriptor objects (decodeBindingDescs) and applied many times:
 *   - :for rows apply descriptors with iteration-value resolution
 *     (renderForLoopInstance)
 *   - :if chain items and component templates apply descriptors against
 *     a component proxy (applyDescsToTree, shared with DzComponent.js)
 */

import { setRenderUpdates, addArrayForLoop, addBinding, addDynamicStructure, unregisterStructure, removeBinding } from './Reactivity.js';
import { toRaw } from './DataProxy.js';
import { isObject, deepClone } from './helpers.js';
import { parseDirectiveName, getDirective, createDirectiveBinding, callDirectiveHook, runElementCleanup } from './Directives.js';
import {
    BindingType, getNodeByPath, getBindingDataLength,
    applyText, applyAttr, applyBoolAttr, applyValue,
    setAttrMerged, resolveDottedPath, setInputValue, readInputValue
} from './constants.js';
import { createLogger } from './Logger.js';

const logger = createLogger('Render');

// ============================================================================
// SHARED BINDING APPLY FUNCTIONS
// ============================================================================
// Defined once at module level so binding entries reference shared functions
// instead of allocating per-binding closures. Each reads its inputs off the
// binding entry (node, evalFn, proxy, attributeName, ...).

/**
 * Apply function for PROP/PROP_SYNC bindings: push the new value into the
 * child component's proxy if mounted, otherwise stage it in _props for the
 * child to pick up at mount.
 */
export function applyPropValue(value, b) {
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
 * Isolated prop value: objects are deep-cloned so the child can never reach
 * the parent's state through a prop. The default for bare `:prop` — use
 * `.share` for live-by-reference semantics.
 */
function clonePropValue(value) {
    return isObject(value) ? deepClone(toRaw(value)) : value;
}

function applyPropValueIsolated(value, b) {
    applyPropValue(clonePropValue(value), b);
}

/**
 * Expression/literal prop: re-evaluate on each dep change (there's no single
 * parent property to read directly - the value comes from `b.evalFn`, e.g.
 * `:title="'Department'"` or `:count="items.length + 1"`) and isolate the
 * same way a bare `:prop` does.
 */
function applyPropEvalValue(_, b) {
    applyPropValue(clonePropValue(b.evalFn.call(b.proxy)), b);
}

function applyTextEval(_, b) { b.node.textContent = b.evalFn.call(b.proxy); }
function applyAttrEval(_, b) { setAttrMerged(b.node, b.attributeName, b.evalFn.call(b.proxy)); }
function applyBoolAttrEval(_, b) {
    const v = b.evalFn.call(b.proxy);
    if (v) b.node.setAttribute(b.attributeName, '');
    else b.node.removeAttribute(b.attributeName);
}
// :for row eval bindings re-run with the row's CURRENT item/index (read off the
// instance via b.row, so keyed reconciliation that updates instance.item is seen).
function applyForRowText(_, b) { b.node.textContent = b.evalFn.call(b.proxy, b.row.item, b.row.index); }
function applyForRowAttr(_, b) {
    const v = b.evalFn.call(b.proxy, b.row.item, b.row.index);
    if (typeof v === 'boolean') {
        if (v) b.node.setAttribute(b.attributeName, '');
        else b.node.removeAttribute(b.attributeName);
    } else {
        setAttrMerged(b.node, b.attributeName, v);
    }
}
function applyForRowPropEval(_, b) {
    const value = clonePropValue(b.evalFn.call(b.proxy, b.row.item, b.row.index));
    if (!b.node._props) b.node._props = {};
    b.node._props[b.propName] = value;
    if (b.node.component && b.node.component.isMounted) {
        b.node._propUpdating = true;
        b.node.component.proxy[b.propName] = value;
        b.node._propUpdating = false;
    }
}

// The dependencies of a :for row binding that come from OUTER component state
// (not the iterator/index vars), or null if there are none.
function outerDeps(deps, iteratorVar, indexVar) {
    if (!deps || !deps.length) return null;
    const out = [];
    for (let i = 0; i < deps.length; i++) {
        const d = deps[i];
        if (d !== iteratorVar && d !== indexVar) out.push(d);
    }
    return out.length ? out : null;
}

function applyDirectiveUpdate(newValue, b) {
    b.directiveBinding.oldValue = b.directiveBinding.value;
    b.directiveBinding.value = newValue;
    callDirectiveHook('updated', b.directiveRef, b.node, b.directiveBinding);
}
function applyDirectiveEvalUpdate(_, b) {
    b.directiveBinding.oldValue = b.directiveBinding.value;
    b.directiveBinding.value = b.evalFn.call(b.proxy);
    callDirectiveHook('updated', b.directiveRef, b.node, b.directiveBinding);
}

/**
 * Pick the DOM event that signals a model update for a form control.
 */
function changeEventFor(node) {
    return (node.tagName === 'SELECT' || node.type === 'checkbox' || node.type === 'radio') ? 'change' : 'input';
}

/**
 * Wire a two-way binding between a form control and (target, key):
 * initial write into the control, plus a listener that writes the
 * control-type-aware value (checked for checkboxes, Number for number
 * inputs) back into the model.
 */
function attachTwoWay(node, bindTarget, bindKey) {
    setInputValue(node, bindTarget[bindKey]);
    node.addEventListener(changeEventFor(node), (e) => {
        bindTarget[bindKey] = readInputValue(e.target);
    });
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
// Marker read off a scope proxy to retrieve its enclosing-iterator item map.
const ITER_BINDINGS = Symbol('dzIterBindings');

function makeIterScope(parentProxy, iteratorVar, item, indexVar, index) {
    // Chain of enclosing iterator NAME → ITEM (the real data proxy). A nested
    // for-row binding that reads an outer iterator's property (e.g. an inner chip's
    // :class="sec.selected") uses this to subscribe at PROPERTY granularity on the
    // actual item, so mutating sec.selected re-evaluates the row. Without it the
    // binding would subscribe to the scope's whole-object 'sec' key, which only fires
    // on identity reassignment — never on in-place mutation.
    const parentIters = parentProxy ? parentProxy[ITER_BINDINGS] : null;
    const iters = parentIters ? Object.assign({}, parentIters) : {};
    if (item !== null && typeof item === 'object') iters[iteratorVar] = item;
    return new Proxy(parentProxy, {
        get(target, prop, receiver) {
            if (prop === ITER_BINDINGS) return iters;
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
 * Subscribe a :for-row eval binding (text or attribute) so a per-row mutation of an
 * item PROPERTY it reads re-evaluates exactly that row. Three dependency flavours:
 *
 *  1. the row's OWN item — the direct iterator is a bare param (`sec.prop`); subscribe
 *     on `item` at the property granularity the expression reads (extractParamDeps).
 *  2. an ENCLOSING iterator (nested :for) — accessed as `this.<name>.prop` and present
 *     in the scope chain's item map; subscribe on that real item (extractIteratorDeps).
 *  3. ordinary component state — subscribe on the parent proxy, as before.
 *
 * Without (1)/(2) an item-property mutation would only fire a binding keyed on the whole
 * object (identity), never on in-place mutation. This is the row-binding analogue of the
 * nested-structure wiring already done for :for/:if via addDynamicStructure.
 */
function subscribeForRowEval(bindings, desc, bindNode, instance, parentProxy, iteratorVar, indexVar, item, meta) {
    const evalFn = desc.evalFn;
    const mk = () => ({ evalFn, proxy: parentProxy, row: instance, attributeName: meta.attributeName, propName: meta.propName, applyFn: meta.applyFn });
    let wired = false;

    // (1) The row's own item props (direct iterator, a bare param).
    if (item !== null && typeof item === 'object') {
        const own = extractParamDeps(evalFn, iteratorVar);
        for (let p = 0; p < own.length; p++) { bindings.push(addBinding(item, own[p], bindNode, mk())); wired = true; }
    }

    // (2)/(3) Outer deps: enclosing-iterator props on the real item, else component state.
    const outer = outerDeps(desc.deps, iteratorVar, indexVar);
    if (outer) {
        const iters = parentProxy ? parentProxy[ITER_BINDINGS] : null;
        for (let i = 0; i < outer.length; i++) {
            const dep = outer[i];
            const encItem = iters ? iters[dep] : null;
            let depWired = false;
            if (encItem && typeof encItem === 'object') {
                const props = extractIteratorDeps(evalFn, dep);
                for (let p = 0; p < props.length; p++) { bindings.push(addBinding(encItem, props[p], bindNode, mk())); depWired = true; wired = true; }
            }
            if (!depWired) { bindings.push(addBinding(parentProxy, dep, bindNode, mk())); wired = true; }
        }
    }

    // Nothing reactive to subscribe → a plain entry (reconcile still re-evals it).
    if (!wired) bindings.push({ node: bindNode, evalFn, attributeName: meta.attributeName });
}

/**
 * Like extractIteratorDeps but for a BARE param access (`<var>.<prop>`, not `this.<var>`).
 * The compiler names a :for-row eval fn's param after the iterator, so the row's own item
 * is read as `sec.prop`; this pulls those property names so the row can subscribe to them.
 * Cached on the function (keyed by var). The negative-lookbehind-ish prefix class excludes
 * `.`/word chars so `this.sec.x` and `mysec.x` don't match the iterator `sec`.
 */
function extractParamDeps(fn, paramVar) {
    if (fn._paramDepsVar === paramVar) return fn._paramDeps;
    const src = String(fn);
    const re = new RegExp(`(?:^|[^.\\w$])${paramVar}\\.([a-zA-Z_$][a-zA-Z0-9_$]*)`, 'g');
    const deps = [];
    let m;
    while ((m = re.exec(src)) !== null) {
        if (deps.indexOf(m[1]) === -1) deps.push(m[1]);
    }
    fn._paramDeps = deps;
    fn._paramDepsVar = paramVar;
    return deps;
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
 * Resolve an event handler argument inside a :for row without allocating a
 * scope proxy per dispatch: the iterator/index names (bare or as the head of
 * a member path) read the row's CURRENT item/index off the instance (so
 * reorders are seen); everything else falls back to resolveEventArg against
 * the parent scope (which may itself be an outer iteration scope).
 */
function resolveIterEventArg(arg, parentProxy, iteratorVar, indexVar, instance, event) {
    if (arg === iteratorVar) return instance.item;
    if (arg === indexVar) return instance.index;
    const dot = arg.indexOf('.');
    if (dot !== -1) {
        const head = arg.slice(0, dot);
        if (head === iteratorVar || head === indexVar) {
            let value = head === iteratorVar ? instance.item : instance.index;
            const rest = arg.slice(dot + 1).split('.');
            for (let i = 0; i < rest.length && value != null; i++) value = value[rest[i]];
            return value;
        }
    }
    return resolveEventArg(arg, parentProxy, event);
}

// ============================================================================
// ROW EVENT DELEGATION
// ============================================================================
// :for rows don't attach a listener per row — for bubbling events, the row's
// bound node carries a `_dzEvents` entry and ONE delegated listener per
// (container, event type) walks up from event.target executing matching
// entries. 10k rows × @click = 1 listener instead of 10k listeners +
// closures. Entries reference the row instance, so handlers always see the
// row's current item/index after reorders and in-place updates.
//
// Events that don't bubble keep direct per-node listeners.

const NON_BUBBLING_EVENTS = new Set([
    'focus', 'blur', 'mouseenter', 'mouseleave', 'pointerenter', 'pointerleave',
    'scroll', 'load', 'unload', 'error', 'abort',
    'play', 'pause', 'ended', 'canplay', 'canplaythrough', 'loadeddata',
    'loadedmetadata', 'seeked', 'seeking', 'timeupdate', 'volumechange',
    'waiting', 'toggle'
]);

function eventTypeOf(config) {
    return Array.isArray(config) ? config[0] : (config && config.event) || null;
}

/**
 * Execute one row event entry (any of the three compiled formats) against
 * the row's CURRENT item/index.
 * Note: handlers receive the native event from the delegate, so
 * e.currentTarget is the loop container, not the bound node — use the
 * resolved args or e.target for per-node access.
 */
function executeRowEvent(entry, e) {
    const { config, instance, parentProxy, iteratorVar, indexVar } = entry;
    try {
        if (Array.isArray(config)) {
            const methodName = config[1];
            if (config.length === 2) {
                parentProxy[methodName](e);
                return;
            }
            const args = new Array(config.length - 2);
            for (let i = 2; i < config.length; i++) {
                args[i - 2] = resolveIterEventArg(config[i], parentProxy, iteratorVar, indexVar, instance, e);
            }
            parentProxy[methodName](...args);
        } else if (config && config.event) {
            config.eval.call(parentProxy, instance.item, instance.index, e);
        }
    } catch (err) {
        logger.error('Error in row event handler', err);
    }
}

function dispatchDelegated(e, boundary) {
    // Nested :for loops nest delegate containers: when this event was already
    // walked by an inner delegate, resume where it stopped instead of
    // re-walking (and double-firing) the inner rows. A walk-from node in a
    // different shadow tree (event crossed a shadow boundary, target was
    // retargeted) can't reach this boundary via parentNode — restart from
    // the retargeted event.target, which is in this tree.
    let el = e._dzWalkFrom;
    if (!el || (el.getRootNode && boundary.getRootNode && el.getRootNode() !== boundary.getRootNode())) {
        el = e.target;
    }
    while (el && el !== boundary) {
        const entries = el._dzEvents;
        if (entries) {
            for (let i = 0, len = entries.length; i < len; i++) {
                if (entries[i].type !== e.type) continue;
                executeRowEvent(entries[i], e);
                if (e.cancelBubble) return;
            }
        }
        if (e.cancelBubble) return;
        el = el.parentNode;
    }
    e._dzWalkFrom = boundary;
}

/**
 * Attach the delegated listeners a :for structure needs to its container.
 * One listener per (container, event type) for the container's lifetime —
 * several structures (or re-renders) sharing a container reuse it; without
 * `_dzEvents` entries below it the listener is inert. The container is part
 * of the owning component's tree, so it is GC'd with the component.
 */
function attachDelegates(container, eventNames) {
    if (!eventNames || !container) return;
    let attached = container._dzDelegated;
    if (!attached) attached = container._dzDelegated = new Set();
    for (let i = 0, len = eventNames.length; i < len; i++) {
        const type = eventNames[i];
        if (attached.has(type)) continue;
        attached.add(type);
        container.addEventListener(type, (e) => dispatchDelegated(e, container));
    }
}

/**
 * Attach an event listener from a compiled event config.
 * Handles all three compiled formats: METHOD, CALL, and INLINE.
 * @param {Node} node - DOM node to attach listener to
 * @param {Array|Object} eventConfig - Compiled event config
 * @param {Object} scope - Scope proxy for resolving values and methods
 */
export function attachEvent(node, eventConfig, scope) {
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
// BYTECODE DECODING — shared by :for, :if chain items, and component mount
// ============================================================================

/**
 * Decode a compiled binding program into descriptor objects.
 *
 * Variable-length bytecode: [type, pathLen, ...path, ...data]
 * EVAL types carry deps: [type, pathLen, ...path, evalIdx, depsLen, ...depIdx]
 *
 * Descriptors are path-grouped: each desc gets a `pathIdx` keyed on
 * path-equality and the array is sorted so same-path descs are adjacent —
 * appliers then only re-resolve getNodeByPath when pathIdx changes.
 *
 * Directive names are resolved at decode time and the result is cached with
 * the descriptors, so custom directives must be registered before the first
 * render that uses them (same contract the :for stamp cache always had).
 *
 * Callers cache the result (structure._descs / chainItem._descs / def._descs)
 * so each definition decodes exactly once.
 *
 * @param {{strings: string[], code: Uint16Array}} binding - Compiled program
 * @param {Array} evalFns - Compiled eval functions / two-way accessors
 * @param {Array} eventConfigs - Compiled event configs
 * @returns {Object[]} Binding descriptors
 */
export function decodeBindingDescs(binding, evalFns, eventConfigs) {
    const strings = binding.strings || [];
    const bytecode = binding.code || [];
    evalFns = evalFns || [];
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
        let entryLen = 2 + pathLen + getBindingDataLength(type);

        switch (type) {
            case BindingType.TEXT:
                desc.prop = strings[bytecode[dataOffset]];
                desc.applyFn = applyText;
                break;
            case BindingType.TEXT_EVAL: {
                desc.evalFn = evalFns[bytecode[dataOffset]];
                const depsLen = bytecode[dataOffset + 1];
                const deps = new Array(depsLen);
                for (let i = 0; i < depsLen; i++) deps[i] = strings[bytecode[dataOffset + 2 + i]];
                desc.deps = deps;
                entryLen = 2 + pathLen + 2 + depsLen;
                break;
            }
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
                desc.evalFn = evalFns[bytecode[dataOffset + 1]];
                const depsLen = bytecode[dataOffset + 2];
                const deps = new Array(depsLen);
                for (let i = 0; i < depsLen; i++) deps[i] = strings[bytecode[dataOffset + 3 + i]];
                desc.deps = deps;
                const evalParsed = parseDirectiveName(desc.attr);
                if (evalParsed) {
                    desc.directiveParsed = evalParsed;
                    desc.directive = getDirective(evalParsed.name);
                }
                entryLen = 2 + pathLen + 3 + depsLen;
                break;
            }
            case BindingType.TWO_WAY:
                desc.isDotted = bytecode[dataOffset + 1] === 1;
                if (desc.isDotted) {
                    desc.accessor = evalFns[bytecode[dataOffset]];
                } else {
                    desc.prop = strings[bytecode[dataOffset]];
                }
                desc.applyFn = applyValue;
                break;
            case BindingType.EVENT:
                desc.eventConfig = eventConfigs ? eventConfigs[bytecode[dataOffset + 1]] : undefined;
                // Resolve event type + bubbling once here, not per row: both are
                // constant for the binding, so the per-row loop reads the flags
                // instead of recomputing eventTypeOf()/NON_BUBBLING lookups.
                if (desc.eventConfig) {
                    desc.eventType = eventTypeOf(desc.eventConfig);
                    desc.eventNonBubbling = desc.eventType ? NON_BUBBLING_EVENTS.has(desc.eventType) : false;
                }
                break;
            case BindingType.PROP:
            case BindingType.PROP_SYNC:
                desc.propName = strings[bytecode[dataOffset]];
                desc.prop = strings[bytecode[dataOffset + 1]];
                break;
            case BindingType.PROP_EVAL: {
                desc.propName = strings[bytecode[dataOffset]];
                desc.evalFn = evalFns[bytecode[dataOffset + 1]];
                const depsLen = bytecode[dataOffset + 2];
                const deps = new Array(depsLen);
                for (let i = 0; i < depsLen; i++) deps[i] = strings[bytecode[dataOffset + 3 + i]];
                desc.deps = deps;
                entryLen = 2 + pathLen + 3 + depsLen;
                break;
            }
        }

        descs.push(desc);
        offset += entryLen;
    }

    // Path-group descs: when multiple bindings target the same node (e.g. a
    // text binding and an event handler on the same <li>), there's no need
    // to walk the tree twice. We assign each desc a `pathIdx` keyed on
    // path-equality, then sort so same-path descs are adjacent.
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

    return descs;
}

// ============================================================================
// DESCRIPTOR APPLICATION — component templates & :if chain items
// ============================================================================

/**
 * Apply pre-decoded binding descriptors against a tree rooted at a component
 * proxy. Shared by DzComponent.mount (root = shadowRoot) and :if chain items
 * (root = cloned stamp container).
 *
 * Performs the initial DOM write for every binding, registers reactive
 * bindings via addBinding, attaches event listeners, and runs directive
 * `created` hooks. Directive `mounted` hooks are returned in deferredMounts
 * for the caller to flush at its existing point in the lifecycle.
 *
 * @param {Node} root - Path root (shadowRoot or stamp container clone)
 * @param {Object[]} descs - Descriptors from decodeBindingDescs
 * @param {Object} proxy - Component proxy (or iteration scope)
 * @returns {{ bindings: Object[], directiveInstances: Object[], deferredMounts: Object[] }}
 */
export function applyDescsToTree(root, descs, proxy) {
    const bindings = [];
    const directiveInstances = [];
    const deferredMounts = [];

    let lastPathIdx = -1;
    let node = null;
    for (let d = 0; d < descs.length; d++) {
        const desc = descs[d];
        if (desc.pathIdx !== lastPathIdx) {
            node = getNodeByPath(root, desc.path);
            lastPathIdx = desc.pathIdx;
        }
        if (!node) continue;

        switch (desc.type) {
            case BindingType.TEXT: {
                node.textContent = proxy[desc.prop];
                bindings.push(addBinding(proxy, desc.prop, node, {
                    type: 'text',
                    applyFn: applyText
                }));
                break;
            }
            case BindingType.TEXT_EVAL: {
                node.textContent = desc.evalFn.call(proxy);
                for (let i = 0, len = desc.deps.length; i < len; i++) {
                    bindings.push(addBinding(proxy, desc.deps[i], node, {
                        type: 'text-eval',
                        evalFn: desc.evalFn,
                        proxy,
                        applyFn: applyTextEval
                    }));
                }
                break;
            }
            case BindingType.ATTR: {
                if (desc.directiveParsed) {
                    const value = proxy[desc.prop];
                    const dBinding = createDirectiveBinding(node, value, { modifiers: desc.directiveParsed.modifiers });
                    callDirectiveHook('created', desc.directive, node, dBinding);
                    directiveInstances.push({ el: node, directive: desc.directive, binding: dBinding, prop: desc.prop });
                    deferredMounts.push({ el: node, directive: desc.directive, binding: dBinding });

                    if (desc.directive.updated) {
                        bindings.push(addBinding(proxy, desc.prop, node, {
                            type: 'directive',
                            directiveRef: desc.directive,
                            directiveBinding: dBinding,
                            applyFn: applyDirectiveUpdate
                        }));
                    }
                } else {
                    const value = proxy[desc.prop];
                    const isBool = typeof value === 'boolean';
                    if (isBool) {
                        if (value) node.setAttribute(desc.attr, '');
                        else node.removeAttribute(desc.attr);
                    } else {
                        setAttrMerged(node, desc.attr, value);
                    }
                    bindings.push(addBinding(proxy, desc.prop, node, {
                        type: 'attr',
                        attributeName: desc.attr,
                        applyFn: isBool ? applyBoolAttr : applyAttr
                    }));
                }
                break;
            }
            case BindingType.ATTR_EVAL: {
                const evalValue = desc.evalFn.call(proxy);
                if (desc.directiveParsed) {
                    const dBinding = createDirectiveBinding(node, evalValue, { modifiers: desc.directiveParsed.modifiers });
                    callDirectiveHook('created', desc.directive, node, dBinding);
                    directiveInstances.push({ el: node, directive: desc.directive, binding: dBinding });
                    deferredMounts.push({ el: node, directive: desc.directive, binding: dBinding });

                    if (desc.directive.updated) {
                        for (let i = 0, len = desc.deps.length; i < len; i++) {
                            bindings.push(addBinding(proxy, desc.deps[i], node, {
                                type: 'directive',
                                directiveRef: desc.directive,
                                directiveBinding: dBinding,
                                evalFn: desc.evalFn,
                                proxy,
                                applyFn: applyDirectiveEvalUpdate
                            }));
                        }
                    }
                } else {
                    const isBool = typeof evalValue === 'boolean';
                    if (isBool) {
                        if (evalValue) node.setAttribute(desc.attr, '');
                        else node.removeAttribute(desc.attr);
                    } else {
                        setAttrMerged(node, desc.attr, evalValue);
                    }
                    for (let i = 0, len = desc.deps.length; i < len; i++) {
                        bindings.push(addBinding(proxy, desc.deps[i], node, {
                            type: 'attr-eval',
                            attributeName: desc.attr,
                            evalFn: desc.evalFn,
                            proxy,
                            applyFn: isBool ? applyBoolAttrEval : applyAttrEval
                        }));
                    }
                }
                break;
            }
            case BindingType.TWO_WAY: {
                let bindTarget, bindKey;
                if (desc.isDotted) {
                    bindTarget = desc.accessor.target.call(proxy);
                    bindKey = desc.accessor.key;
                } else {
                    bindTarget = proxy;
                    bindKey = desc.prop;
                }
                attachTwoWay(node, bindTarget, bindKey);
                bindings.push(addBinding(bindTarget, bindKey, node, {
                    type: 'two-way',
                    applyFn: applyValue
                }));
                break;
            }
            case BindingType.EVENT: {
                if (desc.eventConfig) attachEvent(node, desc.eventConfig, proxy);
                break;
            }
            case BindingType.PROP: {
                // Isolated one-way prop (the default): primitives copy down,
                // objects are deep-cloned at EVERY push, so child mutations
                // never reach the parent. Parent changes — including nested
                // mutations, surfaced by ancestor bubbling — push a fresh
                // clone down. Use `.share` for live two-way sharing; use
                // events for the child to request changes.
                const value = clonePropValue(proxy[desc.prop]);
                if (!node._props) node._props = {};
                node._props[desc.propName] = value;
                if (node.component && node.component.isMounted) {
                    node._propUpdating = true;
                    node.component.proxy[desc.propName] = value;
                    node._propUpdating = false;
                }
                bindings.push(addBinding(proxy, desc.prop, node, {
                    type: 'prop',
                    propName: desc.propName,
                    applyFn: applyPropValueIsolated
                }));
                break;
            }
            case BindingType.PROP_SYNC: {
                // Shared prop (`.share`, alias `.sync`): live both ways.
                // Objects pass by reference; primitives (and object
                // reassignment) flow back up via the dz:prop-sync bridge —
                // child write emits, applied here to the source property,
                // pushed back down with _propUpdating guarding the echo.
                const value = proxy[desc.prop];
                if (!node._props) node._props = {};
                node._props[desc.propName] = value;
                if (node.component && node.component.isMounted) {
                    node._propUpdating = true;
                    node.component.proxy[desc.propName] = value;
                    node._propUpdating = false;
                }
                bindings.push(addBinding(proxy, desc.prop, node, {
                    type: 'prop',
                    propName: desc.propName,
                    applyFn: applyPropValue
                }));

                if (!node._syncProps) node._syncProps = {};
                node._syncProps[desc.propName] = desc.prop;
                const propName = desc.propName;
                const source = desc.prop;
                node.addEventListener('dz:prop-sync', (e) => {
                    if (e.detail.prop === propName) {
                        proxy[source] = e.detail.value;
                    }
                });
                break;
            }
            case BindingType.PROP_EVAL: {
                // One-way only - an expression/literal has no single addressable
                // source to write a `.share` echo back into.
                const value = clonePropValue(desc.evalFn.call(proxy));
                if (!node._props) node._props = {};
                node._props[desc.propName] = value;
                if (node.component && node.component.isMounted) {
                    node._propUpdating = true;
                    node.component.proxy[desc.propName] = value;
                    node._propUpdating = false;
                }
                for (let i = 0, len = desc.deps.length; i < len; i++) {
                    bindings.push(addBinding(proxy, desc.deps[i], node, {
                        type: 'prop-eval',
                        propName: desc.propName,
                        evalFn: desc.evalFn,
                        proxy,
                        applyFn: applyPropEvalValue
                    }));
                }
                break;
            }
        }
    }

    return { bindings, directiveInstances, deferredMounts };
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
/**
 * Parse a :for definition's template into a reusable stamp and decode its
 * binding descriptors — once per DEFINITION, cached on the def object itself.
 * Structure instances created per render (`{...def}`) carry the cached
 * fields through the spread, so nested :for loops don't re-parse their
 * template for every outer row, and repeated component instances share one
 * decode.
 *
 * Parse via a <template> element, not a <div>. Setting `.innerHTML` on a
 * <div> drops table-context elements (<tr>, <td>, <tbody>, <thead>, <tfoot>,
 * <col>, <colgroup>) because the HTML parser only accepts them in `in table`
 * insertion mode. <template>.innerHTML uses the template insertion mode
 * which preserves them. We move the parsed content into a DocumentFragment
 * (adopting it into this document) rather than a wrapper <div>: a fragment
 * has the same childNodes indexing for path traversal, but cloning it per
 * row allocates one fewer element than cloning a div we'd only discard.
 */
export function ensureForStamp(def) {
    if (!def._stamp) {
        const tpl = document.createElement('template');
        tpl.innerHTML = def.template;
        const stampContainer = document.createDocumentFragment();
        stampContainer.appendChild(tpl.content);
        def._stamp = stampContainer;
        def._stampChildCount = stampContainer.childNodes.length;
        def._descs = decodeBindingDescs(def.binding, def.eval, def.event);
        // Rows are eligible for in-place item replacement (forLoopSet) unless a
        // binding is pinned to the old item: dotted two-way binds resolve their
        // target once, and eval bindings that read the row's OWN item properties
        // subscribe on that item (see subscribeForRowEval) — the in-place path
        // re-evals but does NOT re-subscribe, so those rows must fully rebuild.
        def._inPlaceSafe = !def._descs.some(
            d => (d.type === BindingType.TWO_WAY && d.isDotted)
                || ((d.type === BindingType.ATTR_EVAL || d.type === BindingType.TEXT_EVAL)
                    && d.evalFn && extractParamDeps(d.evalFn, def.iterator).length > 0)
        );
        // Bubbling event types used by rows → delegated container listeners.
        const delegated = new Set();
        for (let i = 0; i < def._descs.length; i++) {
            const d = def._descs[i];
            if (d.type !== BindingType.EVENT || !d.eventConfig) continue;
            const type = eventTypeOf(d.eventConfig);
            if (type && !NON_BUBBLING_EVENTS.has(type)) delegated.add(type);
        }
        def._delegatedEvents = delegated.size > 0 ? [...delegated] : null;
    }
    return def;
}

function renderForLoopInstance(structure, item, index, parentProxy) {
    const iteratorVar = structure.iterator;
    const indexVar = structure.indexVar || 'index';

    // One-time setup (fallback for structures built without ensureForStamp).
    if (!structure._stamp) ensureForStamp(structure);

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
            case BindingType.TEXT_EVAL: {
                bindNode.textContent = desc.evalFn.call(parentProxy, item, index);
                // Subscribe to OUTER deps so changes to component state (not just the
                // row item) re-evaluate this row; reconciliation re-evals via evalFn.
                // Item-property deps (own + enclosing iterator) subscribe per-property.
                subscribeForRowEval(bindings, desc, bindNode, instance, parentProxy,
                    iteratorVar, indexVar, item, { applyFn: applyForRowText });
                break;
            }
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
                    subscribeForRowEval(bindings, desc, bindNode, instance, parentProxy,
                        iteratorVar, indexVar, item, { attributeName: desc.attr, applyFn: applyForRowAttr });
                }
                break;
            }
            case BindingType.TWO_WAY: {
                if (desc.isDotted) {
                    const bindTarget = desc.accessor.target.call(parentProxy);
                    const bindKey = desc.accessor.key;
                    attachTwoWay(bindNode, bindTarget, bindKey);
                    bindings.push({ node: bindNode, property: bindKey, applyFn: desc.applyFn });
                } else {
                    const prop = desc.prop;
                    const value = resolveIterationValue(prop, iteratorVar, item, indexVar, index, parentProxy);
                    setInputValue(bindNode, value);
                    bindNode.addEventListener(changeEventFor(bindNode), (e) => {
                        if (prop !== iteratorVar && prop !== indexVar) {
                            parentProxy[prop] = readInputValue(e.target);
                        }
                    });
                    bindings.push({ node: bindNode, property: prop, applyFn: desc.applyFn });
                }
                break;
            }
            case BindingType.PROP:
            case BindingType.PROP_SYNC: {
                const isShared = desc.type === BindingType.PROP_SYNC;
                const raw = resolveIterationValue(desc.prop, iteratorVar, item, indexVar, index, parentProxy);
                // Bare :prop is isolated — objects clone so the child can't
                // mutate the parent's (or the row item's) state. `.share`
                // passes the live reference.
                const value = isShared ? raw : clonePropValue(raw);
                if (!bindNode._props) bindNode._props = {};
                bindNode._props[desc.propName] = value;
                if (bindNode.component && bindNode.component.isMounted) {
                    bindNode._propUpdating = true;
                    bindNode.component.proxy[desc.propName] = value;
                    bindNode._propUpdating = false;
                }
                bindings.push({
                    node: bindNode,
                    property: desc.prop,
                    propName: desc.propName,
                    applyFn: isShared ? applyPropValue : applyPropValueIsolated
                });

                // Shared write-back: only when the source is an addressable
                // component property. Iterator-scoped sources are either
                // objects (live by reference already) or primitives with no
                // writable source slot (down-only).
                if (isShared && desc.prop !== iteratorVar && desc.prop !== indexVar) {
                    if (!bindNode._syncProps) bindNode._syncProps = {};
                    bindNode._syncProps[desc.propName] = desc.prop;
                    const propName = desc.propName;
                    const source = desc.prop;
                    bindNode.addEventListener('dz:prop-sync', (e) => {
                        if (e.detail.prop === propName) {
                            parentProxy[source] = e.detail.value;
                        }
                    });
                }
                break;
            }
            case BindingType.PROP_EVAL: {
                const value = clonePropValue(desc.evalFn.call(parentProxy, item, index));
                if (!bindNode._props) bindNode._props = {};
                bindNode._props[desc.propName] = value;
                if (bindNode.component && bindNode.component.isMounted) {
                    bindNode._propUpdating = true;
                    bindNode.component.proxy[desc.propName] = value;
                    bindNode._propUpdating = false;
                }
                subscribeForRowEval(bindings, desc, bindNode, instance, parentProxy,
                    iteratorVar, indexVar, item, { propName: desc.propName, applyFn: applyForRowPropEval });
                break;
            }
            case BindingType.EVENT: {
                const eventConfig = desc.eventConfig;
                if (!eventConfig) break;
                const type = desc.eventType;
                if (!type) break;
                const entry = { type, config: eventConfig, instance, parentProxy, iteratorVar, indexVar };
                if (desc.eventNonBubbling) {
                    // Non-bubbling events can't delegate — direct listener.
                    bindNode.addEventListener(type, (e) => executeRowEvent(entry, e));
                } else {
                    // Delegated: the container listener (attachDelegates) walks
                    // up from event.target and executes matching entries.
                    if (!bindNode._dzEvents) bindNode._dzEvents = [];
                    bindNode._dzEvents.push(entry);
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

        // Resolve every nested dynamic's marker anchor BEFORE any of them render.
        // Marker paths are positional child-node indices computed against the
        // pristine per-row template. If resolution were interleaved with
        // rendering (one dynamic's anchor looked up, then rendered, then the
        // next one's anchor looked up), an earlier :if/:for that already
        // inserted real sibling nodes would shift the live indices out from
        // under a later dynamic's still-untouched marker path — silently
        // capturing some earlier dynamic's REMOVABLE rendered content as the
        // anchor instead of the permanent marker comment. That mis-capture
        // renders fine until the real owner removes its content, at which
        // point the later structure's insertBefore dereferences a detached
        // node's null parentNode. Resolving all anchors up front, against the
        // still-untouched tree, avoids the shift entirely.
        const dLen = structure.dynamics.length;
        const anchors = new Array(dLen);
        for (let d = 0; d < dLen; d++) {
            const dynamic = structure.dynamics[d];
            anchors[d] = dynamic.markerPath ? getNodeByPath(root, dynamic.markerPath) : null;
        }

        for (let d = 0; d < dLen; d++) {
            const dynamic = structure.dynamics[d];
            const anchor = anchors[d];

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
                    // Stamp/descs cached on the shared def; the spread carries
                    // them onto this row's structure.
                    ensureForStamp(dynamic);
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

// ── Helpers: batch rendering, insert point resolution, reindexing ──

/**
 * Append items to an array one by one. Equivalent to arr.push(...items)
 * without the spread, which overflows the argument stack for very large
 * batches (~65k+ items).
 */
function appendAll(arr, items) {
    for (let i = 0, len = items.length; i < len; i++) arr.push(items[i]);
}

/**
 * Insert items into arr starting at index — spread-free splice insert.
 */
function insertAllAt(arr, index, items) {
    if (index >= arr.length) {
        appendAll(arr, items);
        return;
    }
    const tail = arr.slice(index);
    arr.length = index;
    appendAll(arr, items);
    appendAll(arr, tail);
}

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

    // Stamp/descs may not be cached yet when the collection starts empty
    // (no row render to trigger the fallback) — ensure now so the delegated
    // event listeners exist before the first push.
    ensureForStamp(structure);
    attachDelegates(anchor.parentNode, structure._delegatedEvents);

    addArrayForLoop(collection, structure);

    // Iterate the RAW collection: rows must hold raw items, matching what
    // the mutation paths deliver (push items, reconcile arrays, Map/Set
    // metas are all raw). Iterating the proxy would wrap each object item
    // in a child proxy and break identity comparisons — including
    // identity-keyed reconciliation between an initial render and a later
    // reassignment.
    const raw = toRaw(collection);
    const isMap = raw instanceof Map;
    const isSet = raw instanceof Set;

    // Side-map for O(1) Map.delete/Map.set-existing and Set.delete lookups.
    // Stores instance references — instance.index is kept current by reindex(),
    // so we never have to renumber this side-map after a splice.
    if (isMap || isSet) structure._keyMap = new Map();

    const items = Array.isArray(raw) ? raw :
                  isMap ? Array.from(raw.entries()) :
                  isSet ? Array.from(raw) : [];

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
    appendAll(instances, newInstances);
    anchor.parentNode.insertBefore(fragment, insertPoint);
}

/**
 * Handle array.pop() - remove last node
 */
function forLoopPop(structure) {
    const { instances } = structure;
    if (instances.length === 0) return;

    const instance = instances.pop();
    removeInstance(instance);
}

/**
 * Handle array.shift() - remove first node
 */
function forLoopShift(structure) {
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
    insertAllAt(instances, 0, newInstances);
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
        insertAllAt(instances, start, newInstances);
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
 * Handle array[index] = value - update single row.
 *
 * In-place fast path: when the row carries nothing that captured the OLD
 * item at bind time (nested :if/:for registered against it, directive
 * instances created with its value, dotted two-way binds), the existing DOM
 * nodes are kept and only the bindings re-apply — no teardown, no clone,
 * no re-bind. This is the krausest "update every 10th row" path.
 */
function forLoopSet(structure, index, value, oldValue) {
    const { instances, anchor } = structure;
    if (index < 0 || index >= instances.length) return;

    const oldInstance = instances[index];

    if (structure._inPlaceSafe
        && (!structure.dynamics || structure.dynamics.length === 0)
        && !oldInstance.directiveInstances) {
        updateInstanceBindings(structure, oldInstance, value, index);
        return;
    }

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
 * Re-apply a row's bindings for a new (item, index) pair. Extracted from
 * reconcile so the keyed path can rebind only the rows whose item or index
 * actually changed.
 */
function updateInstanceBindings(structure, instance, newItem, newIndex) {
    const { parentProxy } = structure;
    const iteratorVar = structure.iterator;
    const indexVar = structure.indexVar || 'index';

    // Update instance so events/bindings see new values
    instance.item = newItem;
    instance.index = newIndex;

    const bindings = instance.bindings;
    for (let b = 0, bLen = bindings.length; b < bLen; b++) {
        const binding = bindings[b];
        if (binding.evalFn) {
            const evalValue = binding.evalFn.call(parentProxy, newItem, newIndex);
            if (binding.attributeName) {
                if (typeof evalValue === 'boolean') {
                    if (evalValue) binding.node.setAttribute(binding.attributeName, '');
                    else binding.node.removeAttribute(binding.attributeName);
                } else {
                    setAttrMerged(binding.node, binding.attributeName, evalValue);
                }
            } else {
                binding.node.textContent = evalValue;
            }
        } else if (binding.applyFn) {
            const value = resolveIterationValue(binding.property, iteratorVar, newItem, indexVar, newIndex, parentProxy);
            binding.applyFn(value, binding);
        } else if (binding.attributeName) {
            const value = resolveIterationValue(binding.property, iteratorVar, newItem, indexVar, newIndex, parentProxy);
            setAttrMerged(binding.node, binding.attributeName, value);
        }
    }
}

/**
 * Longest-increasing-subsequence over the old positions of reused rows.
 * Returns the set of NEW positions whose rows don't need a DOM move —
 * everything outside the set gets moved/inserted. O(n log n).
 *
 * @param {number[]} oldIndexAt - For each new position, the reused row's old
 *   index, or -1 for a freshly rendered row.
 * @returns {Set<number>} Stable new positions
 */
function computeStableSet(oldIndexAt) {
    const n = oldIndexAt.length;
    const tails = [];      // tails[k] = position i ending the best LIS of length k+1
    const tailVals = [];   // tailVals[k] = oldIndexAt[tails[k]]
    const prev = new Array(n).fill(-1);

    for (let i = 0; i < n; i++) {
        const v = oldIndexAt[i];
        if (v === -1) continue;
        let lo = 0, hi = tailVals.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (tailVals[mid] < v) lo = mid + 1;
            else hi = mid;
        }
        if (lo > 0) prev[i] = tails[lo - 1];
        tails[lo] = i;
        tailVals[lo] = v;
    }

    const stable = new Set();
    let k = tails.length > 0 ? tails[tails.length - 1] : -1;
    while (k !== -1) {
        stable.add(k);
        k = prev[k];
    }
    return stable;
}

/**
 * Handle array reassignment, sort, reverse, and filter-then-assign —
 * KEYED reconciliation against the new array.
 *
 * Rows are matched by key — `structure.keyFn` when the template declared
 * :key, otherwise the item itself (object identity; primitives by value,
 * duplicates matched in order). Matched rows keep their DOM nodes (and
 * therefore their input/focus/checkbox/animation state) and are MOVED into
 * position with the minimal move set (LIS); only rows whose item or index
 * changed get their bindings re-applied. Unmatched old rows are removed,
 * unmatched new items are rendered fresh.
 *
 * The surgical mutation paths (push/splice/...) don't come through here —
 * the dispatchers already updated those rows exactly, which is why the
 * identical-slots fast path exits first.
 *
 * @param {Object} structure - For loop structure
 * @param {Array} newArray - New array values to reconcile against
 */
function forLoopReconcile(structure, newArray) {
    const { instances, anchor, parentProxy } = structure;
    const oldLen = instances.length;
    const newLen = newArray.length;

    // Fast path: same items in the same slots (the usual state after the
    // mutation dispatchers handled the change surgically) — nothing to do.
    if (oldLen === newLen) {
        let same = true;
        for (let i = 0; i < oldLen; i++) {
            if (instances[i].item !== newArray[i]) { same = false; break; }
        }
        if (same) return;
    }

    // Full clear — single Range.deleteContents() detaches every instance
    // node in one C++ call (Clear 1k: ~30 ms → ~10 ms in the krausest bench).
    if (newLen === 0) {
        clearAllInstances(structure);
        return;
    }

    // Empty → full render
    if (oldLen === 0) {
        const { newInstances, fragment } = renderBatch(structure, newArray, 0);
        appendAll(instances, newInstances);
        anchor.parentNode.insertBefore(fragment, anchor.nextSibling);
        return;
    }

    const keyFn = structure.keyFn || null;

    // Index old rows by key. Queues make duplicate keys (and primitive
    // arrays with repeated values) match in order instead of colliding.
    const oldByKey = new Map();
    for (let i = 0; i < oldLen; i++) {
        const inst = instances[i];
        const k = keyFn ? keyFn(inst.item) : inst.item;
        let queue = oldByKey.get(k);
        if (!queue) oldByKey.set(k, queue = []);
        queue.push(inst);
    }

    // Match new items to old rows; rebind only what changed.
    const newInstances = new Array(newLen);
    const oldIndexAt = new Array(newLen);
    let matched = 0;
    for (let i = 0; i < newLen; i++) {
        const item = newArray[i];
        const queue = oldByKey.get(keyFn ? keyFn(item) : item);
        if (queue && queue.length > 0) {
            const inst = queue.shift();
            oldIndexAt[i] = inst.index;
            if (inst.item !== item || inst.index !== i) {
                updateInstanceBindings(structure, inst, item, i);
            }
            newInstances[i] = inst;
            matched++;
        } else {
            oldIndexAt[i] = -1;
            newInstances[i] = null; // rendered during the placement walk
        }
    }

    // Total replacement: not a single new item matched an existing row (the
    // collection was reassigned to a fresh array — exactly what the bench's
    // "create" op does). The general placement walk below would removeInstance
    // every old row and insertBefore every new row one node at a time into the
    // LIVE tree. Route instead through the bulk path used by empty→full: one
    // Range delete for teardown + a single DocumentFragment insert. Per the
    // split-timing profiler, the live node-by-node insert/remove is where the
    // reconcile overhead lives (~0 detached, large attached); this collapses it
    // to the cold-render cost.
    if (matched === 0) {
        clearAllInstances(structure);
        const { newInstances: built, fragment } = renderBatch(structure, newArray, 0);
        appendAll(instances, built);
        anchor.parentNode.insertBefore(fragment, anchor.nextSibling);
        return;
    }

    // Node following the loop block — captured before removals (it is outside
    // the block, so removals can't invalidate it). null means end-of-parent.
    const lastOld = instances[oldLen - 1];
    const blockEnd = lastOld.nodes[lastOld.nodes.length - 1].nextSibling;

    // Remove old rows that found no match.
    for (const queue of oldByKey.values()) {
        for (let i = 0; i < queue.length; i++) removeInstance(queue[i]);
    }

    // Minimal moves: rows on the LIS of old positions stay put.
    const stable = computeStableSet(oldIndexAt);

    // Place rows back-to-front: each row is inserted/moved before the row
    // that follows it in the new order (or before blockEnd for the last).
    const parent = anchor.parentNode;
    let nextNode = blockEnd;
    for (let i = newLen - 1; i >= 0; i--) {
        let inst = newInstances[i];
        if (!inst) {
            inst = renderForLoopInstance(structure, newArray[i], i, parentProxy);
            newInstances[i] = inst;
            const nodes = inst.nodes;
            for (let n = 0; n < nodes.length; n++) parent.insertBefore(nodes[n], nextNode);
        } else if (!stable.has(i)) {
            const nodes = inst.nodes;
            for (let n = 0; n < nodes.length; n++) parent.insertBefore(nodes[n], nextNode);
        }
        nextNode = inst.nodes[0];
    }

    // Swap in the new row list (in place — `instances` is the live reference).
    instances.length = 0;
    appendAll(instances, newInstances);
}

/**
 * Bulk-clear all instances using Range.deleteContents() for the DOM removal.
 * Teardown (directive unmounted hooks, binding unregistration, nested
 * structure unwinding) runs per-instance before the bulk detach so hooks
 * fire while nodes still have parents.
 *
 * If any unmounted hook returns a Promise (leave animation), the bulk range
 * delete can't be used — deferred rows must outlive the rest — so removal
 * falls back to per-instance detach with deferral.
 */
function clearAllInstances(structure) {
    const instances = structure.instances;
    const n = instances.length;
    if (n === 0) return;

    let anyDeferred = false;
    const contexts = new Array(n);
    for (let i = 0; i < n; i++) {
        const ctx = { promises: null, deferredCleanup: null };
        teardownInstance(instances[i], ctx);
        contexts[i] = ctx;
        if (ctx.promises) anyDeferred = true;
    }

    if (!anyDeferred) {
        // Range covering [first node, last node] across all instances —
        // one C++ call instead of N removeChild calls (Clear 1k: ~30 ms
        // → ~10 ms in the krausest bench).
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
    } else {
        for (let i = 0; i < n; i++) {
            finishRemoval(instances[i], contexts[i]);
        }
    }

    instances.length = 0;
}

/**
 * Tear down a :for or :if structure: walk its rendered instances and
 * recursively tear them down, then unregister the structure itself from
 * the Reactivity maps. Exported so DzComponent.unmount() can wind up the
 * component's top-level dynamics — that path passes no leave context, so
 * teardown is fully synchronous (the host element is disconnecting; there
 * is nothing to animate).
 *
 * @param {Object} structure
 * @param {Object} [ctx] - Leave context threaded through nested teardown
 */
export function teardownStructure(structure, ctx) {
    if (structure.instances) {
        for (let i = 0, len = structure.instances.length; i < len; i++) {
            teardownInstance(structure.instances[i], ctx);
        }
    }
    if (structure.activeInstance) {
        teardownInstance(structure.activeInstance, ctx);
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
 *
 * Leave animations: when `ctx` is provided and an unmounted hook returns a
 * Promise, the promise is collected in ctx.promises and that element's
 * cleanup (tracked listeners/timers — possibly driving the animation) is
 * deferred to ctx.deferredCleanup. Reactive unregistration always happens
 * immediately: a leaving row must stop receiving updates the moment it
 * leaves the data, even while its exit animation plays.
 *
 * @param {Object} instance
 * @param {Object} [ctx] - { promises: Promise[]|null, deferredCleanup: Set|null }
 */
function teardownInstance(instance, ctx) {
    if (instance.directiveInstances) {
        for (let i = 0, len = instance.directiveInstances.length; i < len; i++) {
            const { el, directive, binding } = instance.directiveInstances[i];
            const result = callDirectiveHook('unmounted', directive, el, binding);
            if (ctx && result && typeof result.then === 'function') {
                if (!ctx.promises) ctx.promises = [];
                ctx.promises.push(result);
                if (!ctx.deferredCleanup) ctx.deferredCleanup = new Set();
                ctx.deferredCleanup.add(el);
            } else if (!(ctx && ctx.deferredCleanup && ctx.deferredCleanup.has(el))) {
                runElementCleanup(el);
            }
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
            teardownStructure(instance.nestedDynamics[i], ctx);
        }
    }
}

function detachInstanceNodes(instance) {
    const nodes = instance.nodes;
    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        if (node.parentNode) node.parentNode.removeChild(node);
    }
}

/**
 * Detach an instance's nodes — immediately, or after every collected leave
 * promise settles (allSettled, so one rejected animation can't strand
 * nodes). Deferred element cleanup runs just before the detach.
 */
function finishRemoval(instance, ctx) {
    if (!ctx.promises) {
        detachInstanceNodes(instance);
        return;
    }
    Promise.allSettled(ctx.promises).then(() => {
        if (ctx.deferredCleanup) {
            for (const el of ctx.deferredCleanup) runElementCleanup(el);
        }
        detachInstanceNodes(instance);
    });
}

/**
 * Remove an instance from the DOM and clean up. If a directive's unmounted
 * hook returned a Promise (leave animation), the nodes stay in the DOM
 * until it settles; the instance is already out of the structure's
 * bookkeeping, so the renderer treats it as gone immediately.
 */
function removeInstance(instance) {
    const ctx = { promises: null, deferredCleanup: null };
    teardownInstance(instance, ctx);
    finishRemoval(instance, ctx);
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
 *
 * The parsed template stamp and decoded binding descriptors are cached on
 * the chain item itself (which is shared by every structure instantiated
 * from the same compiled definition), so toggling an :if re-clones a
 * pre-parsed tree instead of re-running innerHTML parsing and bytecode
 * decoding on every branch activation.
 *
 * @param {Object} item - Chain item from compiled output
 * @param {Object} parentProxy - Parent component proxy
 */
function renderChainItem(item, parentProxy) {
    if (!item._stamp) {
        // Parse via <template> to preserve table-context elements (<tr>, <td>, …)
        // that <div>.innerHTML would otherwise discard. Stamp into a fragment,
        // not a wrapper <div>: same childNodes indexing for path traversal,
        // one fewer cloned element per branch activation.
        const tpl = document.createElement('template');
        tpl.innerHTML = item.template;
        const container = document.createDocumentFragment();
        container.appendChild(tpl.content);
        item._stamp = container;
        item._stampChildCount = container.childNodes.length;
        item._descs = decodeBindingDescs(item.binding, item.eval, item.event);
    }

    // Root is the cloned container itself — paths are sibling-indexed against it.
    const container = item._stamp.cloneNode(true);
    const root = container;

    const { bindings, directiveInstances, deferredMounts } = applyDescsToTree(root, item._descs, parentProxy);

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
                    // Stamp/descs cached on the shared def; the spread carries
                    // them onto this structure.
                    ensureForStamp(dynamic);
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
    const childCount = item._stampChildCount;
    const nodes = new Array(childCount);
    let child = container.firstChild;
    for (let i = 0; i < childCount; i++) {
        nodes[i] = child;
        child = child.nextSibling;
    }

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
