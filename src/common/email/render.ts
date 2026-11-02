import { EmailLocale, headerText, resolveEmailLocale } from './brand';
import {
  EMAIL_TEMPLATES,
  EmailTemplateId,
  TemplateVariables,
  isEmailTemplateId,
} from './catalog';
import {
  EmailRenderContext,
  RenderedEmail,
  renderEmailHtml,
  renderEmailText,
} from './layout';

/**
 * A render failure. It names the template and the missing/invalid variable
 * keys, never their values: callers log this message directly.
 */
export class EmailTemplateError extends Error {
  readonly templateId: string;
  readonly invalidVariables: string[];

  constructor(templateId: string, invalidVariables: string[], detail: string) {
    super(
      `Email template ${templateId} cannot be rendered: ${detail}${
        invalidVariables.length > 0 ? ` (${invalidVariables.join(', ')})` : ''
      }`,
    );
    this.name = 'EmailTemplateError';
    this.templateId = templateId;
    this.invalidVariables = invalidVariables;
  }
}

export interface RenderEmailOptions {
  appUrl: string;
  locale?: string;
  logoUrl?: string | null;
  supportEmail?: string | null;
  companyAddress?: string | null;
  preferencesUrl?: string | null;
  unsubscribeUrl?: string | null;
}

function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function requireAbsoluteUrl(value: string, name: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error();
    return url.toString();
  } catch {
    throw new EmailTemplateError('*', [name], `${name} must be an absolute http(s) URL`);
  }
}

function requireOrigin(value: string, name: string): string {
  return new URL(requireAbsoluteUrl(value, name)).origin;
}

function optionalUrl(value: string | null | undefined, name: string): string | null {
  if (!value) return null;
  return requireAbsoluteUrl(value, name);
}

/**
 * Renders one template with escaping, plain-text output and the shared brand
 * shell. Marketing mail additionally requires a visible unsubscribe link and a
 * sender postal address; there is no silent fallback for either.
 */
export function renderEmailTemplate(
  templateId: string,
  variables: TemplateVariables,
  options: RenderEmailOptions,
): RenderedEmail {
  if (!isEmailTemplateId(templateId)) {
    throw new EmailTemplateError(templateId, [], 'unknown template');
  }

  const definition = EMAIL_TEMPLATES[templateId as EmailTemplateId];
  const invalid = definition.requiredVariables.filter((key) => isBlank(variables[key]));
  const domainInvalid = definition.validate?.(variables) ?? [];
  const uniqueInvalid = [...new Set([...invalid, ...domainInvalid])];
  if (uniqueInvalid.length > 0) {
    throw new EmailTemplateError(definition.id, uniqueInvalid, 'missing or invalid variables');
  }

  const appUrl = requireOrigin(options.appUrl, 'appUrl');
  const locale: EmailLocale = resolveEmailLocale(options.locale);

  const context: EmailRenderContext = {
    appUrl,
    locale,
    logoUrl: options.logoUrl ?? null,
    supportEmail: options.supportEmail ?? null,
    companyAddress: options.companyAddress ?? null,
    preferencesUrl: optionalUrl(options.preferencesUrl, 'preferencesUrl'),
    unsubscribeUrl: optionalUrl(options.unsubscribeUrl, 'unsubscribeUrl'),
  };

  if (definition.category === 'marketing') {
    const missing: string[] = [];
    if (!context.unsubscribeUrl) missing.push('unsubscribeUrl');
    if (!context.companyAddress?.trim()) missing.push('companyAddress');
    if (missing.length > 0) {
      throw new EmailTemplateError(
        definition.id,
        missing,
        'marketing mail needs an unsubscribe link and a sender address',
      );
    }
  }

  const content = definition.build(variables, context);
  const html = renderEmailHtml(content, context, definition.category);
  const text = renderEmailText(content, context, definition.category);

  return {
    subject: headerText(content.subject),
    previewText: headerText(content.previewText, 240),
    html,
    text,
  };
}
