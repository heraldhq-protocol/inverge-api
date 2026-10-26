import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  assertProductAnalyticsEvent,
  normalizeProductAnalyticsEvent,
  ProductAnalyticsEventInput,
} from './product-analytics-event';

/**
 * The only writer of product analytics rows. Domain services call `record()` after
 * their transaction commits; the signed ingest route calls `persistBatch()`. A
 * rejected or failed write is logged without values and dropped - analytics may
 * never fail a user action or a page render.
 */
@Injectable()
export class ProductAnalyticsService {
  private readonly logger = new Logger(ProductAnalyticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(event: ProductAnalyticsEventInput): Promise<boolean> {
    try {
      const normalized = normalizeProductAnalyticsEvent(event);
      assertProductAnalyticsEvent(normalized, new Date());
      await this.prisma.productAnalyticsEvent.create({
        data: {
          ...normalized,
          eventKey: normalized.eventKey!,
          schemaVersion: 1,
          filterKeys: normalized.filterKeys ?? [],
        },
      });
      return true;
    } catch (error) {
      this.logger.warn(
        `Dropped product analytics event ${event.name}: ${(error as Error).message}`,
      );
      return false;
    }
  }

  /**
   * Bulk insert for the ingest worker. Callers validate first; a duplicate
   * `eventKey` is a no-op, so a retried batch cannot inflate counts.
   */
  async persistBatch(events: ProductAnalyticsEventInput[]): Promise<number> {
    if (events.length === 0) return 0;

    const result = await this.prisma.productAnalyticsEvent.createMany({
      data: events.map((event) => ({
        ...event,
        eventKey: event.eventKey!,
        schemaVersion: 1,
        filterKeys: event.filterKeys ?? [],
      })),
      skipDuplicates: true,
    });
    return result.count;
  }
}
