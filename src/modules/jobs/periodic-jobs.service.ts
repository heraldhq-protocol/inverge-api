import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../../config/env.validation';
import { AnalyticsAggregationService } from '../analytics/analytics-aggregation.service';
import { AnalyticsRetentionService } from '../analytics/analytics-retention.service';
import { previousUtcDay } from '../analytics/analytics-time';
import { CampaignDeploymentService } from '../campaigns/deployment/campaign-deployment.service';
import { VerificationService } from '../kyc/verification.service';
import { MetricsService } from '../metrics/metrics.service';
import { msUntilNextUtc } from './daily-schedule';

/** Was a BullMQ repeatable at 30 s; the cadence is unchanged, only its home. */
const DEPLOYMENT_SWEEP_INTERVAL_MS = 30_000;
/** Was the repeatable cron `0 3 * * *` (UTC). */
const SNAPSHOT_AT = { hour: 3, minute: 0 } as const;
/** Was the repeatable cron `15 4 * * *` (UTC). */
const ANALYTICS_AT = { hour: 4, minute: 15 } as const;

const utcLabel = (at: { hour: number; minute: number }): string =>
  `${String(at.hour).padStart(2, '0')}:${String(at.minute).padStart(2, '0')} UTC`;

/**
 * Time-driven background work, scheduled in-process.
 *
 * These four jobs used to be BullMQ repeatable jobs. A repeatable job is a
 * delayed job, and a pending delayed job makes the Worker re-poll every 10 s no
 * matter what `drainDelay` says — so the reclaim never fires while one exists.
 * Moving the schedule into the process removes every delayed job from Redis and
 * costs nothing there, at two prices, both accepted deliberately:
 *
 * - a run is skipped if the instance is down when it comes due (Redis used to
 *   hold the delayed job until a Worker came back);
 * - the instance runs this once, so a future multi-instance deployment would
 *   need a leader or a database lock before enabling it on more than one.
 *
 * Every job below is idempotent except the daily snapshot, which is why that one
 * is scheduled as a single timeout to the next occurrence rather than an interval:
 * a restart re-computes the next 03:00 instead of replaying the whole day.
 */
@Injectable()
export class PeriodicJobsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PeriodicJobsService.name);
  private readonly timers = new Set<NodeJS.Timeout>();
  private closed = false;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly verification: VerificationService,
    private readonly deployments: CampaignDeploymentService,
    private readonly snapshots: MetricsService,
    private readonly aggregation: AnalyticsAggregationService,
    private readonly retention: AnalyticsRetentionService,
  ) {}

  onModuleInit(): void {
    const reconcileMinutes = this.config.get(
      'VERIFICATION_RECONCILE_INTERVAL_MINUTES',
      { infer: true },
    );

    this.every(
      reconcileMinutes * 60_000,
      'verification reconciliation',
      () => this.reconcileVerification(),
    );
    this.every(DEPLOYMENT_SWEEP_INTERVAL_MS, 'campaign deployment sweep', () =>
      this.sweepDeployments(),
    );
    this.daily(SNAPSHOT_AT, 'daily idea metric snapshot', () => this.snapshot());
    this.daily(ANALYTICS_AT, 'nightly analytics maintenance', () =>
      this.maintainAnalytics(),
    );

    this.logger.log(
      `Scheduled in-process jobs: verification reconcile every ${reconcileMinutes}m, ` +
        `deployment sweep every ${DEPLOYMENT_SWEEP_INTERVAL_MS / 1_000}s, ` +
        `snapshot ${utcLabel(SNAPSHOT_AT)}, analytics ${utcLabel(ANALYTICS_AT)}`,
    );
  }

  onModuleDestroy(): void {
    this.closed = true;
    for (const timer of this.timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    this.timers.clear();
  }

  // ── schedule plumbing ──────────────────────────────────────────────────────────

  private every(ms: number, label: string, run: () => Promise<void>): void {
    const timer = setInterval(() => void this.runSafely(label, run), ms);
    this.track(timer);
  }

  private daily(
    at: { hour: number; minute: number },
    label: string,
    run: () => Promise<void>,
  ): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.runSafely(label, run).finally(() => {
        if (!this.closed) this.daily(at, label, run);
      });
    }, msUntilNextUtc(new Date(), at.hour, at.minute));
    this.track(timer);
  }

  private track(timer: NodeJS.Timeout): void {
    // Never hold the process open: tests, the OpenAPI emitter and one-off
    // scripts import the module graph without running the API.
    timer.unref?.();
    this.timers.add(timer);
  }

  private async runSafely(label: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.logger.warn(
        `${label} failed: ${
          error instanceof Error ? error.message : 'unknown error'
        }; the next tick retries.`,
      );
    }
  }

  // ── jobs ───────────────────────────────────────────────────────────────────────

  private async reconcileVerification(): Promise<void> {
    await this.verification.reconcileDue();
  }

  private async sweepDeployments(): Promise<void> {
    const result = await this.deployments.sweepPending();
    if (result.examined > 0 || result.feesSettled > 0) {
      this.logger.log(
        `Deployment sweep: examined=${result.examined} confirmed=${result.confirmed} feesSettled=${result.feesSettled}`,
      );
    }
  }

  private async snapshot(): Promise<void> {
    const captured = await this.snapshots.snapshotAllValidating();
    this.logger.log(
      `Captured ${captured} idea metric snapshot(s) (FR-204a sustainment)`,
    );
  }

  private async maintainAnalytics(): Promise<void> {
    const day = previousUtcDay(new Date());
    const signals = await this.aggregation.aggregateIdeaSignals(day);
    const reach = await this.aggregation.aggregateReach(day);
    const acquisition = await this.aggregation.aggregateAcquisition(day);
    const countries = await this.aggregation.aggregateCountries(day);
    const funnel = await this.aggregation.aggregateCampaignFunnel(day);
    const purged = await this.retention.purge(new Date());

    this.logger.log(
      `Analytics maintenance ${day}: ${signals.ideas} idea roll-up(s), ` +
        `${reach.resources} reach row(s), ${acquisition.resources} acquisition row(s), ` +
        `${countries.resources} country row(s), ${funnel.campaigns} funnel row(s), ` +
        `${purged.events} raw event(s), ${purged.aggregates} aggregate(s) purged`,
    );
  }
}
