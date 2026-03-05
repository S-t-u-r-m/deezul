/**
 * main.js - Deezul Compiler Public API
 *
 * Main entry point for the component compiler.
 * Supports both template-only and full Deezul.Component({...}) files.
 *
 * Usage:
 *   import { compile, compileFile, compileComponent } from '@deezul/compiler';
 *
 *   // Template only
 *   const result = compile(templateString);
 *
 *   // Full component file
 *   const result = await compileComponentFile('./CounterCard.js');
 */

import { parseTemplate, walkAST } from './parser.js';
import { detectBindings, BIND_TYPE, HANDLER_TYPE } from './detector.js';
import { StringTable, buildStringTable } from './stringTable.js';
import { buildBytecode, decodeBytecodeEntry, iterateBytecode } from './bytecodeBuilder.js';
import { buildWatchMap, buildPackedWatchMap } from './watchMapBuilder.js';
import { generateEvalFunctions, generateEvalCode } from './evalExtractor.js';
import { splitDynamics, groupConditionalChains, extractDynamicTemplate, extractSourceProperties } from './dynamicSplitter.js';
import { generateCode, astToHTML } from './codegen.js';
import { parseComponent } from './scriptParser.js';
import { processStyles } from './styleProcessor.js';
import { processAST } from './processor.js';

import { readFile } from 'fs/promises';
import { basename, extname } from 'path';

/**
 * Compile a template string
 * @param {string} template - HTML template string
 * @param {object} options - Compilation options
 * @returns {object} Compilation result
 */
export function compile(template, options = {}) {
	const { componentName = 'Anonymous', optimized = true } = options;

	// 1. Parse template into AST
	const ast = parseTemplate(template);

	if (optimized) {
		// OPTIMIZED: Single-pass processing
		return compileOptimized(ast, componentName, options);
	}

	// LEGACY: Multi-pass processing (kept for debugging)
	return compileLegacy(ast, componentName, options);
}

/**
 * Optimized single-pass compilation
 */
function compileOptimized(ast, componentName, options) {
	// 1. Single pass: detect bindings, build strings, generate HTML
	const processed = processAST(ast);
	const { bindings, dynamics, slots, strings, stringMap, templateHTML } = processed;

	// 2. Build bytecode (uses pre-built string map for O(1) lookups)
	const { bytecode, evalFunctions, bindingCount } = buildBytecodeOptimized(bindings, strings, stringMap);

	// 3. Compile dynamic blocks
	const compiledDynamics = compileDynamicBlocksOptimized(dynamics, options);

	return {
		componentName,
		templateHTML,
		bytecode,
		strings,
		bindings,
		evalFunctions,
		dynamics: compiledDynamics,
		slots,
		bindingCount,
		stats: {
			bindingCount,
			stringCount: strings.length,
			bytecodeSize: bytecode.byteLength,
			dynamicCount: compiledDynamics.length,
			slotCount: slots.length
		}
	};
}

/**
 * Legacy multi-pass compilation (for debugging/comparison)
 */
function compileLegacy(ast, componentName, options) {
	// 2. Detect all bindings
	const detection = detectBindings(ast);
	const { bindings, dynamics, slots } = detection;

	// 3. Split dynamics into separate templates
	const { mainAST, dynamicBlocks } = splitDynamics(ast, dynamics);

	// 4. Build string table from main bindings
	const stringTable = buildStringTable(detection);

	// 5. Build bytecode
	const { bytecode, evalFunctions, bindingCount } = buildBytecode(bindings, stringTable);

	// 6. Generate template HTML from main AST
	const templateHTML = astToHTML(mainAST);

	// 7. Compile dynamic blocks recursively
	const compiledDynamics = compileDynamicBlocks(dynamicBlocks, options);

	return {
		componentName,
		templateHTML,
		bytecode,
		strings: stringTable.toArray(),
		bindings,
		evalFunctions,
		dynamics: compiledDynamics,
		slots,
		bindingCount,
		ast: mainAST,
		stats: {
			bindingCount,
			stringCount: stringTable.size,
			bytecodeSize: bytecode.byteLength,
			dynamicCount: compiledDynamics.length,
			slotCount: slots.length
		}
	};
}

