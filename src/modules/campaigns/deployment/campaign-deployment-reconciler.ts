import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue } from 'bullmq';
import { Env } from '../../../config/env.validation';
import { logQueueErrors } from '../../../common/queue/queue-errors';
import { CampaignDeploymentService } from './campaign-deployment.service';

export const DEPLOYMENT_RECONCILE_QUEUE = 'campaign-deployment-reconcile';

/**
 * Background verification (brief §10).
 *
 * A signed transaction whose first verification timed out must not depend on the
 * creator leaving a tab open. This worker sweeps a bounded batch of pending
 * attempts, backs off through `nextReconcileAt`, and stops retrying terminal
 * outcomes. It never sends a transaction and holds no key.
 */
@Processor(DEPLOYMENT_RECONCILE_QUEUE)
export class CampaignDeploymentReconcileProcessor extends WorkerHost {
  private readonly logger = new Logger(CampaignDeploymentReconcileProcessor.name);

  constructor(private readonly deployments: CampaignDeploymentService) {
    super();
  }

  @OnWorkerEvent('error')
  onError(error: Error) {
    this.logger.warn(
      `Deployment reconcile worker is unavailable (${error.message}); ` +
        'pending deployments resume when Redis is reachable.',
    );
  }

  async process(_job: Job): Promise<{ confirmed: number; examined: number; feesSettled: number }> {
    const result = await this.deployments.sweepPending();
    if (result.examined > 0 || result.feesSettled > 0) {
      this.logger.log(
        `Deployment sweep: examined=${result.examined} confirmed=${result.confirmed} feesSettled=${result.feesSettled}`,
      );
    }
    return result;
  }
}

@Injectable()
export class CampaignDeploymentReconcileScheduler implements OnModuleInit {
  private readonly logger = new Logger(CampaignDeploymentReconcileScheduler.name);
  private readonly enabled: boolean;

  constructor(
    @InjectQueue(DEPLOYMENT_RECONCILE_QUEUE) private readonly queue: Queue,
    config: ConfigService<Env, true>,
  ) {
    this.enabled = config.get('QUEUE_ENABLED', { infer: true });
    logQueueErrors(queue, this.logger);
  }

  async onModuleInit() {
    if (!this.enabled) {
      this.logger.log('Queue disabled; deployment reconciliation is not scheduled on this instance.');
      return;
    }

    // Same resilience rule as the metrics scheduler: a Redis outage must never
    // crash or hang boot. Only enqueue once the lazy connection reports ready.
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.queue.waitUntilReady(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('connection timed out')), 3000);
        }),
      ]);

      const enqueue = this.queue.add(
        'reconcile-pending',
        {},
        {
          jobId: 'campaign-deployment-reconcile',
          removeOnComplete: true,
          removeOnFail: 50,
          repeat: { every: 30_000 },
        },
      );
      void enqueue.catch(() => undefined);
      await enqueue;

      this.logger.log('Scheduled campaign deployment reconciliation (every 30s)');
    } catch (error) {
      this.logger.warn(
        `Deployment reconciliation not scheduled (Redis unavailable: ${
          (error as Error).message
        }); will schedule on next boot with Redis reachable.`,
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
