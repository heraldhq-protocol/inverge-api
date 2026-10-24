import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * How long a parameter snapshot is reused before the next read hits the database.
 *
 * Parameters are read several times per public request (the feed alone reads 17),
 * and they change only through an audited admin action. Five seconds keeps a
 * change effectively immediate — `set()` invalidates the snapshot in its own
 * process — while collapsing dozens of point reads into one table read.
 */
const SNAPSHOT_TTL_MS = 5_000;

// FR-901/904: admin-configurable platform parameters. Reads are served from a
// short-lived snapshot and invalidated on write; a change via PATCH /admin/params
// is visible on the next request in this process.
@Injectable()
export class PlatformParamsService {
  private snapshot: Record<string, unknown> | null = null;
  private snapshotAt = 0;

  constructor(private readonly prisma: PrismaService) {}

  async getAll(): Promise<Record<string, unknown>> {
    const now = Date.now();
    if (this.snapshot !== null && now - this.snapshotAt < SNAPSHOT_TTL_MS) {
      return this.snapshot;
    }

    const rows = await this.prisma.platformParam.findMany();
    this.snapshot = Object.freeze(
      Object.fromEntries(rows.map((r) => [r.key, r.value])),
    ) as Record<string, unknown>;
    this.snapshotAt = now;
    return this.snapshot;
  }

  async get<T = unknown>(key: string, fallback?: T): Promise<T | undefined> {
    const all = await this.getAll();
    return (all[key] as T) ?? fallback;
  }

  async getNumber(key: string, fallback = 0): Promise<number> {
    const v = await this.get<unknown>(key);
    return typeof v === 'number' ? v : fallback;
  }

  // FR-904: sets the value AND appends an audit row when the value actually changes.
  async set(key: string, value: unknown, updatedBy?: string) {
    const existing = await this.prisma.platformParam.findUnique({ where: { key } });
    const oldValue = existing ? existing.value : null;
    const changed = JSON.stringify(oldValue) !== JSON.stringify(value ?? null);

    const row = await this.prisma.platformParam.upsert({
      where: { key },
      update: { value: value as object, updatedBy },
      create: { key, value: value as object, updatedBy },
    });

    // Invalidate immediately after the durable write, before the audit insert:
    // a failed audit must not leave this process serving the old value.
    this.snapshot = null;
    this.snapshotAt = 0;

    if (changed) {
      await this.prisma.platformParamAudit.create({
        data: {
          key,
          oldValue: oldValue === null ? undefined : (oldValue as object),
          newValue: value as object,
          changedBy: updatedBy ?? null,
        },
      });
    }
    return row;
  }

  // FR-904: read the change history, newest first (optionally filtered by key).
  async auditLog(opts: { key?: string; limit?: number; offset?: number } = {}) {
    return this.prisma.platformParamAudit.findMany({
      where: opts.key ? { key: opts.key } : {},
      orderBy: { changedAt: 'desc' },
      take: Math.min(opts.limit ?? 100, 500),
      skip: opts.offset ?? 0,
    });
  }
}
