import tseslint from 'typescript-eslint'

export default tseslint.config(
  // Ignore build artifacts and generated files
  {
    ignores: [
      'out/**',
      'build/**',
      'dist/**',
      'node_modules/**',
      'resources/**',
      '*.js',
    ],
  },
  // Apply to all TS/TSX source and mjs scripts — no type-aware rules here
  {
    files: ['src/**/*.{ts,tsx}', 'scripts/**/*.mjs'],
    extends: [
      ...tseslint.configs.recommended,
    ],
    rules: {
      // Downgrade recommended errors to warnings so they inform without blocking
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/no-wrapper-object-types': 'warn',
      '@typescript-eslint/no-unsafe-function-type': 'warn',
      '@typescript-eslint/prefer-as-const': 'warn',
      // prefer-const is a base ESLint rule included via recommended; downgrade to warn
      'prefer-const': 'warn',

      // Disable pure-style/formatting rules entirely
      '@typescript-eslint/consistent-type-imports': 'off',
      '@typescript-eslint/consistent-type-definitions': 'off',
      '@typescript-eslint/member-ordering': 'off',
      '@typescript-eslint/naming-convention': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
  // Type-aware rules scoped to non-test TS files only.
  // Test files are excluded from all tsconfigs so projectService can't resolve them.
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'src/**/__tests__/**',
      'src/**/*.dom.test.ts',
      'src/**/*.stress.test.ts',
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ERROR: un-awaited promises are a real bug category this codebase cares about
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
)
