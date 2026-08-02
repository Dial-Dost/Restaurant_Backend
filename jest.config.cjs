/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/jest.setup.cjs'],
  transform: {
    '^.+\\.(ts|tsx)$': ['ts-jest', { tsconfig: 'tsconfig.jest.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  // The app source is NodeNext ESM, so its relative imports carry a `.js`
  // extension that points at a `.ts` file on disk. ts-jest compiles to CommonJS,
  // where jest's resolver takes that specifier literally and fails. Stripping the
  // extension lets a test import real application modules (e.g. the report
  // readers in database_supabase.ts) instead of a copy of their logic.
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  // `test/` holds the older tsx-run scripts (*_test.ts); only *.test.ts files
  // there are jest suites, so both globs can coexist.
  testMatch: ['**/jest-tests/**/*.test.(ts|js)', '**/test/**/*.test.(ts|js)'],
  collectCoverageFrom: ['**/*.ts', '!**/node_modules/**', '!build/**', '!jest-tests/**'],
  verbose: true,
};