/**
 * Optimized bytecode builder using pre-built string map
 * Uses variable-length bytecode format: [type, pathLen, ...path, ...data]
 *
 * EVAL bindings include dependency indices inline:
 * - TEXT_EVAL: [type, pathLen, ...path, evalIdx, depsLen, ...depIndices]
 * - ATTR_EVAL: [type, pathLen, ...path, attrIdx, evalIdx, depsLen, ...depIndices]
 */
function buildBytecodeOptimized(bindings, _strings, stringMap) {
	const evalFunctions = [];
	const evalMap = new Map();
	const bytecodeData = [];
	let eventConfigIdx = 0;

	for (const binding of bindings) {
		const path = binding.path || [];

		// Start with type and path
		const entry = [binding.type, path.length, ...path];

		switch (binding.type) {
			case BIND_TYPE.TEXT:
				entry.push(stringMap.get(binding.properties[0]) ?? -1);
				break;

			case BIND_TYPE.TEXT_EVAL: {
				// [type, pathLen, ...path, evalIdx, depsLen, ...depIndices]
				const evalIdx = addEvalFn(evalFunctions, evalMap, binding.expression);
				entry.push(evalIdx);
				// Add deps inline
				const deps = binding.properties || [];
				entry.push(deps.length);
				for (const dep of deps) {
					entry.push(stringMap.get(dep) ?? -1);
				}
				break;
			}

			case BIND_TYPE.ATTR:
				entry.push(stringMap.get(binding.attrName) ?? -1);
				entry.push(stringMap.get(binding.properties[0]) ?? -1);
				break;

			case BIND_TYPE.ATTR_EVAL: {
				// [type, pathLen, ...path, attrIdx, evalIdx, depsLen, ...depIndices]
				entry.push(stringMap.get(binding.attrName) ?? -1);
				const evalIdx = addEvalFn(evalFunctions, evalMap, binding.expression);
				entry.push(evalIdx);
				// Add deps inline
				const deps = binding.properties || [];
				entry.push(deps.length);
				for (const dep of deps) {
					entry.push(stringMap.get(dep) ?? -1);
				}
				break;
			}

			case BIND_TYPE.TWO_WAY:
				entry.push(stringMap.get(binding.properties[0]) ?? -1);
				break;

			case BIND_TYPE.EVENT:
				entry.push(stringMap.get(binding.eventName) ?? -1);
				entry.push(eventConfigIdx++);
				break;

			case BIND_TYPE.PROP:
			case BIND_TYPE.PROP_SYNC:
				entry.push(stringMap.get(binding.attrName) ?? -1);
				entry.push(stringMap.get(binding.properties[0]) ?? -1);
				break;

			default:
				continue;
		}

		bytecodeData.push(...entry);
	}

	return {
		bytecode: new Uint16Array(bytecodeData),
		evalFunctions,
		bindingCount: bindings.length
	};
}

function addEvalFn(evalFunctions, evalMap, expression) {
	if (evalMap.has(expression)) {
		return evalMap.get(expression);
	}
	const index = evalFunctions.length;
	// Just store expression - deps are embedded in bytecode
	evalFunctions.push({ expression });
	evalMap.set(expression, index);
	return index;
}

/**
 * Optimized dynamic blocks compilation
 * Compiles :for and :if/:else-if/:else blocks using the optimized path
 */
function compileDynamicBlocksOptimized(dynamics, options, startMarkerIndex = 0) {
	if (!dynamics || dynamics.length === 0) {
		return [];
	}

	// Group consecutive if/else-if/else into chains
	const grouped = groupConditionalChains(dynamics);
	const compiledBlocks = [];
	let markerIndex = startMarkerIndex;

	for (const group of grouped) {
		if (group.type === 'for') {
			// :for block
			const dynamic = group.items[0];
			compiledBlocks.push(compileForBlockOptimized(dynamic, markerIndex, options));
			markerIndex++;
		} else if (group.type === 'conditional') {
			// :if/:else-if/:else chain
			compiledBlocks.push(compileConditionalBlockOptimized(group.items, markerIndex, options));
			markerIndex++;
		}
	}

	return compiledBlocks;
}

