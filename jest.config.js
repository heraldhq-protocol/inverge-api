/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testRegex: '.*\\.spec\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  // isolatedModules: faster, and avoids typechecking the large generated Prisma client.
  transform: {
    '^.+\\.ts$': ['ts-jest', { isolatedModules: true }],
  },
};
