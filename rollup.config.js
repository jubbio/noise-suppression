import typescript from '@rollup/plugin-typescript';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import dts from 'rollup-plugin-dts';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Custom plugin to import worklet/worker files as strings
function codeAsString() {
  return {
    name: 'code-as-string',
    resolveId(id) {
      if (id.includes('?worklet-code') || id.includes('?worker-code')) {
        return id;
      }
      return null;
    },
    load(id) {
      let distFile = null;
      if (id.includes('?worklet-code')) {
        distFile = 'dist/DeepFilterWorklet.js';
      } else if (id.includes('?worker-code')) {
        distFile = 'dist/DeepFilterWorker.js';
      }

      if (distFile) {
        const distPath = resolve(__dirname, distFile);
        try {
          const code = readFileSync(distPath, 'utf-8');
          return `export default ${JSON.stringify(code)};`;
        } catch (e) {
          console.warn(`Warning: ${distFile} not found. You may need to run build twice.`);
          return `export default '';`;
        }
      }
      return null;
    }
  };
}

export default [
  // Worklet bundle - Build first (no WASM imports, lightweight)
  {
    input: 'src/worklet/DeepFilterWorklet.ts',
    output: {
      file: 'dist/DeepFilterWorklet.js',
      format: 'iife',
      sourcemap: false,
    },
    plugins: [
      nodeResolve(),
      commonjs(),
      typescript({
        tsconfig: './tsconfig.build.json',
        declaration: false,
        sourceMap: false,
        target: 'ES2020',
      }),
    ],
  },

  // Worker bundle - Build second (has WASM imports)
  {
    input: 'src/worker/DeepFilterWorker.ts',
    output: {
      file: 'dist/DeepFilterWorker.js',
      format: 'iife',
      sourcemap: false,
    },
    plugins: [
      nodeResolve(),
      commonjs(),
      typescript({
        tsconfig: './tsconfig.build.json',
        declaration: false,
        sourceMap: false,
        target: 'ES2020',
      }),
    ],
  },

  // Main library bundle - Build third (after worklet + worker files exist)
  {
    input: 'src/index.ts',
    output: [
      {
        file: 'dist/index.js',
        format: 'cjs',
        sourcemap: false,
      },
      {
        file: 'dist/index.esm.js',
        format: 'esm',
        sourcemap: false,
      },
    ],
    external: ['livekit-client'],
    plugins: [
      codeAsString(),
      nodeResolve(),
      commonjs(),
      typescript({
        tsconfig: './tsconfig.json',
        declaration: false,
        sourceMap: false,
        target: 'ES2020',
      }),
    ],
  },

  // Type definitions - Build last
  {
    input: 'src/index.ts',
    output: [{ file: 'dist/index.d.ts', format: 'es' }],
    plugins: [
      dts({
        respectExternal: true,
        compilerOptions: {
          declaration: true,
          declarationMap: false,
        }
      })
    ],
    external: ['livekit-client'],
  },
];
