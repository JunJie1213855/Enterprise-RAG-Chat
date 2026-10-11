/* eslint-env node */
module.exports = {
  root: true,
  env: { browser: true, es2022: true, node: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  plugins: ['@typescript-eslint', 'react-hooks'],
  ignorePatterns: ['dist', 'node_modules', '*.cjs', '*.config.ts'],
  rules: {
    // The codebase intentionally uses `any` in a few boundary spots (markdown
    // renderers, axios error shapes) — keep it allowed.
    '@typescript-eslint/no-explicit-any': 'off',
    // Unused args/vars are a warning, not a build-breaker; allow `_`-prefixed
    // throwaways (e.g. destructured-but-unused fields).
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' },
    ],
  },
}
