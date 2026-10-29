const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  js.configs.recommended,
  { files: ['src/**', 'test/**', 'scripts/**', 'api/**', 'eslint.config.js'], languageOptions: { sourceType: 'commonjs', globals: globals.node } },
  {
    files: ['public/**'],
    ignores: ['public/common.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser, h: 'readonly', rupee: 'readonly', api: 'readonly', dot: 'readonly', renderMenu: 'readonly', sheet: 'readonly', store: 'readonly', cap: 'readonly' } },
    rules: { 'no-unused-vars': ['error', { vars: 'local', caughtErrors: 'none' }] },
  },
  { files: ['public/common.js'], languageOptions: { sourceType: 'script', globals: globals.browser }, rules: { 'no-unused-vars': 'off' } },
  { files: ['src/**', 'test/**', 'scripts/**', 'api/**'], rules: { 'no-unused-vars': ['error', { caughtErrors: 'none' }], 'no-empty': ['error', { allowEmptyCatch: true }] } },
];
