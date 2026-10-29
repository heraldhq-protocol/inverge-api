// Port: transactional email delivery. Adapters: Resend (production) and stub
// (offline development/tests). Business logic never imports a vendor SDK; the
// verification service depends only on this interface.

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  /**
   * Stable key for provider-side de-duplication. A retried send for the same
   * verification challenge must not create a second message.
   */
  idempotencyKey?: string;
}

export interface EmailPort {
  /** Deliver one message. Throws when the provider rejects or times out. */
  send(message: EmailMessage): Promise<void>;
}

export const EMAIL_PORT = Symbol('EMAIL_PORT');

/**
 * A provider failure with no recipient, body or credential attached. Callers log
 * this message only; the raw provider response may contain personal data.
 */
export class EmailDeliveryError extends Error {
  readonly providerStatus?: number;

  constructor(message: string, providerStatus?: number) {
    super(message);
    this.name = 'EmailDeliveryError';
    this.providerStatus = providerStatus;
  }
}
