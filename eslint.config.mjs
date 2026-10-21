import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const eslintConfig = defineConfig([
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx,mts,cts}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.flat['recommended-latest'].rules,
      // These expressions intentionally reject file-name/XML control bytes.
      'no-control-regex': 'off',
    },
  },
  globalIgnores([
    '.next/**',
    '.vinext/**',
    '.wrangler/**',
    'out/**',
    'build/**',
    'dist/**',
    'artifacts/**',
    'test-results/**',
    'next-env.d.ts',
    'tsconfig.tsbuildinfo',
  ]),
]);

export default eslintConfig;
