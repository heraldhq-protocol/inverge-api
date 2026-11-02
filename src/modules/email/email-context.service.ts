import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createUnsubscribeToken } from '../../common/email';
import type { RenderEmailOptions } from '../../common/email';
import type { Env } from '../../config/env.validation';
import { API_PREFIX } from '../../openapi';

/**
 * Builds the link/identity context every email shares. Keeping it in one place
 * means a deployment cannot accidentally mix a staging app link with a
 * production API unsubscribe link.
 */
@Injectable()
export class EmailContextService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  appUrl(): string {
    return this.origin(this.config.get('PUBLIC_APP_URL', { infer: true }));
  }

  apiUrl(): string {
    return this.origin(this.config.get('PUBLIC_API_URL', { infer: true }));
  }

  preferencesUrl(): string {
    return `${this.appUrl()}/d/settings`;
  }

  unsubscribeUrl(subscriptionId: string): string {
    const token = createUnsubscribeToken(
      this.config.get('EMAIL_UNSUBSCRIBE_SECRET', { infer: true }),
      subscriptionId,
    );
    return `${this.apiUrl()}/${API_PREFIX}/email/preferences/${token}`;
  }

  renderOptions(): RenderEmailOptions {
    const appUrl = this.appUrl();
    const logo =
      this.config.get('EMAIL_LOGO_URL', { infer: true }) ||
      `${appUrl}/brand/inverge-mark.png`;
    return {
      appUrl,
      companyAddress:
        this.config.get('EMAIL_COMPANY_ADDRESS', { infer: true }) || null,
      logoUrl: logo,
      preferencesUrl: this.preferencesUrl(),
      supportEmail:
        this.config.get('EMAIL_SUPPORT_ADDRESS', { infer: true }) || null,
    };
  }

  private origin(value: string): string {
    return new URL(value).origin;
  }
}
