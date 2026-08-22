import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // A context file that exports its provider alongside the hook for reading it is the
      // intended shape, not an accident. Naming the hook keeps the rule's real protection —
      // catching a stray constant or helper exported from a component module.
      'react-refresh/only-export-components': ['error', { allowExportNames: ['useApp', 'preloadMarkdown'] }],
    },
  },
  {
    // Tests are never hot-reloaded, so the Fast Refresh constraint does not apply to them.
    files: ['src/test/**/*.{ts,tsx}'],
    rules: {
      'react-refresh/only-export-components': 'off',
    },
  },
])