/**
 * Compile a :for block using optimized path
 */
function compileForBlockOptimized(dynamic, markerIndex, options) {
	// Extract template node without :for attribute
	const templateNode = extractDynamicTemplate(dynamic.node);

	// Wrap in root for compilation
	const ast = { type: 'root', children: [templateNode] };

	// Compile using optimized single-pass (pass loop vars so dotted iterator access → TEXT_EVAL)
	const loopVars = new Set([dynamic.iteratorVar]);
	if (dynamic.indexVar) loopVars.add(dynamic.indexVar);
	const processed = processAST(ast, loopVars);
	const { bindings, dynamics: nestedDynamics, slots, strings, stringMap, templateHTML } = processed;

	// Build bytecode
	const { bytecode, evalFunctions, bindingCount } = buildBytecodeOptimized(bindings, strings, stringMap);

	// Recursively compile nested dynamics (nested blocks start at index 0)
	const compiledNestedDynamics = compileDynamicBlocksOptimized(nestedDynamics, options, 0);

	return {
		type: 'for',
		markerIndex,
		markerPath: dynamic.path,
		iteratorVar: dynamic.iteratorVar,
		indexVar: dynamic.indexVar,
		source: dynamic.source,
		sourceProperties: extractSourceProperties(dynamic.source),
		compiled: {
			templateHTML,
			bytecode,
			strings,
			bindings,
			evalFunctions,
			dynamics: compiledNestedDynamics,
			slots,
			bindingCount
		}
	};
}

/**
 * Compile a conditional block (:if/:else-if/:else chain) using optimized path
 */
function compileConditionalBlockOptimized(items, markerIndex, options) {
	const firstItem = items[0];
	const chain = [];

	for (const item of items) {
		// Extract template node without conditional attributes
		const templateNode = extractDynamicTemplate(item.node);

		// Wrap in root for compilation
		const ast = { type: 'root', children: [templateNode] };

		// Compile using optimized single-pass
		const processed = processAST(ast);
		const { bindings, dynamics: nestedDynamics, slots, strings, stringMap, templateHTML } = processed;

		// Build bytecode
		const { bytecode, evalFunctions, bindingCount } = buildBytecodeOptimized(bindings, strings, stringMap);

		// Recursively compile nested dynamics
		const compiledNestedDynamics = compileDynamicBlocksOptimized(nestedDynamics, options);

		const branch = {
			compiled: {
				templateHTML,
				bytecode,
				strings,
				bindings,
				evalFunctions,
				dynamics: compiledNestedDynamics,
				slots,
				bindingCount
			}
		};

		// Add condition for :if and :else-if (not :else)
		if (item.condition !== undefined) {
			branch.condition = item.condition;
			branch.properties = item.properties || [];
		}

		chain.push(branch);
	}

	return {
		type: 'conditional',
		markerIndex,
		markerPath: firstItem.path,
		chain
	};
}

/**
 * Compile a full Deezul.Component({...}) source
 * @param {string} source - Full JavaScript source code
 * @param {object} options - Compilation options
 * @returns {object} Full compilation result with script sections
 */
