/**
 * dynamicSplitter.js - Dynamic Template Splitter
 *
 * Extracts :for and :if/:else-if/:else blocks into separate templates.
 * Each dynamic block gets its own bytecode and watch map since it may
 * be rendered multiple times (:for) or conditionally (:if).
 *
 * The main template gets placeholders (comment nodes) where dynamics go.
 * At runtime, the dynamic processor handles cloning and insertion.
 *
 * Output structure:
 * {
 *   mainTemplate: { ... },     // Template with dynamics replaced by markers
 *   dynamics: [                // Array of dynamic block definitions
 *     {
 *       type: 'for',
 *       iteratorVar: 'item',
 *       indexVar: 'i',
 *       source: 'items',
 *       template: { ... },     // Compiled template for this block
 *       markerIndex: 0         // Index of placeholder in main template
 *     },
 *     {
 *       type: 'if',
 *       chain: [
 *         { condition: 'active', template: { ... } },
 *         { condition: 'pending', template: { ... } },  // else-if
 *         { template: { ... } }                          // else
 *       ],
 *       markerIndex: 1
 *     }
 *   ]
 * }
 */

import { DYNAMIC_TYPE } from './detector.js';

/**
 * Split AST into main template and dynamic templates
 * @param {object} ast - Full AST from parser
 * @param {object[]} dynamics - Dynamic descriptors from detector
 * @returns {object} Split result with main and dynamic templates
 */
export function splitDynamics(ast, dynamics) {
	if (dynamics.length === 0) {
		return {
			mainAST: ast,
			dynamicBlocks: []
		};
	}

	// Group dynamics by their chains (if/else-if/else)
	const grouped = groupConditionalChains(dynamics);

	// Clone AST - we'll modify this copy
	const mainAST = cloneAST(ast);

	// Build a nodeIndex -> node map for the cloned AST
	const nodeMap = buildNodeMap(mainAST);

	const dynamicBlocks = [];
	let markerIndex = 0;

	// Collect node indices to remove (for conditional chains)
	const nodesToRemove = new Set();

	for (const group of grouped) {
		if (group.type === 'for') {
			// :for - single dynamic block
			const dynamic = group.items[0];
			const targetNode = nodeMap.get(pathKey(dynamic.path));

			if (targetNode) {
				dynamicBlocks.push({
					type: 'for',
					iteratorVar: dynamic.iteratorVar,
					indexVar: dynamic.indexVar,
					source: dynamic.source,
					sourceProperties: extractSourceProperties(dynamic.source),
					templateNode: extractDynamicTemplate(dynamic.node),
					markerIndex,
					markerPath: dynamic.path, // Store path for marker
					_targetPath: dynamic.path
				});
				markerIndex++;
			}
		} else if (group.type === 'conditional') {
			// :if/:else-if/:else chain
			const chain = [];
			const firstItem = group.items[0];

			for (const item of group.items) {
				const chainItem = {
					templateNode: extractDynamicTemplate(item.node)
				};

				if (item.type === DYNAMIC_TYPE.IF || item.type === DYNAMIC_TYPE.ELSE_IF) {
					chainItem.condition = item.condition;
					chainItem.properties = item.properties || [];
				}
				// :else has no condition

				chain.push(chainItem);

				// Mark non-first nodes for removal
				if (item !== firstItem) {
					nodesToRemove.add(pathKey(item.path));
				}
			}

			dynamicBlocks.push({
				type: 'conditional',
				chain,
				markerIndex,
				markerPath: firstItem.path, // Store path for marker
				_targetPath: firstItem.path
			});
			markerIndex++;
		}
	}

	// Now apply replacements to the cloned AST
	// First remove marked nodes
	for (const pathKeyStr of nodesToRemove) {
		const node = nodeMap.get(pathKeyStr);
		if (node) {
			removeNodeFromParent(mainAST, node);
		}
	}

	// Then replace target nodes with markers
	for (const block of dynamicBlocks) {
		const targetNode = nodeMap.get(pathKey(block._targetPath));
		if (targetNode) {
			const marker = createMarker(block.type === 'for' ? 'for' : 'if', block.markerIndex);
			replaceNodeInParent(mainAST, targetNode, marker);
		}
		delete block._targetPath; // Clean up internal property
	}

	return {
		mainAST,
		dynamicBlocks
	};
}

/**
 * Build a map of path -> node for the AST
 * Path is stringified for use as map key
 */
function buildNodeMap(ast) {
	const map = new Map();

	function walk(node, path = []) {
		if (node.type === 'root') {
			// Process children with indices
			if (node.children) {
				for (let i = 0; i < node.children.length; i++) {
					walk(node.children[i], [i]);
				}
			}
		} else {
			// Store node by path key
			map.set(path.join(','), node);

			if (node.children) {
				for (let i = 0; i < node.children.length; i++) {
					walk(node.children[i], [...path, i]);
				}
			}
		}
	}

	walk(ast);
	return map;
}

/**
 * Get path key string from path array
 */
function pathKey(path) {
	return path.join(',');
}

/**
 * Remove a node from its parent in the AST
 */
