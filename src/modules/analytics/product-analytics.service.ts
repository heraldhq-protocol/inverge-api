import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  assertProductAnalyticsEvent,
  ProductAnalyticsEventInput,
} from './product-analytics-event';

/**
 * The only writer of product analytics. There is no HTTP ingestion route: domain
 * services call this after their transaction commits. A rejected or failed write is
 * logged without values and dropped - analytics may never fail a user action.
 */
@Injectable()
export class ProductAnalyticsService {
  private readonly logger = new Logger(ProductAnalyticsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(event: ProductAnalyticsEventInput): Promise<boolean> {
    try {
      assertProductAnalyticsEvent(event, new Date());
      await this.prisma.productAnalyticsEvent.create({
        data: {
          ...event,
          filterKeys: event.filterKeys ?? [],
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
}
