import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Emits the committed OpenAPI document.
 *
 * Run with `--check` in CI: the command fails when the committed file and the
 * running decorators disagree, so a route or DTO change cannot land without a
 * spec update (and a generated client cannot silently drift).
 *
 * The document is produced from the real application module, so the decorators
 * are the single source of truth. No database or Redis call is made: providers
 * are instantiated, but lifecycle hooks (`onModuleInit`) are not run.
 */

const OUTPUT_PATH = join(__dirname, '..', 'docs', 'api', 'openapi.json');

/** Sorts object keys so two runs produce byte-identical output. Arrays keep order. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, stable(record[key])]),
    );
  }
  return value;
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');

  // ConfigModule validates the environment at import time. Only DATABASE_URL is
  // required; the placeholder is never dialled because no query runs here.
  process.env.DATABASE_URL ??=
    'postgresql://openapi:openapi@127.0.0.1:5432/openapi';

  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../src/app.module');
  const { API_PREFIX, createOpenApiDocument } = await import('../src/openapi');

  const app = await NestFactory.create(AppModule, {
    logger: false,
    rawBody: true,
  });
  app.setGlobalPrefix(API_PREFIX);
  const document = createOpenApiDocument(app);
  const serialized = `${JSON.stringify(stable(document), null, 2)}\n`;
  await app.close();

  if (check) {
    let committed: string;
    try {
      committed = readFileSync(OUTPUT_PATH, 'utf8');
    } catch {
      throw new Error(
        `No committed OpenAPI document at ${OUTPUT_PATH}. Run openapi:emit.`,
      );
    }
    if (committed !== serialized) {
      throw new Error(
        'docs/api/openapi.json is out of date. Run `pnpm openapi:emit` and commit the result.',
      );
    }
    console.log('OpenAPI document is up to date.');
    return;
  }

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, serialized, 'utf8');
  console.log(`Wrote ${OUTPUT_PATH}`);
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
