import terser from '@rollup/plugin-terser';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');
const entry = resolve(root, 'src/runtime/Deezul.js');
const dist = resolve(root, 'dist');

export default {
	input: entry,
	output: [
		{
			file: resolve(dist, 'deezul.esm.js'),
			format: 'es',
			plugins: [terser()]
		},
		{
			file: resolve(dist, 'deezul.iife.js'),
			format: 'iife',
			name: 'Deezul',
			exports: 'named',
			plugins: [terser()]
		}
	]
};
