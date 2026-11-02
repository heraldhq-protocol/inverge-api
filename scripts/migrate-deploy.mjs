#!/usr/bin/env node
/**
 * `prisma migrate deploy` that works when DATABASE_URL is a transaction pooler.
 *
 * Migrations take a Postgres advisory lock, and PgBouncer's transaction mode
 * does not keep one: against Supabase's pooler (port 6543) the run dies with
 *
 *   Timed out trying to acquire a postgres advisory lock (SELECT pg_advisory_lock(72707369))
 *   ERROR: prepared statement "s1" already exists
 *
 * `directUrl` in prisma.config.ts does not help — `migrate deploy` ignores it and
 * still connects to `url`. The session pooler is the same host and credentials on
 * port 5432, so rewrite just for this step and leave the app's runtime pooling
 * (and the deployed DATABASE_URL) untouched.
 *
 * Set DIRECT_URL to override the rewrite for a non-Supabase pooler.
 */
import { spawnSync } from 'node:child_process';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[migrate] DATABASE_URL is not set; cannot apply migrations.');
  process.exit(1);
}

function sessionEndpoint(raw) {
  const explicit = process.env.DIRECT_URL;
  if (explicit) return explicit;
  try {
    const parsed = new URL(raw);
    if (parsed.port !== '6543') return raw;
    parsed.port = '5432';
    return parsed.toString();
  } catch {
    return raw;
  }
}

const target = sessionEndpoint(url);
if (target !== url) {
  console.log(
    '[migrate] transaction pooler detected; migrating through the session endpoint on 5432.',
  );
}

const result = spawnSync('prisma', ['migrate', 'deploy'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: target, DIRECT_URL: target },
  shell: process.platform === 'win32',
});

if (result.error) {
  console.error(`[migrate] could not run the Prisma CLI: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
