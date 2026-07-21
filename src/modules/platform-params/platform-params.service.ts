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

  async set(key: string, value: unknown, updatedBy?: string) {
    return this.prisma.platformParam.upsert({
      where: { key },
      update: { value: value as object, updatedBy },
      create: { key, value: value as object, updatedBy },
    });
  }
}