function removeNodeFromParent(ast, targetNode) {
	function walk(node) {
		if (!node.children) return false;

		const idx = node.children.indexOf(targetNode);
		if (idx !== -1) {
			node.children.splice(idx, 1);
			return true;
		}

		for (const child of node.children) {
			if (walk(child)) return true;
		}
		return false;
	}

	walk(ast);
}

/**
 * Replace a node with another in the AST
 */
function replaceNodeInParent(ast, targetNode, replacement) {
	function walk(node) {
		if (!node.children) return false;

		const idx = node.children.indexOf(targetNode);
		if (idx !== -1) {
			node.children[idx] = replacement;
			return true;
		}

		for (const child of node.children) {
			if (walk(child)) return true;
		}
		return false;
	}

	walk(ast);
}

/**
 * Group consecutive :if/:else-if/:else into chains
 * @param {object[]} dynamics - Dynamic descriptors
 * @returns {object[]} Grouped dynamics
 */
function groupConditionalChains(dynamics) {
	const groups = [];
	let currentChain = null;

	// Sort dynamics by position
	const sorted = [...dynamics].sort((a, b) => a.position - b.position);

	for (const dynamic of sorted) {
		const dynamicType = getDynamicType(dynamic.type);

		if (dynamicType === 'for') {
			// :for is standalone
			if (currentChain) {
				groups.push(currentChain);
				currentChain = null;
			}
			groups.push({ type: 'for', items: [dynamic] });
		} else if (dynamicType === 'if') {
			// Start new conditional chain
			if (currentChain) {
				groups.push(currentChain);
			}
			currentChain = { type: 'conditional', items: [dynamic] };
		} else if (dynamicType === 'else-if' || dynamicType === 'else') {
			// Continue conditional chain
			if (currentChain && currentChain.type === 'conditional') {
				currentChain.items.push(dynamic);
			} else {
				// Orphan else-if/else - treat as conditional with just this branch
				console.warn(`Orphan :${dynamicType} found without :if`);
				currentChain = { type: 'conditional', items: [dynamic] };
			}

			// :else ends the chain
			if (dynamicType === 'else') {
				groups.push(currentChain);
				currentChain = null;
			}
		}
	}

	if (currentChain) {
		groups.push(currentChain);
	}

	return groups;
}

/**
 * Get string type name from DYNAMIC_TYPE constant
 */
function getDynamicType(type) {
	switch (type) {
		case DYNAMIC_TYPE.FOR: return 'for';
		case DYNAMIC_TYPE.IF: return 'if';
		case DYNAMIC_TYPE.ELSE_IF: return 'else-if';
		case DYNAMIC_TYPE.ELSE: return 'else';
		default: return 'unknown';
	}
}

/**
 * Create a marker node to replace dynamic content
 */
function createMarker(type, index) {
	return {
		type: 'comment',
		content: `dz:${type}:${index}`,
		isDynamicMarker: true,
		markerIndex: index
	};
}

/**
 * Extract template from dynamic node (clone without :for/:if attrs)
 */
function extractDynamicTemplate(node) {
	const clone = cloneNode(node);

	// Remove dynamic directives from attributes
	if (clone.attributes) {
		delete clone.attributes[':for'];
		delete clone.attributes[':if'];
		delete clone.attributes[':else-if'];
		delete clone.attributes[':else'];
	}

	return clone;
}

/**
 * Extract properties from :for source expression
 * "items" -> ["items"]
 * "getItems()" -> []
 * "user.items" -> ["user"]
 */
function extractSourceProperties(source) {
	const trimmed = source.trim();

	// Skip if it's a function call
	if (trimmed.includes('(')) {
		return [];
	}

	// Get root property
	const root = trimmed.split(/[.\[]/)[0];

	// Skip keywords
	const keywords = new Set(['true', 'false', 'null', 'undefined']);
	if (keywords.has(root)) {
		return [];
	}

	return [root];
}

/**
 * Deep clone an AST
 */
function cloneAST(ast) {
	return cloneNode(ast);
}

/**
 * Deep clone a node
 */
function cloneNode(node) {
	if (node === null || typeof node !== 'object') {
		return node;
	}

	if (Array.isArray(node)) {
		return node.map(cloneNode);
	}

	const clone = {};
	for (const key in node) {
		if (key === 'children') {
			clone.children = node.children.map(cloneNode);
		} else if (key === 'attributes') {
			clone.attributes = { ...node.attributes };
		} else {
			clone[key] = node[key];
		}
	}
	return clone;
}

/**
 * Find siblings immediately following a node (for else-if/else detection)
 */
export function findFollowingSiblings(ast, node) {
	const siblings = [];

	function walk(parent) {
		if (!parent.children) return false;

		for (let i = 0; i < parent.children.length; i++) {
			if (parent.children[i] === node) {
				// Found the node, collect following siblings
				for (let j = i + 1; j < parent.children.length; j++) {
					siblings.push(parent.children[j]);
				}
				return true;
			}
			if (walk(parent.children[i])) return true;
		}
		return false;
	}

	walk(ast);
	return siblings;
}

// Export individual functions for optimized path
export {
	groupConditionalChains,
	extractDynamicTemplate,
	extractSourceProperties,
	cloneNode
};

export default {
	splitDynamics,
	groupConditionalChains,
	findFollowingSiblings,
	extractDynamicTemplate,
	extractSourceProperties,
	cloneNode
};
