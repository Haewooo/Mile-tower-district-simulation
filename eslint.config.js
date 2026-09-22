/**
 * Minimal config with one job: catch identifiers that no longer exist.
 *
 * Moving code out of the old single file into modules is mechanical, and the
 * mechanical failure is a name left behind — still referenced, no longer
 * declared. It lives inside a function scope, so neither esbuild nor
 * `node --check` says a word about it, and the first sign is a blank screen.
 * `no-undef` is the whole point of this file; style is not.
 */
export default [
  {
    files: ['src/**/*.js', 'build.mjs', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        window: 'readonly', document: 'readonly', navigator: 'readonly',
        performance: 'readonly', requestAnimationFrame: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', console: 'readonly',
        matchMedia: 'readonly', devicePixelRatio: 'readonly', location: 'readonly',
        fetch: 'readonly', Image: 'readonly', process: 'readonly', URL: 'readonly',
        localStorage: 'readonly', sessionStorage: 'readonly',
      },
    },
    linterOptions: { reportUnusedDisableDirectives: true },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
    },
  },
];
