#!/usr/bin/env node
/**
 * cli.js - Deezul Compiler CLI
 *
 * Command-line interface for compiling Deezul components.
 *
 * Usage:
 *   deezul-compile <input> [output]     Compile a component file
 *   deezul-compile --watch <dir>        Watch directory for changes
 *   deezul-compile --help               Show help
 *
 * Examples:
 *   deezul-compile src/counter.html dist/counter.compiled.js
 *   deezul-compile src/components --out dist/compiled
 *   deezul-compile --watch src/components --out dist/compiled
 */

import { compileFile, compileFileToCode, dumpCompilation } from '../library/main.js';
import { buildManifest } from '../../build/manifest.js';
import { isComponentSource } from '../library/scriptParser.js';
import { readFile, writeFile, readdir, stat, mkdir } from 'fs/promises';
import { watch } from 'chokidar';
import { join, basename, extname, dirname, resolve, relative } from 'path';
import { existsSync } from 'fs';

const VERSION = '1.0.0';

/**
 * Parse command line arguments
 */
function parseArgs(argv) {
	const args = {
		input: null,
		output: null,
		watch: false,
		debug: false,
		help: false,
		version: false,
		extension: '.compiled.js',
		styles: []
	};

	let i = 2; // Skip node and script path
	while (i < argv.length) {
		const arg = argv[i];

		if (arg === '--help' || arg === '-h') {
			args.help = true;
		} else if (arg === '--version' || arg === '-v') {
			args.version = true;
		} else if (arg === '--watch' || arg === '-w') {
			args.watch = true;
		} else if (arg === '--debug' || arg === '-d') {
			args.debug = true;
		} else if (arg === '--out' || arg === '-o') {
			args.output = argv[++i];
		} else if (arg === '--ext') {
			args.extension = argv[++i];
		} else if (arg === '--styles' || arg === '-s') {
			args.styles.push(argv[++i]);
		} else if (!arg.startsWith('-')) {
			if (!args.input) {
				args.input = arg;
			} else if (!args.output) {
				args.output = arg;
			}
		}

		i++;
	}

	return args;
}

/**
 * Show help message
 */
function showHelp() {
	console.log(`
Deezul Component Compiler v${VERSION}

Usage:
  deezul-compile <input> [output]       Compile a component file
  deezul-compile <dir> --out <outdir>   Compile all components in directory
  deezul-compile --watch <dir>          Watch for changes

Options:
  -h, --help      Show this help message
  -v, --version   Show version number
  -w, --watch     Watch for file changes
  -o, --out       Output directory
  -d, --debug     Show debug output
  -s, --styles    Shared CSS file (can be specified multiple times)
  --ext           Output file extension (default: .compiled.js)

Examples:
  deezul-compile src/counter.html
  deezul-compile src/counter.html dist/counter.compiled.js
  deezul-compile src/components --out dist/compiled
  deezul-compile --watch src/components --out dist/compiled
  deezul-compile src/components --out dist/compiled --styles css/theme.css
`);
}

/**
 * Compile a single file
 */
async function compileSingleFile(inputPath, outputPath, options = {}) {
	const { debug, sharedStyles = [], knownRefs = null } = options;

	try {
		console.log(`Compiling: ${inputPath}`);

		const compilation = await compileFile(inputPath, { sharedStyles, knownRefs });

		if (debug) {
			console.log(dumpCompilation(compilation));
		}

		const code = await compileFileToCode(inputPath, { sharedStyles, knownRefs });

		// Ensure output directory exists
		const outDir = dirname(outputPath);
		if (!existsSync(outDir)) {
			await mkdir(outDir, { recursive: true });
		}

		await writeFile(outputPath, code, 'utf-8');

		console.log(`  -> ${outputPath}`);
		console.log(`     ${compilation.stats.bindingCount} bindings, ${compilation.stats.bytecodeSize} bytes`);

		return { success: true, inputPath, outputPath, stats: compilation.stats };
	} catch (error) {
		console.error(`Error compiling ${inputPath}:`, error.message);
		if (debug) {
			console.error(error.stack);
		}
		return { success: false, inputPath, error: error.message };
	}
}

/**
 * Compile all files in a directory
 */
async function compileDirectory(inputDir, outputDir, options = {}) {
	const { extension = '.compiled.js', debug, sharedStyles = [], knownRefs = null } = options;
	const results = [];

	async function processDir(dir, outDir) {
		const entries = await readdir(dir, { withFileTypes: true });

		for (const entry of entries) {
			const inputPath = join(dir, entry.name);

			if (entry.isDirectory()) {
				// Recurse into subdirectory
				await processDir(inputPath, join(outDir, entry.name));
			} else if (entry.isFile() && await isCompilable(inputPath)) {
				// Compile template file
				const outputName = basename(entry.name, extname(entry.name)) + extension;
				const outputPath = join(outDir, outputName);

				const result = await compileSingleFile(inputPath, outputPath, { debug, sharedStyles, knownRefs });
				results.push(result);
			}
		}
	}

	await processDir(inputDir, outputDir);
	return results;
}

/** Extensions worth opening at all. `.js` is what a component actually is. */
const COMPILABLE_EXTENSIONS = new Set(['.js', '.mjs', '.html', '.dz', '.template']);