export function compileComponent(source, options = {}) {
	const { componentName = 'Anonymous', minifyStyles = true } = options;

	// 1. Parse the component file to extract sections
	const parsed = parseComponent(source);

	if (!parsed.template) {
		throw new Error('Component must have a template');
	}

	// 2. Compile the template
	const templateCompilation = compile(parsed.template, { componentName });

	// 3. Process styles if present - always minify by default
	let processedStyle = null;
	if (parsed.style) {
		const styleResult = processStyles(parsed.style, {
			shadow: true,  // Using Shadow DOM
			minify: minifyStyles
		});

		if (styleResult.errors.length > 0) {
			console.warn('Style processing warnings:', styleResult.errors);
		}

		processedStyle = styleResult.css;
	}

	// 4. Combine template compilation with script sections
	return {
		...templateCompilation,
		componentName,
		// Script sections (raw code strings for output)
		data: parsed.data,
		method: parsed.method,
		computed: parsed.computed,
		staticData: parsed.staticData,
		watcher: parsed.watcher,
		style: processedStyle,
		// Lifecycle hooks
		$created: parsed.$created,
		$mounted: parsed.$mounted,
		$updated: parsed.$updated,
		$unmounted: parsed.$unmounted,
		$error: parsed.$error,
		// Additional metadata
		hasData: !!parsed.data,
		hasMethods: !!parsed.method,
		hasComputed: !!parsed.computed,
		hasWatchers: !!parsed.watcher,
		hasStyles: !!parsed.style
	};
}

/**
 * Compile dynamic blocks (for, if/else-if/else)
 */
function compileDynamicBlocks(blocks, options) {
	return blocks.map(block => {
		if (block.type === 'for') {
			return compileForBlock(block, options);
		} else if (block.type === 'conditional') {
			return compileConditionalBlock(block, options);
		}
		return block;
	});
}

/**
 * Compile a :for block
 */
function compileForBlock(block, options) {
	const { templateNode, iteratorVar, indexVar, source, sourceProperties, markerIndex } = block;

	// Wrap template node in a root for compilation
	const ast = { type: 'root', children: [templateNode] };

	// Detect and compile template
	const detection = detectBindings(ast);
	const stringTable = buildStringTable(detection);
	const { bytecode, evalFunctions } = buildBytecode(detection.bindings, stringTable);

	return {
		type: 'for',
		iteratorVar,
		indexVar,
		source,
		sourceProperties,
		markerIndex,
		compiled: {
			templateHTML: astToHTML(ast),
			bytecode,
			strings: stringTable.toArray(),
			bindings: detection.bindings,
			evalFunctions
		}
	};
}

/**
 * Compile a conditional block (:if/:else-if/:else chain)
 */
function compileConditionalBlock(block, options) {
	const { chain, markerIndex } = block;

	const compiledChain = chain.map(branch => {
		const { templateNode, condition, properties } = branch;

		// Wrap template node in a root for compilation
		const ast = { type: 'root', children: [templateNode] };

		// Detect and compile template
		const detection = detectBindings(ast);
		const stringTable = buildStringTable(detection);
		const { bytecode, evalFunctions } = buildBytecode(detection.bindings, stringTable);

		const result = {
			compiled: {
				templateHTML: astToHTML(ast),
				bytecode,
				strings: stringTable.toArray(),
				bindings: detection.bindings,
				evalFunctions
			}
		};

		if (condition !== undefined) {
			result.condition = condition;
			result.properties = properties || [];
		}

		return result;
	});

	return {
		type: 'conditional',
		markerIndex,
		chain: compiledChain
	};
}

/**
 * Compile a template file (.html)
 * @param {string} filePath - Path to .html template file
 * @param {object} options - Compilation options
 * @returns {Promise<object>} Compilation result
 */
export async function compileFile(filePath, options = {}) {
	const content = await readFile(filePath, 'utf-8');
	const componentName = options.componentName || basename(filePath, extname(filePath));

	return compile(content, { ...options, componentName });
}

/**
 * Compile a full Deezul.Component file (.js)
 * @param {string} filePath - Path to component .js file
 * @param {object} options - Compilation options
 * @returns {Promise<object>} Full compilation result
 */
export async function compileComponentFile(filePath, options = {}) {
	const content = await readFile(filePath, 'utf-8');
	const componentName = options.componentName || basename(filePath, extname(filePath));

	return compileComponent(content, { ...options, componentName });
}

/**
 * Compile and generate output code (template only)
 * @param {string} template - Template string
 * @param {object} options - Compilation options
 * @returns {string} JavaScript module code
 */
export function compileToCode(template, options = {}) {
	const compilation = compile(template, options);
	return generateCode(compilation);
}

