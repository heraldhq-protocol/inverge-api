import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';

/**
 * Discovery collections are keyset-paginated. A page is addressed by the last
 * item the client saw, never by an offset: an offset page repeats or skips rows
 * when something is inserted or re-scored.
 *
 * The cursor is opaque to clients. It carries the last row's sort value and id
 * plus a fingerprint of the active filter/sort, so reusing a cursor under a
 * different query fails loudly instead of returning a mixed result set.
 */

export const DISCOVERY_PAGE_SIZE = 24;
export const DISCOVERY_MAX_PAGE_SIZE = 50;

export type PageInfo = {
  limit: number;
  nextCursor: string | null;
  hasMore: boolean;
  total: number | null;
  totalKind: 'exact' | 'estimated' | 'omitted';
};

export type ListPage<T> = {
  data: T[];
  page: PageInfo;
};

type CursorBody = {
  v: 1;
  k: [string, string];
  f: string;
};

export type Cursor = {
  sortValue: string;
  id: string;
};

export type KeysetDirection = 'asc' | 'desc';

function invalidCursor(): BadRequestException {
  return new BadRequestException({
    code: 'INVALID_CURSOR',
    message: 'The cursor is invalid or belongs to a different query. Restart from the first page.',
  });
}

/** JSON with object keys sorted, so the same filters always hash the same. */
export function stableStringify(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);

  return `{${entries.join(',')}}`;
}

/** A short, stable fingerprint of the filters and sort a cursor is bound to. */
export function filterFingerprint(filters: Record<string, unknown>): string {
  return createHash('sha256')
    .update(stableStringify(filters))
    .digest('base64url')
    .slice(0, 12);
}

export function clampPageSize(requested: number | undefined): number {
  if (requested === undefined) return DISCOVERY_PAGE_SIZE;
  return Math.min(Math.max(requested, 1), DISCOVERY_MAX_PAGE_SIZE);
}

export function encodeCursor(
  sortValue: string,
  id: string,
  fingerprint: string,
): string {
  const body: CursorBody = { v: 1, k: [sortValue, id], f: fingerprint };
  return Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string, fingerprint: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }

  if (parsed === null || typeof parsed !== 'object') throw invalidCursor();

  const body = parsed as Record<string, unknown>;
  if (body.v !== 1) throw invalidCursor();
  if (!Array.isArray(body.k) || body.k.length !== 2) throw invalidCursor();
  if (typeof body.f !== 'string' || body.f !== fingerprint) throw invalidCursor();

  const [sortValue, id] = body.k;
  if (typeof sortValue !== 'string' || sortValue.length === 0) throw invalidCursor();
  if (typeof id !== 'string' || id.length === 0) throw invalidCursor();

  return { sortValue, id };
}

/** Parses a cursor's ISO timestamp, rejecting a payload that was never ours. */
export function asCursorDate(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw invalidCursor();
  return date;
}

/**
 * The `where` fragment for "strictly after this row" in a compound
 * `(field, id)` ordering. Expressed as a comparison rather than Prisma's
 * `cursor` so a deleted cursor row still yields the correct next page.
 */
export function keysetCondition(
  field: string,
  direction: KeysetDirection,
  cursor: Cursor,
  parse: (value: string) => unknown = (value) => value,
): Record<string, unknown> {
  const value = parse(cursor.sortValue);
  const beyond = direction === 'asc' ? 'gt' : 'lt';

  return {
    OR: [
      { [field]: { [beyond]: value } },
      { [field]: value, id: { [beyond]: cursor.id } },
    ],
  };
}

/**
 * Turns `limit + 1` fetched rows into a page. The extra row is how `hasMore` is
 * known without a `COUNT(*)`; discovery never pays for an exact total.
 */
export function buildPage<T>(
  rows: T[],
  limit: number,
  cursorFor: (row: T) => string,
): ListPage<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];

  return {
    data,
    page: {
      limit,
      nextCursor: hasMore && last ? cursorFor(last) : null,
      hasMore,
      total: null,
      totalKind: 'omitted',
    },
  };
}
