import { PrismaService } from "../src/prisma/prisma.service";

/**
 * Counts Prisma operations per measured request.
 *
 * Prisma v7 no longer emits `$on('query')` unless the client was constructed
 * with a query log target, and the production client deliberately is not. This
 * wrapper measures the same thing at the delegate boundary: one count per ORM
 * operation. Read paths issue one SQL statement per operation, so the count is
 * a conservative query budget rather than a raw SQL counter.
 */
const MODELS = [
  "user",
  "creatorProfile",
  "idea",
  "campaign",
  "analyticsAccessGrant",
  "resourceReachDailyMetric",
  "resourceAcquisitionDailyMetric",
  "resourceCountryDailyMetric",
  "campaignFunnelDailyMetric",
  "ideaSignalDailyMetric",
  "ideaSignal",
  "productAnalyticsEvent",
  "contribution",
  "surveyResponse",
] as const;

const METHODS = [
  "findFirst",
  "findUnique",
  "findMany",
  "count",
  "groupBy",
  "aggregate",
  "create",
  "update",
  "upsert",
] as const;

const RAW_METHODS = [
  "$queryRaw",
  "$queryRawUnsafe",
  "$executeRaw",
  "$executeRawUnsafe",
] as const;

type Callable = (...args: unknown[]) => unknown;

function isCallable(value: unknown): value is Callable {
  return typeof value === "function";
}

export interface QueryCounter {
  reset(): void;
  stop(): number;
}

export function countPrismaQueries(prisma: PrismaService): QueryCounter {
  let active = false;
  let count = 0;
  const root = prisma as unknown as Record<string, unknown>;

  for (const model of MODELS) {
    const delegate = root[model];
    if (!delegate || typeof delegate !== "object") continue;
    const methods = delegate as Record<string, unknown>;

    for (const method of METHODS) {
      const original = methods[method];
      if (!isCallable(original)) continue;

      methods[method] = (...args: unknown[]) => {
        if (active) count += 1;
        return original.apply(delegate, args);
      };
    }
  }

  for (const method of RAW_METHODS) {
    const original = root[method];
    if (!isCallable(original)) continue;

    root[method] = (...args: unknown[]) => {
      if (active) count += 1;
      return original.apply(prisma, args);
    };
  }

  return {
    reset() {
      count = 0;
      active = true;
    },
    stop() {
      active = false;
      return count;
    },
  };
}
