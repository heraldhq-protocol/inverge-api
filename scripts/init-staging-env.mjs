#!/usr/bin/env node
/**
 * Create gitignored staging environment files for inverge-api and inverge-web.
 *
 * Why this exists: staging must not reuse local or production secrets, and the
 * analytics HMAC must match on both sides. This script mints the
 * application-owned secrets once, writes both files, and leaves every
 * provider-issued value as an explicit `__TODO_*__` marker (or blank) for a
 * human to fill from the dashboard.
 *
 * It never prints a generated value. It never reads `.env`, `.env.local` or
 * `.env.staging`; it only reads the committed `*.example` templates.
 *
 * Usage (from inverge-api):
 *   node scripts/init-staging-env.mjs
 *   node scripts/init-staging-env.mjs --force
 *   node scripts/init-staging-env.mjs --web-dir ../inverge-web
 */

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(here, '..');

const args = process.argv.slice(2);
const force = args.includes('--force');
const webDirArgIndex = args.indexOf('--web-dir');
const webRoot = resolve(
  apiRoot,
  webDirArgIndex !== -1 ? (args[webDirArgIndex + 1] ?? '../inverge-web') : '../inverge-web',
);

/** Keys that are intentionally empty in the staging posture. */
const intentionallyEmpty = new Set(['CORS_ORIGINS', 'PAYSTACK_WEBHOOK_SECRET']);

const generated = {
  __GENERATE_SESSION_SECRET__: randomBytes(32).toString('hex'),
  __GENERATE_ANALYTICS_SECRET__: randomBytes(32).toString('hex'),
  __GENERATE_METRICS_TOKEN__: randomBytes(24).toString('hex'),
  __GENERATE_LOG_SALT__: randomBytes(16).toString('hex'),
};

const jobs = [
  {
    label: 'API',
    template: resolve(apiRoot, '.env.staging.example'),
    output: resolve(apiRoot, '.env.staging'),
  },
  {
    label: 'Web',
    template: resolve(webRoot, '.env.staging.example'),
    output: resolve(webRoot, '.env.staging.local'),
  },
];

for (const job of jobs) {
  if (!existsSync(job.template)) {
    fail(`Missing template: ${job.template}`);
  }
  if (existsSync(job.output) && !force) {
    fail(
      `Refusing to overwrite ${job.output}\n` +
        'Re-run with --force if you intend to replace the generated staging secrets.',
    );
  }
}

for (const job of jobs) {
  let text = readFileSync(job.template, 'utf8');
  for (const [marker, value] of Object.entries(generated)) {
    text = text.split(marker).join(value);
  }
  writeFileSync(job.output, text, { encoding: 'utf8', mode: 0o600 });
}

// Report only names, never values.
const findings = [];
for (const job of jobs) {
  const text = readFileSync(job.output, 'utf8');
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = rawValue.trim();
    if (intentionallyEmpty.has(key)) continue;
    if (value === '' || value.startsWith('__TODO')) {
      findings.push(`${job.label}  ${key}  (line ${index + 1})`);
    }
  }
}

console.log('Wrote:');
for (const job of jobs) console.log(`  ${job.output}`);
console.log('\nGenerated (not printed): session JWT secret, analytics HMAC, metrics token, log salt.');
console.log('The analytics HMAC is identical in both files.');

if (findings.length === 0) {
  console.log('\nNo placeholders remain.');
} else {
  console.log('\nStill needs a value before first boot:');
  for (const finding of findings) console.log(`  ${finding}`);
}

console.log(
  '\nNext: fill the listed keys from the provider dashboards, then copy the values\n' +
    'into Render (staging service) and Vercel (Preview environment). Do not commit\n' +
    'the generated files.',
);

function fail(message) {
  console.error(message);
  process.exit(1);
}
