/**
 * DzComponent.js - Web Component for Deezul
 *
 * Custom element that renders compiled Deezul components.
 * Uses Shadow DOM for style encapsulation.
 *
 * Usage:
 *   <dz-component dz-type="my-counter"></dz-component>
 */

import { componentRegistry } from './registries.js';
import createReactivity, { addBinding, addDynamicStructure, registerUpdateCallback } from './Reactivity.js';
import { renderForLoop, renderConditional, updateConditional } from './render.js';
import { parseDirectiveName, getDirective, createDirectiveBinding, callDirectiveHook, runElementCleanup } from './Directives.js';
import { handleComponentError, clearErrorState, hasError } from './ErrorBoundary.js';
import { renderStylesIntoShadow } from './StyleSystem.js';
import { renderLoading } from './LibraryComponents.js';
import { BindingType, getNodeByPath, getBindingDataLength, applyText, applyAttr, applyBoolAttr, applyValue } from './constants.js';
import { createLogger } from './Logger.js';

const logger = createLogger('DzComponent');

// Instance counter for unique IDs
let instanceCounter = 0;

/**
 * Validate that a lifecycle hook is a function (or null/undefined).
 * Logs a warning and returns null if the value is truthy but not callable.
 * @param {*} hook - Hook value from component definition
 * @param {string} hookName - Hook name for error messages
 * @param {string} componentType - Component type name for error messages
 * @returns {Function|null}
 */
function validateHook(hook, hookName, componentType) {
	if (!hook) return null;
	if (typeof hook === 'function') return hook;
	logger.warn(`[${componentType}] ${hookName} must be a function, got ${typeof hook} — ignoring`);
	return null;
}

/**
 * Recursively cleanup directive instances within dynamic structures (:for/:if).
 * Fires 'unmounted' hooks and runs element cleanup for all directive instances
 * nested within :for loop instances and :if active branches.
 * @param {Array} dynamics - Array of dynamic structures from component
 */
function cleanupDynamics(dynamics) {
	for (let i = 0, len = dynamics.length; i < len; i++) {
		const dynamic = dynamics[i];
		if (dynamic.instances) {
			// :for structure — cleanup all rendered instances
			for (let j = 0, jLen = dynamic.instances.length; j < jLen; j++) {
				cleanupInstanceDirectives(dynamic.instances[j]);
			}
		}
		if (dynamic.activeInstance) {
			// :if structure — cleanup active branch
			cleanupInstanceDirectives(dynamic.activeInstance);
			if (dynamic.activeInstance.nestedDynamics) {
				cleanupDynamics(dynamic.activeInstance.nestedDynamics);
			}
		}
	}
}

/**
 * Cleanup directive instances on a single rendered instance (for/if).
 * @param {Object} instance - Rendered instance with optional directiveInstances array
 */
function cleanupInstanceDirectives(instance) {
	if (!instance.directiveInstances) return;
	for (let i = 0, len = instance.directiveInstances.length; i < len; i++) {
		try {
			const { el, directive, binding } = instance.directiveInstances[i];
			callDirectiveHook('unmounted', directive, el, binding);
			runElementCleanup(el);
		} catch (e) {
			logger.warn('Dynamic directive cleanup failed', e);
		}
	}
}

/**
 * Shared apply function for PROP and PROP_SYNC bindings.
 * Updates the child component's proxy if mounted, otherwise stores in _props.
 */
function applyPropValue(value, b) {
	if (b.node.component?.isMounted) {
		b.node._propUpdating = true;
		b.node.component.proxy[b.propName] = value;
		b.node._propUpdating = false;
	} else {
		if (!b.node._props) b.node._props = {};
		b.node._props[b.propName] = value;
	}
}

/**
 * Invoke a lifecycle hook with error handling for both sync and async results.
 * @param {Function} hook - Lifecycle hook function
 * @param {Object} proxy - Component proxy to use as `this`
 * @param {string} instanceId - Component instance ID for error messages
 * @param {string} hookName - Hook name for error messages (e.g., '$mounted')
 */
