import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['out/**', 'out-test/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      'max-len': ['error', { code: 120 }],
      curly: 'error',
      eqeqeq: 'error',
      'no-template-curly-in-string': 'off',
    },
  }
);
