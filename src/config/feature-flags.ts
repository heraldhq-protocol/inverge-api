/**
 * Feature flags that must be readable while Nest module metadata is evaluated
 * (module `imports` cannot inject ConfigService). Values come from the process
 * environment, which is what a container sets; `.env` is loaded later by
 * ConfigModule, so tests that need a flag set it in `jest.setup.ts` before the
 * app module is imported.
 */
export function envFlag(name: string, defaultValue = true): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return defaultValue;
  return !['false', '0', 'off', 'no'].includes(raw.trim().toLowerCase());
}
