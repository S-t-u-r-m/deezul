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
import createReactivity, { addBinding, addDynamicStructure, registerUpdateCallback, unregisterUpdateCallback, removeBinding } from './Reactivity.js';
import {
	forLoopReconcile, renderForLoop, renderConditional, updateConditional,
	teardownStructure, decodeBindingDescs, applyDescsToTree, ensureForStamp
} from './render.js';
import { callDirectiveHook, runElementCleanup } from './Directives.js';
import { handleComponentError, clearErrorState, hasError } from './ErrorBoundary.js';
import { renderStylesIntoShadow, adoptGlobalStyles } from './StyleSystem.js';
import { renderLoading } from './LibraryComponents.js';
import { getNodeByPath, resolveDottedPath } from './constants.js';
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
			bindings: null,      // Registered addBinding entries (removed on unmount)

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

		// Guard: abort if removed from DOM while awaiting (zombie prevention).
		// _loading must be cleared on every exit path so a later reconnect
		// (disconnectedCallback + connectedCallback fire even on a DOM move)
		// can mount again.
		if (!this.isConnected) {
			this._loading = null;
			return;
		}

		// Get component definition from registry
		const def = await componentRegistry.get(type);

		// Guard again after second await
		if (!this.isConnected) {
			this._loading = null;
			return;
		}

		if (!def) {
			logger.error(`[${this.component.instanceId}] Component '${type}' not found in registry`);
			this.shadowRoot.innerHTML = `<div style="color:red">Component "${type}" not found</div>`;
			this._loading = null;
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

		// Step 1.3: Inject parent props (stored on element by parent's PROP/PROP_SYNC bindings).
		//
		// Prop contract: bare `:prop` is ISOLATED one-way — primitives copy
		// down, objects arrive as deep clones (re-cloned on every parent
		// push), so a child can never mutate parent state through a prop;
		// it emits events to request changes. `:prop.share` is LIVE — the
		// parent's object by reference, primitives kept in sync both ways
		// through the dz:prop-sync bridge.
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
		if (this._routeParams || this._routeQuery) {
			this.component.data.$route = {
				params: this._routeParams || {},
				query: this._routeQuery || {},
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
				// Guard: element may have been removed while $created was
				// fetching. Without this, mount would finish on a detached
				// element, set isMounted AFTER disconnectedCallback already
				// no-op'd, and leak the manager + registry instance count.
				if (!this.isConnected) {
					if (this.component._computedManager) {
						this.component._computedManager.destroy();
						this.component._computedManager = null;
					}
					unregisterUpdateCallback(this.component.data);
					this._loading = null;
					return;
				}
			}
		}

		// Step 4: Clear loading state
		this.shadowRoot.innerHTML = '';

		// Step 4.5: Parse template and move children into the shadow root. The shadow
		// root is the natural container — the host <dz-component> element already wraps
		// it — so we don't introduce an artificial wrapper element. Paths emitted by
		// the compiler are sibling-indexed against this root, whether the user's
		// template has one top-level element or many.
		const tpl = document.createElement('template');
		tpl.innerHTML = def.template;
		this.shadowRoot.append(tpl.content);

		// Step 4.7: Inject styles via StyleSystem (order: slot → cascaded → component).
		// Appended after template content; CSS cascade is determined by source order
		// among the <style> elements themselves, not their position relative to other
		// shadow-tree nodes, so this is safe and keeps template paths starting at index 0.
		renderStylesIntoShadow(
			this.shadowRoot,
			this._slotStyles || null,
			this._cascadedStyles || null,
			def.style || null
		);

		// Adopt any globally-registered stylesheets (Deezul.addGlobalStyles) so a
		// shared CSS library reaches inside every component's shadow root.
		adoptGlobalStyles(this.shadowRoot);

		this.component.root = this.shadowRoot;

		// Step 6: Apply bindings (initial render).
		// The bytecode is decoded once per component TYPE (cached on the def)
		// and applied per instance via the shared tree applier — the same
		// decode/apply pair used by :for rows and :if chain items.
		if (!def._descs) {
			def._descs = decodeBindingDescs(this.component.binding, this.component.eval, def.event);
		}
		const applied = applyDescsToTree(this.component.root, def._descs, this.component.proxy);
		this.component.bindings = applied.bindings;
		this.component.directives = applied.directiveInstances;
		this.component._deferredMounts = applied.deferredMounts;

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
		this._loading = null;

		// Step 10: Signal child components to initialize (after isMounted = true)
		this.shadowRoot.dispatchEvent(new CustomEvent('dz:children-init'));

	  } catch (error) {
		this._mountError = true;
		this._loading = null;
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

		// Built lazily on first :if encounter — most components have no :if blocks.
		let dataKeySet = null;

		for (let r = 0; r < len; r++) {
			const dynamic = dynamics[r];
			const anchor = anchors[r];
			if (!anchor) {
				logger.warn('Marker not found for dynamic', dynamic);
				continue;
			}

			if (dynamic.type === 'for') {
				// Resolve source collection via pre-compiled accessor (preferred) or dotted-path fallback
				const resolveSource = dynamic.sourceFn
					? () => dynamic.sourceFn.call(this.component.proxy)
					: () => resolveDottedPath(this.component.proxy, dynamic.source);
				const collection = resolveSource();
				if (collection) {
					// Stamp/descs cached on the def — shared across instances
					// of this component type; the spread carries them over.
					ensureForStamp(dynamic);
					const structure = {
						...dynamic,
						instances: [],
						anchor,
						parentProxy: this.component.proxy
					};
					structure.updateFn = () => {
						const newCollection = resolveSource();
						if (Array.isArray(newCollection)) forLoopReconcile(structure, newCollection);
					};
					renderForLoop(structure, collection, this.component.proxy, anchor);
					this.component.dynamics.push(structure);
					// Track reassignments on source base property
					const baseProp = dynamic.sourceBase
						|| (dynamic.source && dynamic.source.indexOf('.') !== -1 ? dynamic.source.substring(0, dynamic.source.indexOf('.')) : null);
					if (baseProp) {
						addDynamicStructure(this.component.data, baseProp, structure);
					}
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

				// Register with reactivity for each data-side identifier used in any
				// condition (compiler pre-extracted the union into structure.deps).
				// Includes both plain data keys AND computed property names — a
				// condition like `:if="hasSelectedEntity"` depends on a computed,
				// not a raw data key, and still needs to re-run when ITS dependency
				// changes; ComputedManager.invalidate already notifies dynamics
				// registered under the computed's name (same applyDynamicsFn path
				// as a plain data change), so registering here is sufficient.
				// dataKeySet is hoisted across all :if structures in this component.
				if (!dataKeySet) {
					dataKeySet = new Set(Object.keys(this.component.data));
					if (this.component.computed) {
						for (const key of Object.keys(this.component.computed)) dataKeySet.add(key);
					}
				}
				const ids = structure.deps || [];
				for (let k = 0, kLen = ids.length; k < kLen; k++) {
					if (dataKeySet.has(ids[k])) {
						addDynamicStructure(this.component.proxy, ids[k], structure);
					}
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

		// Remove registered bindings from the reactivity maps. Bindings on the
		// component's own data would be GC'd with it, but two-way/dotted
		// bindings can target long-lived shared objects — without explicit
		// removal those entries accumulate across mount/unmount cycles.
		if (this.component.bindings) {
			for (let i = 0, len = this.component.bindings.length; i < len; i++) {
				removeBinding(this.component.bindings[i]);
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

		// Cleanup dynamics: tear down each top-level :for/:if and recurse into
		// their rendered instances. teardownStructure (a) unmounts directives at
		// every level, (b) unregisters the top-level structure from the
		// Reactivity maps (forLoopMap / dataBindMap) so stale updateFn callbacks
		// don't fire on dead DOM after this component is gone. Previous
		// cleanupDynamics() only handled directives — leaked the registrations.
		const dynamics = this.component.dynamics;
		for (let i = 0, len = dynamics.length; i < len; i++) {
			teardownStructure(dynamics[i]);
		}

		// Drop the $updated callback so its closure (which captures `this`)
		// becomes immediately GC-eligible rather than lingering in the
		// onUpdateCallbacks WeakMap until the next Major GC collects the
		// now-unreferenced data target.
		if (this.component.data) {
			unregisterUpdateCallback(this.component.data);
		}

		// Clear props/sync state. _loading is reset so a reconnect (DOM moves
		// fire disconnected + connected callbacks) can mount again.
		this._props = null;
		this._syncProps = null;
		this._propUpdating = false;
		this._loading = null;

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
			bindings: null,
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
