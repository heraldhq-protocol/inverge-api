/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testRegex: '.e2e-spec\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  testTimeout: 30000,
  // Every suite writes to the same Postgres database and the stub auth provider
  // derives identities from short token prefixes. Running suites in parallel lets
  // them collide on users and shared platform params; serialise them instead.
  maxWorkers: 1,
};