function invokeLifecycleHook(hook, proxy, instanceId, hookName) {
	try {
		const result = hook.call(proxy);
		if (result instanceof Promise) {
			result.catch(e => {
				logger.error(`[${instanceId}] Error in async ${hookName} hook`, e);
			});
		}
	} catch (e) {
		logger.error(`[${instanceId}] Error in ${hookName} hook`, e);
	}
}

class DzComponent extends HTMLElement {
	constructor() {
		super();

		// Create Shadow DOM
		this.attachShadow({ mode: 'open' });

		// Central component state (populated on mount, reset on unmount)
		this.component = {
			instanceId: `dz-${++instanceCounter}`,
			type: null,          // Component type name (for GC registration)
			isMounted: false,

			// Data
			proxy: null,         // Reactive data proxy (unified access to data/methods/computed)
			data: null,          // Raw data object

			// Functions
			method: null,        // Component methods
			computed: null,      // Computed properties

			// Lifecycle hooks (in order)
			onCreate: null,      // After proxy ready, before DOM (from def.$created)
			onMounted: null,     // After DOM rendered (from def.$mounted)
			onUpdate: null,      // After reactive update (from def.$updated)
			onUnmount: null,     // Before cleanup (from def.$unmounted)
			onError: null,       // Error handler (from def.$error)

			// Binding maps (for reactive updates)
			binding: null,       // { strings, code } - bytecode
			eval: null,          // Expression functions

			// DOM references
			root: null,          // Root element for path-based access
			dynamics: [],        // Active :for/:if block instances

			// Directives
			directives: [],      // [{el, directive, binding, prop}] for unmount cleanup
			_deferredMounts: []  // [{el, directive, binding}] for deferred mounted() calls
		};
	}

	/**
	 * Observed attributes - triggers attributeChangedCallback
	 */
	static get observedAttributes() {
		return ['dz-type'];
	}

	/**
	 * Called when element is added to DOM
	 */
	connectedCallback() {
		const type = this.getAttribute('dz-type');
		if (!type) return;

		// Check if we're inside another DzComponent's shadow root
		const rootNode = this.getRootNode();
		const isChild = rootNode instanceof ShadowRoot &&
		                rootNode.host instanceof DzComponent;

		if (isChild) {
			const parent = rootNode.host;
			if (parent.component.isMounted) {
				// Dynamic insertion (e.g., :if activated later) — parent already ready
				this.loadComponent(type);
			} else {
				// Parent still mounting — wait for signal
				rootNode.addEventListener('dz:children-init', () => {
					this.loadComponent(type);
				}, { once: true });
			}
			return;
		}

		// Root level — load immediately
		this.loadComponent(type);
	}

	/**
	 * Called when element is removed from DOM
	 */
	disconnectedCallback() {
		this.unmount();
	}

	/**
	 * Called when observed attributes change
	 */
	attributeChangedCallback(name, oldValue, newValue) {
		if (name !== 'dz-type') return;
		if (oldValue === newValue) return;

		// Type changed - reload component
		if (oldValue !== null) {
			this.unmount();
		}
		// Only load if connected — if not yet connected, connectedCallback handles it
		if (newValue && this.isConnected) {
			this.loadComponent(newValue);
		}
	}

	/**
	 * Load and mount a component by type
	 * @param {string} type - Component type name
	 */
	async loadComponent(type) {
		// Prevent double-loading and auto-retry after mount error
		if (this.component.isMounted || this._loading === type || this._mountError || hasError(this)) return;
		this._loading = type;

		logger.debug(`[${this.component.instanceId}] Loading component: ${type}`);

		// Show loading state
		this.shadowRoot.innerHTML = renderLoading(type);

		// Wait for component to be registered
		await componentRegistry.whenRegistered(type);

		// Guard: abort if removed from DOM while awaiting (zombie prevention)
		if (!this.isConnected) return;

		// Get component definition from registry
		const def = await componentRegistry.get(type);

		// Guard again after second await
		if (!this.isConnected) return;

		if (!def) {
			logger.error(`[${this.component.instanceId}] Component '${type}' not found in registry`);
			this.shadowRoot.innerHTML = `<div style="color:red">Component "${type}" not found</div>`;
			return;
		}

		this.mount(type, def);
	}

