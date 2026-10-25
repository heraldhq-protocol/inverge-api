import type { TransformFnParams } from 'class-transformer';

/**
 * Parses a boolean query value.
 *
 * `class-transformer`'s `@Type(() => Boolean)` calls `Boolean(value)`, so the
 * string `"false"` becomes `true` — a query-string bug, not a coercion quirk.
 * This returns only recognised boolean spellings and passes everything else
 * through unchanged, so `@IsBoolean()` rejects it with a 400 instead of silently
 * treating a typo as `false`.
 */
export function parseBoolean(value: unknown): unknown {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return value;

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return value;
}

/** `@Transform` adapter for {@link parseBoolean}. */
export function parseBooleanQuery({ value }: TransformFnParams): unknown {
  return parseBoolean(value);
}
