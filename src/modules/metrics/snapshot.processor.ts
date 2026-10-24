import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { MetricsService } from './metrics.service';

export const SNAPSHOT_QUEUE = 'metrics-snapshot';

// FR-204a: worker that captures a daily snapshot of every VALIDATING idea's weighted
// figure. These snapshots are what MetricsService.isSustained() reads to prove the
// graduation threshold was HELD over the window, not merely touched once.
@Processor(SNAPSHOT_QUEUE)
export class SnapshotProcessor extends WorkerHost {
  private readonly logger = new Logger(SnapshotProcessor.name);

  constructor(private readonly metrics: MetricsService) {
    super();
  }

  @OnWorkerEvent('error')
  onError(error: Error) {
    this.logger.warn(
      `Snapshot worker is unavailable (${error.message}); ` +
        'the daily snapshot resumes when Redis is reachable.',
    );
  }

  async process(_job: Job): Promise<{ captured: number }> {
    const captured = await this.metrics.snapshotAllValidating();
    this.logger.log(`Captured ${captured} idea metric snapshot(s) (FR-204a sustainment)`);
    return { captured };
  }
}
