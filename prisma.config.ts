import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

// Prisma v7 config. URLs live here (not in schema.prisma) under the driver-adapter model.
// DIRECT_URL is optional (only needed behind a connection pooler); include it lazily so
// a missing var doesn't fail config load on a plain local Postgres.
const datasource: { url: string; directUrl?: string } = {
  url: env('DATABASE_URL'),
};
if (process.env.DIRECT_URL) {
  datasource.directUrl = process.env.DIRECT_URL;
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource,
});
