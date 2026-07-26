import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

// FR-901/904: admin-configurable platform parameters. Read at call time so a change
// via PATCH /admin/params takes effect immediately (no deploy/restart).
@Injectable()
export class PlatformParamsService {
  constructor(private readonly prisma: PrismaService) {}

  async getAll(): Promise<Record<string, unknown>> {
    const rows = await this.prisma.platformParam.findMany();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async get<T = unknown>(key: string, fallback?: T): Promise<T | undefined> {
    const row = await this.prisma.platformParam.findUnique({ where: { key } });
    return (row?.value as T) ?? fallback;
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
