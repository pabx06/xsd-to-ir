module.exports = {
  root: true,
  env: {
    commonjs: true,
    es2022: true,
    node: true,
  },
  extends: ['airbnb-base'],
  parserOptions: {
    ecmaVersion: 'latest',
  },
  ignorePatterns: [
    'node_modules/',
    'output/',
  ],
  rules: {
    camelcase: 'off',
    'class-methods-use-this': 'off',
    'consistent-return': 'off',
    'import/no-extraneous-dependencies': ['error', {
      devDependencies: [
        'test/**/*.js',
        'scripts/**/*.js',
      ],
    }],
    'max-len': ['error', {
      code: 120,
      ignoreComments: true,
      ignoreStrings: true,
      ignoreTemplateLiterals: true,
      ignoreUrls: true,
    }],
    'no-await-in-loop': 'off',
    'no-console': 'off',
    'no-continue': 'off',
    'no-plusplus': 'off',
    'no-param-reassign': ['error', {
      props: false,
    }],
    'no-restricted-syntax': [
      'error',
      'ForInStatement',
      'LabeledStatement',
      'WithStatement',
    ],
    'no-underscore-dangle': 'off',
    'no-unused-vars': ['error', {
      argsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
    }],
    'no-use-before-define': ['error', {
      functions: false,
      classes: true,
      variables: true,
    }],
    'object-property-newline': 'off',
    'prefer-destructuring': 'off',
    strict: ['error', 'global'],
  },
};
