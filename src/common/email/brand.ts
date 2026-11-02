// Shared brand tokens and text safety for outbound email.
//
// Mirrors `inverge-web/src/features/seo/og/tokens.ts` and the CSS custom
// properties in `inverge-web/src/app/globals.css`. Email clients cannot read CSS
// variables, so the hex values are repeated here on purpose: change one, change
// the others.

export const EMAIL_BRAND = {
  /** Warm paper background. */
  paper: '#FBF9F5',
  /** Brand action colour. */
  emerald: '#1FA85C',
  /** Deep forest header and headings. */
  forest: '#0D1D15',
  /** Warm grey rules and borders. */
  warmGrey: '#EAE6E1',
  surface: '#FFFFFF',
  surfaceMuted: '#F7F4EF',
  ink: '#1F1F1E',
  inkSoft: '#4B4B48',
  muted: '#71716E',
  brandStrong: '#116B3A',
  brandSoft: '#EAF7EF',
  brandTint: '#F3FAF6',
  borderSoft: '#CFE9D9',
} as const;

export const EMAIL_LOCALES = ['en'] as const;
export type EmailLocale = (typeof EMAIL_LOCALES)[number];

/**
 * Locale negotiation for a copy catalogue that currently ships one language.
 * An unsupported tag falls back to English rather than rendering half a
 * translated message.
 */
export function resolveEmailLocale(value?: string | null): EmailLocale {
  return value === 'en' ? value : 'en';
}

/** HTML-escapes text and attribute values. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Subjects and preview text are headers, not markup. Remove line breaks (header
 * injection) and angle brackets, collapse whitespace, and bound the length.
 */
export function headerText(value: string, maxLength = 180): string {
  return value
    .replace(/[<>\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/**
 * Only absolute http(s) links are allowed in an email. A template variable can
 * never introduce a `javascript:` or `data:` href.
 */
export function safeEmailUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
