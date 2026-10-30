/**
 * One queue carries every background job.
 *
 * BullMQ is a polling client: each idle Worker re-arms a blocking read on the
 * queue marker and re-runs the stalled-check script, so a Worker costs commands
 * whether or not there is work. Upstash bills every command against a monthly
 * allowance, and seven Workers (one per job family) spent ~290k commands a day on
 * an empty queue. A single Worker plus one job name per payload keeps that to
 * ~6k/day, and `modules/jobs/periodic-jobs.service.ts` keeps repeatable jobs out
 * of Redis entirely — a pending delayed job makes the Worker re-poll every 10 s,
 * whatever `drainDelay` says.
 */
export const JOBS_QUEUE = 'inverge-jobs';

/**
 * Job names, one per payload shape. The producer and the dispatcher in
 * `JobsProcessor` both read these, so a rename is a compile error at both ends.
 */
export const JOB_NAMES = {
  verificationWebhook: 'verification-webhook',
  analyticsIngest: 'analytics-ingest',
  notificationDispatch: 'notification-dispatch',
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];
