import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import { JOBS_QUEUE, JOB_NAMES } from '../../common/queue/job-names';
import {
  assertProductAnalyticsEvent,
  normalizeProductAnalyticsEvent,
  ProductAnalyticsEventInput,
} from './product-analytics-event';
import {
  isClientIngestWireName,
  isConfirmedWireName,
  toInternalEventName,
} from './analytics-wire';
import {
  AnalyticsIngestJobData,
  toAnalyticsIngestJobEvent,
} from './analytics-ingest.job';
import { ProductAnalyticsService } from './product-analytics.service';

export const MAX_INGEST_EVENTS = 50;

export interface WireAnalyticsEventInput {
  eventKey?: string;
  name: string;
  occurredAt: string;
  userId?: string;
  sessionId?: string;
  ideaId?: string;
  campaignId?: string;
  resourceType?: string;
  resourceId?: string;
  signalType?: string;
  source?: string;
  position?: number;
  step?: string;
  durationMs?: number;
  queryLength?: number;
  resultCount?: number;
  filterKeys?: string[];
  amountMinor?: string;
  currency?: string;
  countryCode?: string;
}

export interface RejectedAnalyticsEvent {
  index: number;
  reason: string;
}

export interface AnalyticsIngestResult {
  received: number;
  accepted: number;
  persisted: number;
  duplicates: number;
  queued: boolean;
  rejected: RejectedAnalyticsEvent[];
}

@Injectable()
export class AnalyticsIngestService {
  private readonly logger = new Logger(AnalyticsIngestService.name);

  constructor(
    private readonly analytics: ProductAnalyticsService,
    @Optional()
    @InjectQueue(JOBS_QUEUE)
    private readonly queue?: Queue<AnalyticsIngestJobData>,
  ) {}

  async ingest(events: WireAnalyticsEventInput[]): Promise<AnalyticsIngestResult> {
    if (events.length > MAX_INGEST_EVENTS) {
      throw new BadRequestException({
        code: 'ANALYTICS_BATCH_TOO_LARGE',
        message: `A batch is limited to ${MAX_INGEST_EVENTS} events`,
      });
    }

    const rejected: RejectedAnalyticsEvent[] = [];
    const valid: ProductAnalyticsEventInput[] = [];

    events.forEach((event, index) => {
      try {
        valid.push(this.toInput(event));
      } catch (error) {
        rejected.push({
          index,
          reason: error instanceof Error ? error.message : 'invalid event',
        });
      }
    });

    if (valid.length === 0) {
      return {
        received: events.length,
        accepted: 0,
        persisted: 0,
        duplicates: 0,
        queued: false,
        rejected,
      };
    }

    if (this.queue) {
      try {
        await this.queue.add(
          JOB_NAMES.analyticsIngest,
          { events: valid.map(toAnalyticsIngestJobEvent) },
          {
            attempts: 3,
            backoff: { type: 'exponential', delay: 5_000 },
            removeOnComplete: 1_000,
            removeOnFail: 5_000,
          },
        );
        return {
          received: events.length,
          accepted: valid.length,
          persisted: 0,
          duplicates: 0,
          queued: true,
          rejected,
        };
      } catch (error) {
        this.logger.warn(
          `Analytics ingest queue unavailable; writing inline: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    }

    try {
      const persisted = await this.analytics.persistBatch(valid);
      return {
        received: events.length,
        accepted: valid.length,
        persisted,
        duplicates: valid.length - persisted,
        queued: false,
        rejected,
      };
    } catch (error) {
      this.logger.error(
        `Analytics ingest write failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
      throw new ServiceUnavailableException({
        code: 'ANALYTICS_INGEST_UNAVAILABLE',
        message: 'Analytics ingest is temporarily unavailable',
      });
    }
  }

  private toInput(event: WireAnalyticsEventInput): ProductAnalyticsEventInput {
    if (!isClientIngestWireName(event.name)) {
      if (isConfirmedWireName(event.name)) {
        throw new Error('confirmed events are emitted by the domain, not ingested');
      }
      throw new Error('unknown analytics event name');
    }
    if (!event.eventKey) {
      throw new Error('eventKey is required');
    }

    const occurredAt = new Date(event.occurredAt);
    if (Number.isNaN(occurredAt.getTime())) {
      throw new Error('occurredAt must be an ISO timestamp');
    }

    const { amountMinor, ...rest } = event;
    const normalized = normalizeProductAnalyticsEvent({
      ...rest,
      name: toInternalEventName(event.name),
      occurredAt,
      resourceType: event.resourceType as ProductAnalyticsEventInput['resourceType'],
      resourceId: event.resourceId,
      signalType: event.signalType as ProductAnalyticsEventInput['signalType'],
      source: event.source as ProductAnalyticsEventInput['source'],
      ...(amountMinor === undefined ? {} : { amountMinor: BigInt(amountMinor) }),
    });

    assertProductAnalyticsEvent(normalized, new Date());
    return normalized;
  }
}
