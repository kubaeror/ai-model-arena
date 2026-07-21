import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    ignores: ['src/dashboard-client/**'],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['error'] }],
    },
  },
  {
    files: ['src/cli.ts', 'src/orchestrator/orchestrator.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['src/orchestrator/pm2-helpers.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];
