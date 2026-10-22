import { BadRequestException } from '@nestjs/common';
import {
  asCursorDate,
  buildPage,
  clampPageSize,
  decodeCursor,
  decodeCursorValues,
  DISCOVERY_MAX_PAGE_SIZE,
  DISCOVERY_PAGE_SIZE,
  encodeCursor,
  encodeCursorValues,
  filterFingerprint,
  keysetCondition,
  stableStringify,
} from './pagination';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof BadRequestException) {
      const body = error.getResponse() as { code?: string };
      return body.code ?? '';
    }
    throw error;
  }
  throw new Error('expected the call to throw');
}

describe('filterFingerprint', () => {
  it('ignores object key order', () => {
    expect(filterFingerprint({ mine: false, sort: 'newest' })).toBe(
      filterFingerprint({ sort: 'newest', mine: false }),
    );
  });

  it('changes when a filter changes', () => {
    expect(filterFingerprint({ mine: false })).not.toBe(
      filterFingerprint({ mine: true }),
    );
  });

  it('is stable across calls', () => {
    const filters = { route: 'ideas.list', mine: false, viewer: null };
    expect(filterFingerprint(filters)).toBe(filterFingerprint({ ...filters }));
  });
});

describe('stableStringify', () => {
  it('sorts nested keys and keeps arrays in order', () => {
    expect(stableStringify({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(
      '{"a":[{"c":3,"d":2}],"b":1}',
    );
  });
});

describe('clampPageSize', () => {
  it('defaults to the discovery page size', () => {
    expect(clampPageSize(undefined)).toBe(DISCOVERY_PAGE_SIZE);
  });

  it('caps at the discovery maximum', () => {
    expect(clampPageSize(500)).toBe(DISCOVERY_MAX_PAGE_SIZE);
  });

  it('never returns less than one', () => {
    expect(clampPageSize(0)).toBe(1);
  });
});

describe('cursor round trip', () => {
  const fingerprint = filterFingerprint({ route: 'ideas.list' });

  it('encodes and decodes the sort value and id', () => {
    const cursor = encodeCursor('2026-10-21T12:00:00.000Z', 'cm1', fingerprint);

    expect(decodeCursor(cursor, fingerprint)).toEqual({
      sortValue: '2026-10-21T12:00:00.000Z',
      id: 'cm1',
    });
  });

  it('rejects a cursor bound to different filters', () => {
    const cursor = encodeCursor('2026-10-21T12:00:00.000Z', 'cm1', fingerprint);

    expect(
      codeOf(() => decodeCursor(cursor, filterFingerprint({ mine: true }))),
    ).toBe('INVALID_CURSOR');
  });

  it.each(['not-a-cursor', '', 'e30'])('rejects %p', (cursor) => {
    expect(codeOf(() => decodeCursor(cursor, fingerprint))).toBe('INVALID_CURSOR');
  });

  it('rejects a payload with the wrong shape', () => {
    const body = Buffer.from(JSON.stringify({ v: 2, k: ['a', 'b'], f: fingerprint }))
      .toString('base64url');

    expect(codeOf(() => decodeCursor(body, fingerprint))).toBe('INVALID_CURSOR');
  });
});

describe('compound cursor', () => {
  const fingerprint = filterFingerprint({ route: 'ideas.comments' });

  it('round-trips several sort values plus the id', () => {
    const cursor = encodeCursorValues(
      ['true', '3', '2026-10-21T12:00:00.000Z'],
      'cm1',
      fingerprint,
    );

    expect(decodeCursorValues(cursor, fingerprint, 3)).toEqual({
      values: ['true', '3', '2026-10-21T12:00:00.000Z'],
      id: 'cm1',
    });
  });

  it('rejects a cursor decoded with the wrong number of sort values', () => {
    const cursor = encodeCursorValues(['true', '3', '2026-10-21T12:00:00.000Z'], 'cm1', fingerprint);

    expect(codeOf(() => decodeCursorValues(cursor, fingerprint, 2))).toBe(
      'INVALID_CURSOR',
    );
  });
});

describe('asCursorDate', () => {
  it('parses an ISO timestamp', () => {
    expect(asCursorDate('2026-10-21T12:00:00.000Z').toISOString()).toBe(
      '2026-10-21T12:00:00.000Z',
    );
  });

  it('rejects a non-date', () => {
    expect(codeOf(() => asCursorDate('yesterday'))).toBe('INVALID_CURSOR');
  });
});

describe('keysetCondition', () => {
  const cursor = { sortValue: '2026-10-21T12:00:00.000Z', id: 'cm1' };

  it('looks strictly beyond the row for a descending sort', () => {
    expect(keysetCondition('createdAt', 'desc', cursor, asCursorDate)).toEqual({
      OR: [
        { createdAt: { lt: new Date('2026-10-21T12:00:00.000Z') } },
        { createdAt: new Date('2026-10-21T12:00:00.000Z'), id: { lt: 'cm1' } },
      ],
    });
  });

  it('looks strictly beyond the row for an ascending sort', () => {
    expect(keysetCondition('deadline', 'asc', cursor, asCursorDate)).toEqual({
      OR: [
        { deadline: { gt: new Date('2026-10-21T12:00:00.000Z') } },
        { deadline: new Date('2026-10-21T12:00:00.000Z'), id: { gt: 'cm1' } },
      ],
    });
  });
});

describe('buildPage', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const cursorFor = (row: { id: string }) => `cursor:${row.id}`;

  it('trims the probe row and points at the last returned item', () => {
    const page = buildPage(rows, 2, cursorFor);

    expect(page.data).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(page.page).toEqual({
      limit: 2,
      nextCursor: 'cursor:b',
      hasMore: true,
      total: null,
      totalKind: 'omitted',
    });
  });

  it('reports the final page without a cursor', () => {
    const page = buildPage(rows, 3, cursorFor);

    expect(page.page.hasMore).toBe(false);
    expect(page.page.nextCursor).toBeNull();
  });

  it('does not emit a cursor for an empty page', () => {
    const page = buildPage([], 2, cursorFor);

    expect(page.page).toEqual({
      limit: 2,
      nextCursor: null,
      hasMore: false,
      total: null,
      totalKind: 'omitted',
    });
  });
});
