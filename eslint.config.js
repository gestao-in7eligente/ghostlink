import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig(
  globalIgnores(['**/node_modules/**', '**/dist/**', '**/out/**', '**/coverage/**', '**/.data/**', '.claude/**']),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', URL: 'readonly' },
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // spec §2.1: shared runs in Node, Electron main and the sandboxed renderer.
    files: ['packages/shared/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['node:*'], message: '@ghostlink/shared must not use Node-only APIs.' }] },
      ],
      'no-restricted-globals': ['error', 'Buffer', 'process', 'require', 'window', 'document'],
    },
  },
  {
    // spec §2.1/§12: the renderer is a sandboxed web page; it reaches the main process only through window.ghostlink.
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*', 'electron', 'electron/*'], message: 'The renderer is sandboxed: use window.ghostlink.' },
            { group: ['**/main/*', '**/preload/*'], message: 'The renderer must not import main-process or preload code.' },
          ],
        },
      ],
      'no-restricted-globals': ['error', 'Buffer', 'process', 'require'],
    },
  },
);
