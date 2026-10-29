import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Env } from '../../config/env.validation';
import { assertStubProviderAllowed } from '../stub-guard';
import { EmailMessage, EmailPort } from './email.port';

/**
 * Offline email adapter. It writes the rendered message (including the code) to
 * a gitignored local outbox so a developer can complete a real verification
 * flow without a provider account.
 *
 * This adapter refuses to run in production. Codes are never written to logs.
 */
@Injectable()
export class StubEmailAdapter implements EmailPort {
  private readonly outbox = resolve(process.cwd(), '.local', 'email-outbox');

  constructor(@Optional() private readonly config?: ConfigService<Env, true>) {}

  async send(message: EmailMessage): Promise<void> {
    assertStubProviderAllowed('email', this.config);

    await mkdir(this.outbox, { recursive: true });
    const name = message.idempotencyKey
      ? message.idempotencyKey.replace(/[^a-zA-Z0-9._-]/g, '_')
      : randomUUID();
    const path = join(this.outbox, `${name}.json`);
    await writeFile(
      path,
      JSON.stringify(
        {
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
          writtenAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      { encoding: 'utf8', mode: 0o600 },
    );
  }
}
