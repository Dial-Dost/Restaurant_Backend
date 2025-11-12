/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.(ts|tsx)$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  testMatch: ['**/jest-tests/**/*.test.(ts|js)'],
  collectCoverageFrom: ['**/*.ts', '!**/node_modules/**', '!build/**', '!jest-tests/**'],
  verbose: true,
};