	/**
	 * Mount the component with a definition
	 * @param {string} type - Component type name
	 * @param {object} def - Compiled component definition
	 */
	async mount(type, def) {
		this.component.type = type;
		logger.debug(`[${this.component.instanceId}] Mounting component`);

	  try {
		// Step 1: Extract data & functions from def
		this.component.data = def.data ? def.data() : {};
		this.component.method = def.method || {};
		this.component.computed = def.computed || {};
		this.component.onCreate = validateHook(def.$created, '$created', type);
		this.component.onMounted = validateHook(def.$mounted, '$mounted', type);
		this.component.onUpdate = validateHook(def.$updated, '$updated', type);
		this.component.onUnmount = validateHook(def.$unmounted, '$unmounted', type);
		this.component.onError = validateHook(def.$error, '$error', type);
		this.component.binding = def.binding || { strings: [], code: new Uint16Array(0) };
		this.component.eval = def.eval || [];

		// Step 1.3: Inject parent props (stored on element by parent's PROP/PROP_SYNC bindings)
		if (this._props) {
			Object.assign(this.component.data, this._props);
		}

		// Step 1.4: Add $emit and $refs to component data
		this.component.data.$emit = (event, payload) => {
			this.dispatchEvent(new CustomEvent(event, {
				detail: payload, bubbles: false, composed: false
			}));
		};
		this.component.data.$refs = {};

		// Step 1.5: Inject route data if this component was created by the router
		if (this._routeParams) {
			this.component.data.$route = {
				params: this._routeParams,
				path: window.location.pathname
			};
		}

		// Step 1.7: Set up $slots from light DOM children
		if (def.slot && def.slot.length > 0) {
			this.component.data.$slots = this._resolveSlots(def.slot);
		}

		// Step 2: Create reactive proxy (with computed caching + watchers)
		const { proxy, manager } = createReactivity({
			data: this.component.data,
			methods: this.component.method,
			computed: this.component.computed,
			watch: def.watch || null
		});
		this.component.proxy = proxy;
		this.component._computedManager = manager;

		// Register $updated hook callback (microtask-coalesced, fires after isMounted)
		if (this.component.onUpdate) {
			registerUpdateCallback(this.component.data, () => {
				if (!this.component.isMounted) return;
				if (this._updateScheduled) return;
				this._updateScheduled = true;
				queueMicrotask(() => {
					this._updateScheduled = false;
					if (!this.component.isMounted || !this.component.onUpdate) return;
					invokeLifecycleHook(this.component.onUpdate, this.component.proxy, this.component.instanceId, '$updated');
				});
			});
		}

		// Step 2.5: Set up sync-emit bindings for synced props (child → parent)
		if (this._syncProps) {
			const syncKeys = Object.keys(this._syncProps);
			for (let i = 0, len = syncKeys.length; i < len; i++) {
				const propName = syncKeys[i];
				addBinding(this.component.proxy, propName, this, {
					type: 'prop-sync-emit',
					propName,
					applyFn: (value, b) => {
						if (b.node._propUpdating) return;
						b.node.dispatchEvent(new CustomEvent('dz:prop-sync', {
							detail: { prop: b.propName, value },
							bubbles: false, composed: false
						}));
					}
				});
			}
		}

		// Step 3: Call onCreate - await if async (fetch data before render)
		if (this.component.onCreate) {
			const result = this.component.onCreate.call(this.component.proxy);
			if (result instanceof Promise) {
				await result;
			}
		}

		// Step 4: Clear loading state
		this.shadowRoot.innerHTML = '';

		// Step 4.5: Parse template into temporary container
		const container = document.createElement('div');
		container.innerHTML = def.template;

		// Step 4.7: Inject styles via StyleSystem (order: slot → cascaded → component)
		renderStylesIntoShadow(
			this.shadowRoot,
			this._slotStyles || null,
			this._cascadedStyles || null,
			def.style || null
		);

		// Step 5: Move template nodes to shadow root
		const templateRoot = container.firstElementChild || container.firstChild;
		while (container.firstChild) {
			this.shadowRoot.appendChild(container.firstChild);
		}
		this.component.root = templateRoot;

		// Step 6: Apply bindings (initial render)
		// Variable-length bytecode: [type, pathLen, ...path, ...data]
		// EVAL types include deps: [type, pathLen, ...path, evalIdx, depsLen, ...depIndices]
		const { strings, code } = this.component.binding;

		let offset = 0;
		while (offset < code.length) {
			const bindingType = code[offset];
			const pathLen = code[offset + 1];

			// Extract path from bytecode
			const path = [];
			for (let i = 0; i < pathLen; i++) {
				path.push(code[offset + 2 + i]);
			}

			// Data starts after path
			const dataOffset = offset + 2 + pathLen;

			// Get node via tree path
			const bindNode = getNodeByPath(this.component.root, path);

			// Entry length will be calculated per-type (EVAL types have variable deps)
			let entryLen;

			if (bindNode) {
				switch (bindingType) {
					case BindingType.TEXT: {
						const propIdx = code[dataOffset];
						const prop = strings[propIdx];
						bindNode.textContent = this.component.proxy[prop];

						addBinding(this.component.proxy, prop, bindNode, {
							type: 'text',
							applyFn: applyText
						});
						entryLen = 2 + pathLen + 1;
						break;
					}
					case BindingType.TEXT_EVAL: {
						// Format: [type, pathLen, ...path, evalIdx, depsLen, ...depIndices]
						const evalIdx = code[dataOffset];
						const depsLen = code[dataOffset + 1];
						const evalFn = this.component.eval[evalIdx];
						bindNode.textContent = evalFn.call(this.component.proxy);

						// Register binding for each dependency (read from bytecode)
						for (let i = 0; i < depsLen; i++) {
							const depIdx = code[dataOffset + 2 + i];
							const dep = strings[depIdx];
							addBinding(this.component.proxy, dep, bindNode, {
								type: 'text-eval',
								evalFn,
								applyFn: (_, b) => { b.node.textContent = b.evalFn.call(this.component.proxy); }
							});
						}
						entryLen = 2 + pathLen + 2 + depsLen; // +2 for evalIdx, depsLen
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
							const value = this.component.proxy[prop];
							const dBinding = createDirectiveBinding(bindNode, value, { modifiers: parsed.modifiers });
							callDirectiveHook('created', directive, bindNode, dBinding);
							this.component.directives.push({ el: bindNode, directive, binding: dBinding, prop });
							this.component._deferredMounts.push({ el: bindNode, directive, binding: dBinding });

							if (directive.updated) {
								addBinding(this.component.proxy, prop, bindNode, {
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
							const value = this.component.proxy[prop];
							const isBool = typeof value === 'boolean';
							if (isBool) {
								if (value) bindNode.setAttribute(attr, '');
								else bindNode.removeAttribute(attr);
							} else {
								bindNode.setAttribute(attr, value);
							}
							addBinding(this.component.proxy, prop, bindNode, {
								type: 'attr',
								attributeName: attr,
								applyFn: isBool ? applyBoolAttr : applyAttr
							});
						}
						entryLen = 2 + pathLen + 2;
						break;
					}
					case BindingType.ATTR_EVAL: {
						// Format: [type, pathLen, ...path, attrIdx, evalIdx, depsLen, ...depIndices]
						const attrIdx = code[dataOffset];
						const evalIdx = code[dataOffset + 1];
						const depsLen = code[dataOffset + 2];
						const attr = strings[attrIdx];
						const evalFn = this.component.eval[evalIdx];

						const parsed = parseDirectiveName(attr);
						if (parsed) {
							const directive = getDirective(parsed.name);
							const value = evalFn.call(this.component.proxy);
							const dBinding = createDirectiveBinding(bindNode, value, { modifiers: parsed.modifiers });
							callDirectiveHook('created', directive, bindNode, dBinding);
							this.component.directives.push({ el: bindNode, directive, binding: dBinding });
							this.component._deferredMounts.push({ el: bindNode, directive, binding: dBinding });

							if (directive.updated) {
								for (let i = 0; i < depsLen; i++) {
									const depIdx = code[dataOffset + 3 + i];
									const dep = strings[depIdx];
									addBinding(this.component.proxy, dep, bindNode, {
										type: 'directive',
										directiveRef: directive,
										directiveBinding: dBinding,
										evalFn,
										applyFn: (_, b) => {
											b.directiveBinding.oldValue = b.directiveBinding.value;
											b.directiveBinding.value = b.evalFn.call(this.component.proxy);
											callDirectiveHook('updated', b.directiveRef, b.node, b.directiveBinding);
										}
									});
								}
							}
						} else {
							const evalValue = evalFn.call(this.component.proxy);
							const isBool = typeof evalValue === 'boolean';
							if (isBool) {
								if (evalValue) bindNode.setAttribute(attr, '');
								else bindNode.removeAttribute(attr);
							} else {
								bindNode.setAttribute(attr, evalValue);
							}
							for (let i = 0; i < depsLen; i++) {
								const depIdx = code[dataOffset + 3 + i];
								const dep = strings[depIdx];
								addBinding(this.component.proxy, dep, bindNode, {
									type: 'attr-eval',
									attributeName: attr,
									evalFn,
									applyFn: isBool
										? (_, b) => {
											const v = b.evalFn.call(this.component.proxy);
											if (v) b.node.setAttribute(b.attributeName, '');
											else b.node.removeAttribute(b.attributeName);
										}
										: (_, b) => { b.node.setAttribute(b.attributeName, b.evalFn.call(this.component.proxy)); }
								});
							}
						}
						entryLen = 2 + pathLen + 3 + depsLen; // +3 for attrIdx, evalIdx, depsLen
						break;
					}
					case BindingType.TWO_WAY: {
						const propIdx = code[dataOffset];
						const prop = strings[propIdx];
						bindNode.value = this.component.proxy[prop];

						bindNode.addEventListener('input', (e) => {
							this.component.proxy[prop] = e.target.value;
						});

						addBinding(this.component.proxy, prop, bindNode, {
							type: 'two-way',
							applyFn: applyValue
						});
						entryLen = 2 + pathLen + 1;
						break;
					}
					case BindingType.EVENT: {
						const eventConfigIdx = code[dataOffset + 1];
						const eventConfig = def.event[eventConfigIdx];
						const [eventName, methodName] = eventConfig;

						bindNode.addEventListener(eventName, (e) => {
							try { this.component.proxy[methodName](e); }
							catch (err) { logger.error(`Error in event handler ${methodName}`, err); }
						});
						entryLen = 2 + pathLen + 2;
						break;
					}
					case BindingType.PROP: {
						const propNameIdx = code[dataOffset];
						const sourceIdx = code[dataOffset + 1];
						const propName = strings[propNameIdx];
						const source = strings[sourceIdx];

						if (!bindNode._props) bindNode._props = {};
						bindNode._props[propName] = this.component.proxy[source];

						addBinding(this.component.proxy, source, bindNode, {
							type: 'prop',
							propName,
							applyFn: applyPropValue
						});
						entryLen = 2 + pathLen + 2;
						break;
					}
					case BindingType.PROP_SYNC: {
						const propNameIdx = code[dataOffset];
						const sourceIdx = code[dataOffset + 1];
						const propName = strings[propNameIdx];
						const source = strings[sourceIdx];

						if (!bindNode._props) bindNode._props = {};
						bindNode._props[propName] = this.component.proxy[source];

						if (!bindNode._syncProps) bindNode._syncProps = {};
						bindNode._syncProps[propName] = source;

						addBinding(this.component.proxy, source, bindNode, {
							type: 'prop',
							propName,
							applyFn: applyPropValue
						});

						bindNode.addEventListener('dz:prop-sync', (e) => {
							if (e.detail.prop === propName) {
								this.component.proxy[source] = e.detail.value;
							}
						});
						entryLen = 2 + pathLen + 2;
						break;
					}
					default:
						entryLen = 2 + pathLen + 1;
				}
			} else {
				// Node not found - still need to calculate entry length to advance
				entryLen = 2 + pathLen + getBindingDataLength(bindingType);
				if (bindingType === BindingType.TEXT_EVAL) {
					const depsLen = code[dataOffset + 1];
					entryLen += depsLen;
				} else if (bindingType === BindingType.ATTR_EVAL) {
					const depsLen = code[dataOffset + 2];
					entryLen += depsLen;
				}
			}

			offset += entryLen;
		}

		// Step 7.5: Process dynamics (:for, :if)
		if (def.dynamics && def.dynamics.length > 0) {
			this.processDynamics(def.dynamics);
		}

		// Step 7.8: Process refs (store child element references in $refs)
		if (def.refs && def.refs.length > 0) {
			for (let i = 0, len = def.refs.length; i < len; i++) {
				const ref = def.refs[i];
				const refNode = getNodeByPath(this.component.root, ref.path);
				if (refNode) {
					this.component.data.$refs[ref.name] = refNode;
				}
			}
		}

		// Step 7.7: Flush deferred directive mounted hooks
		for (let i = 0, len = this.component._deferredMounts.length; i < len; i++) {
			const { el, directive, binding } = this.component._deferredMounts[i];
			callDirectiveHook('mounted', directive, el, binding);
		}
		this.component._deferredMounts.length = 0;

		// Step 8: Call onMounted lifecycle hook (non-fatal — component already rendered)
		if (this.component.onMounted) {
			invokeLifecycleHook(this.component.onMounted, this.component.proxy, this.component.instanceId, '$mounted');
		}

		// Step 9: Register instance for GC
		componentRegistry.registerInstance(type, this.component.instanceId);

		this.component.isMounted = true;

		// Step 10: Signal child components to initialize (after isMounted = true)
		this.shadowRoot.dispatchEvent(new CustomEvent('dz:children-init'));

	  } catch (error) {
		this._mountError = true;
		handleComponentError(this, error, 'mount');
	  }
	}

	/**
	 * Process dynamic structures (:for, :if)
	 * Uses path-based access to get marker comment nodes
	 * @param {Array} dynamics - Dynamic definitions from compiled output
	 */
	processDynamics(dynamics) {
		// Pre-resolve ALL marker anchors before any rendering.
		// Rendering inserts DOM nodes which shifts childNodes indices,
		// so all paths must be resolved while the DOM is still pristine.
		const len = dynamics.length;
		const anchors = new Array(len);
		for (let i = 0; i < len; i++) {
			const mp = dynamics[i].markerPath;
			anchors[i] = mp ? getNodeByPath(this.component.root, mp) : null;
		}

		for (let r = 0; r < len; r++) {
			const dynamic = dynamics[r];
			const anchor = anchors[r];
			if (!anchor) {
				logger.warn('Marker not found for dynamic', dynamic);
				continue;
			}

			if (dynamic.type === 'for') {
				// Get source collection from proxy
				const collection = this.component.proxy[dynamic.source];
				if (collection) {
					const structure = {
						...dynamic,
						instances: [],
						anchor,
						parentProxy: this.component.proxy
					};
					renderForLoop(structure, collection, this.component.proxy, anchor);
					this.component.dynamics.push(structure);
				}
			} else if (dynamic.type === 'if') {
				const structure = {
					...dynamic,
					anchor,
					parentProxy: this.component.proxy,
					activeInstance: null,
					activeBranchIndex: -1,
					updateFn: () => updateConditional(structure, this.component.proxy)
				};
				renderConditional(structure, this.component.proxy, anchor);
				this.component.dynamics.push(structure);

				// Register with reactivity for each property used in conditions
				const deps = new Set();
				const chainItems = structure.chain;
				const dataKeySet = new Set(Object.keys(this.component.data));
				for (let j = 0, cLen = chainItems.length; j < cLen; j++) {
					if (chainItems[j].condition) {
						const identifiers = chainItems[j].condition.match(/[a-zA-Z_$][a-zA-Z0-9_$]*/g);
						if (identifiers) {
							for (let k = 0, kLen = identifiers.length; k < kLen; k++) {
								if (dataKeySet.has(identifiers[k])) {
									deps.add(identifiers[k]);
								}
							}
						}
					}
				}
				for (const dep of deps) {
					addDynamicStructure(this.component.proxy, dep, structure);
				}
			}
		}
	}

	/**
	 * Resolve which slots have content from light DOM children
	 * Checks host element's childNodes directly (not slot.assignedNodes)
	 * to avoid chicken-and-egg with conditional slot wrappers.
	 * @param {Array} slotDefs - Compiled slot metadata [{name, path, hasFallback}]
	 * @returns {Object} Map of slot names to boolean (has content)
	 */
	_resolveSlots(slotDefs) {
		const slots = {};
		const children = this.childNodes;

		const cLen = children.length;
		for (let s = 0, sLen = slotDefs.length; s < sLen; s++) {
			const slotDef = slotDefs[s];
			if (slotDef.name === 'default') {
				let hasDefault = false;
				for (let c = 0; c < cLen; c++) {
					const child = children[c];
					if (child.nodeType === 1 && (!child.hasAttribute('slot') || child.getAttribute('slot') === '')) {
						hasDefault = true;
						break;
					}
					if (child.nodeType === 3 && child.textContent.trim()) {
						hasDefault = true;
						break;
					}
				}
				slots.default = hasDefault;
			} else {
				let hasNamed = false;
				for (let c = 0; c < cLen; c++) {
					if (children[c].nodeType === 1 && children[c].getAttribute('slot') === slotDef.name) {
						hasNamed = true;
						break;
					}
				}
				slots[slotDef.name] = hasNamed;
			}
		}
		return slots;
	}

	/**
	 * Unmount and cleanup the component
	 */
	unmount() {
		if (!this.component.isMounted) return;

		logger.debug(`[${this.component.instanceId}] Unmounting component`);

		// Call onUnmount lifecycle hook (must not block cleanup — never await)
		if (this.component.onUnmount) {
			invokeLifecycleHook(this.component.onUnmount, this.component.proxy, this.component.instanceId, '$unmounted');
		}

		// Clear error state
		clearErrorState(this);

		// Cleanup directives (reverse order — try/catch so one failure doesn't block the rest)
		for (let i = this.component.directives.length - 1; i >= 0; i--) {
			try {
				const { el, directive, binding } = this.component.directives[i];
				callDirectiveHook('unmounted', directive, el, binding);
				runElementCleanup(el);
			} catch (e) {
				logger.warn(`[${this.component.instanceId}] Directive cleanup failed`, e);
			}
		}

		// Cleanup computed manager (removes from WeakMap registry)
		if (this.component._computedManager) {
			this.component._computedManager.destroy();
			this.component._computedManager = null;
		}

		// Unregister from registry for GC
		if (this.component.type) {
			componentRegistry.unregisterInstance(this.component.type, this.component.instanceId);
		}

		// Cleanup dynamics (:for/:if directive instances)
		if (this.component.dynamics.length > 0) {
			cleanupDynamics(this.component.dynamics);
		}

		// Clear props/sync state
		this._props = null;
		this._syncProps = null;
		this._propUpdating = false;

		// Clear Shadow DOM
		this.shadowRoot.innerHTML = '';

		// Reset component state (preserve instanceId)
		const instanceId = this.component.instanceId;
		this.component = {
			instanceId,
			type: null,
			isMounted: false,
			proxy: null,
			data: null,
			method: null,
			computed: null,
			onCreate: null,
			onMounted: null,
			onUpdate: null,
			onUnmount: null,
			onError: null,
			binding: null,
			eval: null,
			root: null,
			dynamics: [],
			directives: [],
			_deferredMounts: []
		};
	}
}

// Register the custom element
customElements.define('dz-component', DzComponent);

export default DzComponent;