/**
 * Is this a file the compiler should compile?
 *
 * A component is a .js file whose source calls Deezul.Component -- which is what the
 * dev server and the build both test, via isComponentSource. This used to accept only
 * .html, .dz and .template: extensions from an era of custom component files, none of
 * which a deezul component has ever used. The effect was that `deezul-compile <dir>`
 * walked a source tree, matched nothing, and reported "Compiled 0 files" as a success.
 *
 * Reading the file to decide is why this is async. The legacy extensions still pass on
 * their name alone, in case anything out there still uses them.
 *
 * @param {string} path - full path to the file
 * @returns {Promise<boolean>}
 */
async function isCompilable(path) {
	const ext = extname(path).toLowerCase();
	if (!COMPILABLE_EXTENSIONS.has(ext)) return false;
	if (ext !== '.js' && ext !== '.mjs') return true;
	// A compiled component is itself a .js file with no Deezul.Component call, so
	// re-running the compiler over its own output skips it rather than failing on it.
	try {
		return isComponentSource(await readFile(path, 'utf-8'));
	} catch {
		return false;
	}
}

/**
 * Get output path for an input file
 */
function getOutputPath(inputPath, outputDir, extension) {
	const name = basename(inputPath, extname(inputPath));
	return join(outputDir, name + extension);
}

/**
 * Watch mode - recompile on changes
 */
async function watchMode(inputDir, outputDir, options = {}) {
	const { extension = '.compiled.js', debug, sharedStyles = [], knownRefs = null } = options;

	console.log(`Watching ${inputDir} for changes...`);
	console.log(`Output: ${outputDir}`);
	console.log('Press Ctrl+C to stop\n');

	// Initial compile
	await compileDirectory(inputDir, outputDir, options);

	// Watch for changes
	const watcher = watch(inputDir, {
		ignored: /(^|[\/\\])\../, // ignore dotfiles
		persistent: true,
		ignoreInitial: true
	});

	watcher.on('add', async (filePath) => {
		if (await isCompilable(filePath)) {
			console.log(`\nFile added: ${filePath}`);
			const outputPath = getOutputPath(filePath, outputDir, extension);
			await compileSingleFile(filePath, outputPath, { debug, sharedStyles, knownRefs });
		}
	});

	watcher.on('change', async (filePath) => {
		if (await isCompilable(filePath)) {
			console.log(`\nFile changed: ${filePath}`);
			const relPath = relative(inputDir, filePath);
			const outputPath = join(outputDir, dirname(relPath), basename(relPath, extname(relPath)) + extension);
			await compileSingleFile(filePath, outputPath, { debug, sharedStyles, knownRefs });
		}
	});

	// The file is already gone by now, so this decides on the name alone -- isCompilable
	// would have to read it.
	watcher.on('unlink', (filePath) => {
		if (COMPILABLE_EXTENSIONS.has(extname(filePath).toLowerCase())) {
			console.log(`\nFile removed: ${filePath}`);
			// Optionally delete compiled file
		}
	});

	watcher.on('error', (error) => {
		console.error('Watcher error:', error);
	});

	// Keep process running
	process.on('SIGINT', () => {
		console.log('\nStopping watcher...');
		watcher.close();
		process.exit(0);
	});
}

/**
 * Main entry point
 */
async function main() {
	const args = parseArgs(process.argv);

	if (args.version) {
		console.log(`v${VERSION}`);
		return;
	}

	if (args.help || !args.input) {
		showHelp();
		return;
	}

	const inputPath = resolve(args.input);

	// Load shared stylesheets
	const sharedStyles = [];
	for (const stylePath of args.styles) {
		const resolved = resolve(stylePath);
		try {
			const css = await readFile(resolved, 'utf-8');
			sharedStyles.push(css);
			console.log(`Loaded shared styles: ${stylePath}`);
		} catch (err) {
			console.error(`Error loading shared styles ${stylePath}: ${err.message}`);
			process.exit(1);
		}
	}

	try {
		const inputStat = await stat(inputPath);

		// The project's component refs, from the same walk the dev server and the build
		// use. A component's own tag is rewritten into its host element, and an unknown
		// tag is reported -- both need to know what the project registers, so all three
		// entry points derive it the same way rather than one of them emitting different
		// output than the others.
		const manifestDir = inputStat.isDirectory() ? inputPath : dirname(inputPath);
		let knownRefs = null;
		try {
			const { modules } = await buildManifest(manifestDir);
			knownRefs = modules.map((m) => m.ref);
		} catch (err) {
			console.warn(`Could not read component refs from ${manifestDir}: ${err.message}`);
		}

		if (inputStat.isFile()) {
			// Single file compilation
			const outputPath = args.output
				? resolve(args.output)
				: inputPath.replace(extname(inputPath), args.extension);

			await compileSingleFile(inputPath, outputPath, { debug: args.debug, sharedStyles, knownRefs });
		} else if (inputStat.isDirectory()) {
			// Directory compilation
			const outputDir = args.output ? resolve(args.output) : inputPath;

			if (args.watch) {
				await watchMode(inputPath, outputDir, {
					extension: args.extension,
					debug: args.debug,
					sharedStyles,
					knownRefs
				});
			} else {
				const results = await compileDirectory(inputPath, outputDir, {
					extension: args.extension,
					debug: args.debug,
					sharedStyles,
					knownRefs
				});

				const success = results.filter(r => r.success).length;
				const failed = results.filter(r => !r.success).length;

				console.log(`\nCompiled ${success} files${failed ? `, ${failed} failed` : ''}`);
			}
		}
	} catch (error) {
		console.error('Error:', error.message);
		process.exit(1);
	}
}

main();
