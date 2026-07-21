import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../../config/env.validation';
import { NotificationMessage, NotificationPort } from './notification.port';

// Reference adapter: Herald Protocol gateway dispatch. Skeleton POST to the gateway;
// wallet→email resolution + delivery receipts handled Herald-side.
@Injectable()
export class HeraldNotificationAdapter implements NotificationPort {
  private readonly logger = new Logger('Notifications');

  constructor(private readonly config: ConfigService<Env, true>) {}

  async send(message: NotificationMessage): Promise<void> {
    const url = this.config.get('HERALD_GATEWAY_URL', { infer: true });
    const apiKey = this.config.get('HERALD_API_KEY', { infer: true });
    if (!url || !apiKey) {
      this.logger.warn('Herald not configured; dropping notification');
      return;
    }
    const res = await fetch(`${url}/notifications`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(message),
    });
    if (!res.ok) {
      throw new Error(`Herald dispatch failed: ${res.status}`);
    }
  }
}
