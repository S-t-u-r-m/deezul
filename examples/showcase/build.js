import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPILED_DIR = path.join(__dirname, 'compiled');

// Resolve compiler: repo source first, then local fallback
const REPO_COMPILER = path.join(__dirname, '..', '..', 'src', 'compiler', 'bin', 'cli.js');
const LOCAL_COMPILER = path.join(__dirname, 'compiler', 'cli.js');
const COMPILER = fs.existsSync(REPO_COMPILER) ? REPO_COMPILER : LOCAL_COMPILER;

// Copy runtime bundle from repo if available
const REPO_RUNTIME = path.join(__dirname, '..', '..', 'dist', 'deezul.esm.js');
const LOCAL_RUNTIME = path.join(__dirname, 'deezul.esm.js');
if (fs.existsSync(REPO_RUNTIME)) {
    fs.copyFileSync(REPO_RUNTIME, LOCAL_RUNTIME);
    console.log('Copied runtime bundle from dist/');
} else if (!fs.existsSync(LOCAL_RUNTIME)) {
    console.error('Error: No runtime bundle found. Run `npm run build` from the repo root first.');
    process.exit(1);
}

// Copy compiler for local dev use (so `npm run dev` can auto-compile)
const LOCAL_COMPILER_DIR = path.join(__dirname, 'compiler');
const REPO_COMPILER_LIB = path.join(__dirname, '..', '..', 'src', 'compiler', 'library');
if (fs.existsSync(REPO_COMPILER_LIB) && !fs.existsSync(LOCAL_COMPILER_DIR)) {
    fs.mkdirSync(LOCAL_COMPILER_DIR);
    // Copy CLI with adjusted import path
    let cliSrc = fs.readFileSync(REPO_COMPILER, 'utf-8');
    cliSrc = cliSrc.replace("from '../library/main.js'", "from './main.js'");
    fs.writeFileSync(LOCAL_COMPILER, cliSrc);
    // Copy library files
    for (const file of fs.readdirSync(REPO_COMPILER_LIB)) {
        fs.copyFileSync(path.join(REPO_COMPILER_LIB, file), path.join(LOCAL_COMPILER_DIR, file));
    }
    console.log('Copied compiler for local dev use');
}

// Ensure compiled dir exists
if (!fs.existsSync(COMPILED_DIR)) {
    fs.mkdirSync(COMPILED_DIR);
}

// Find all .js files in src/
function findSourceFiles(dir) {
    const files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...findSourceFiles(full));
        } else if (entry.name.endsWith('.js')) {
            files.push(full);
        }
    }
    return files;
}

const srcDir = path.join(__dirname, 'src');
const sourceFiles = findSourceFiles(srcDir);

for (const file of sourceFiles) {
    const name = path.basename(file, '.js');
    const output = path.join(COMPILED_DIR, `${name}.compiled.js`);
    console.log(`Compiling: ${path.relative(__dirname, file)}`);
    execSync(`node "${COMPILER}" "${file}" "${output}"`, { stdio: 'inherit' });
}

console.log(`Done! Compiled ${sourceFiles.length} components.`);