/**
 * Compile full component and generate output code
 * @param {string} source - Component source code
 * @param {object} options - Compilation options
 * @returns {string} JavaScript module code
 */
export function compileComponentToCode(source, options = {}) {
	const compilation = compileComponent(source, options);
	return generateCode(compilation);
}

/**
 * Compile file and generate output code
 * @param {string} filePath - Path to component file
 * @param {object} options - Compilation options
 * @returns {Promise<string>} JavaScript module code
 */
export async function compileFileToCode(filePath, options = {}) {
	const ext = extname(filePath).toLowerCase();

	if (ext === '.js') {
		const content = await readFile(filePath, 'utf-8');
		const componentName = options.componentName || basename(filePath, ext);
		return compileComponentToCode(content, { ...options, componentName });
	} else {
		const compilation = await compileFile(filePath, options);
		return generateCode(compilation);
	}
}

/**
 * Debug: dump compilation details
 * @param {object} compilation - Compilation result
 * @returns {string} Debug output
 */
export function dumpCompilation(compilation) {
	const lines = [];

	lines.push('=== Compilation Debug ===');
	lines.push(`Component: ${compilation.componentName}`);
	lines.push('');

	lines.push('--- Template ---');
	lines.push(compilation.templateHTML);
	lines.push('');

	lines.push('--- String Table ---');
	compilation.strings.forEach((s, i) => {
		lines.push(`  [${i}] "${s}"`);
	});
	lines.push('');

	lines.push('--- Bindings ---');
	let bindingIdx = 0;
	iterateBytecode(compilation.bytecode, compilation.strings, (entry) => {
		lines.push(`  [${bindingIdx++}] ${JSON.stringify(entry)}`);
	});
	lines.push('');

	lines.push('--- Eval Functions ---');
	compilation.evalFunctions.forEach((fn, i) => {
		// Deps are now embedded in bytecode, not in evalFunctions
		lines.push(`  [${i}] ${fn.expression}`);
	});
	lines.push('');

	lines.push('--- Script Sections ---');
	lines.push(`  Data: ${compilation.hasData ? 'yes' : 'no'}`);
	lines.push(`  Methods: ${compilation.hasMethods ? 'yes' : 'no'}`);
	lines.push(`  Computed: ${compilation.hasComputed ? 'yes' : 'no'}`);
	lines.push(`  Watchers: ${compilation.hasWatchers ? 'yes' : 'no'}`);
	lines.push(`  Styles: ${compilation.hasStyles ? 'yes' : 'no'}`);
	lines.push('');

	lines.push('--- Slots ---');
	if (compilation.slots && compilation.slots.length > 0) {
		compilation.slots.forEach((slot, i) => {
			lines.push(`  [${i}] name: "${slot.name}", nodeIndex: ${slot.nodeIndex}, hasFallback: ${slot.hasFallback}`);
		});
	} else {
		lines.push('  (none)');
	}
	lines.push('');

	lines.push('--- Stats ---');
	lines.push(`  Bindings: ${compilation.stats.bindingCount}`);
	lines.push(`  Strings: ${compilation.stats.stringCount}`);
	lines.push(`  Bytecode: ${compilation.stats.bytecodeSize} bytes`);
	lines.push(`  Dynamics: ${compilation.stats.dynamicCount}`);
	lines.push(`  Slots: ${compilation.stats.slotCount || 0}`);

	return lines.join('\n');
}

// Re-export utilities
export {
	parseTemplate,
	walkAST,
	detectBindings,
	BIND_TYPE,
	HANDLER_TYPE,
	StringTable,
	buildStringTable,
	buildBytecode,
	decodeBytecodeEntry,
	iterateBytecode,
	buildWatchMap,
	generateCode,
	astToHTML,
	parseComponent,
	processStyles
};

export default {
	compile,
	compileFile,
	compileToCode,
	compileFileToCode,
	compileComponent,
	compileComponentFile,
	compileComponentToCode,
	dumpCompilation,
	// Constants
	BIND_TYPE,
	HANDLER_TYPE
};
