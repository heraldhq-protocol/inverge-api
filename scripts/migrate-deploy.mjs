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

/**
 * One obsolete migration shipped briefly alongside a duplicate of the same
 * settings schema. A deployment that attempted it left a failed
 * `_prisma_migrations` row, and Prisma refuses every later deploy until that
 * row is cleared. The migration file is gone; delete only its failed row. A
 * successfully applied row (or no row) is left untouched.
 */
const OBSOLETE_FAILED_MIGRATION = '20261031120000_settings_persistence';

async function clearObsoleteFailedMigration() {
  const { Client } = await import('pg');
  const needsSsl = !/localhost|127\.0\.0\.1/i.test(target);
  const client = new Client({
    connectionString: target,
    ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });
  await client.connect();
  try {
    const result = await client.query(
      `DELETE FROM "_prisma_migrations" WHERE migration_name = $1 AND finished_at IS NULL`,
      [OBSOLETE_FAILED_MIGRATION],
    );
    if (result.rowCount) {
      console.log(
        `[migrate] cleared ${result.rowCount} failed duplicate migration row(s).`,
      );
    }
  } finally {
    await client.end();
  }
}

try {
  await clearObsoleteFailedMigration();
} catch (error) {
  // A missing row, an unreachable cleanup connection or an absent migration
  // table is not fatal: the deploy below reports the real problem.
  console.warn(
    `[migrate] could not inspect the obsolete migration row: ${
      error instanceof Error ? error.message : String(error)
    }`,
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
