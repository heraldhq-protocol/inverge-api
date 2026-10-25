import { BadRequestException } from '@nestjs/common';
import { encodeCursorValues, filterFingerprint } from '../../common/http/pagination';
import {
  commentKeysetWhere,
  decodeCommentCursor,
  encodeCommentCursor,
} from './comment-cursor';

const FINGERPRINT = filterFingerprint({
  route: 'ideas.comments',
  ideaId: 'idea-1',
  sort: 'highlighted_desc,likeCount_desc,createdAt_desc,id_desc',
});

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

describe('comment cursor', () => {
  const comment = {
    highlighted: true,
    likeCount: 4,
    createdAt: new Date('2026-10-21T12:00:00.000Z'),
    id: 'cm1',
  };

  it('round-trips the three mutable sort keys and the id', () => {
    const cursor = encodeCommentCursor(comment, FINGERPRINT);

    expect(decodeCommentCursor(cursor, FINGERPRINT)).toEqual(comment);
  });

  it('rejects a cursor from a different idea or sort', () => {
    const cursor = encodeCommentCursor(comment, FINGERPRINT);

    expect(
      codeOf(() => decodeCommentCursor(cursor, filterFingerprint({ ideaId: 'idea-2' }))),
    ).toBe('INVALID_CURSOR');
  });

  it('rejects a non-boolean highlighted value', () => {
    const cursor = encodeCursorValues(
      ['yes', '4', '2026-10-21T12:00:00.000Z'],
      'cm1',
      FINGERPRINT,
    );

    expect(codeOf(() => decodeCommentCursor(cursor, FINGERPRINT))).toBe(
      'INVALID_CURSOR',
    );
  });

  it('rejects a non-numeric like count', () => {
    const cursor = encodeCursorValues(
      ['true', 'lots', '2026-10-21T12:00:00.000Z'],
      'cm1',
      FINGERPRINT,
    );

    expect(codeOf(() => decodeCommentCursor(cursor, FINGERPRINT))).toBe(
      'INVALID_CURSOR',
    );
  });

  it('includes every unhighlighted row after a highlighted cursor', () => {
    expect(commentKeysetWhere(comment)).toEqual({
      OR: [
        { highlighted: false },
        { highlighted: true, likeCount: { lt: 4 } },
        { highlighted: true, likeCount: 4, createdAt: { lt: comment.createdAt } },
        { highlighted: true, likeCount: 4, createdAt: comment.createdAt, id: { lt: 'cm1' } },
      ],
    });
  });

  it('does not add an unhighlighted branch after an unhighlighted cursor', () => {
    expect(
      commentKeysetWhere({ ...comment, highlighted: false }),
    ).toEqual({
      OR: [
        { highlighted: false, likeCount: { lt: 4 } },
        { highlighted: false, likeCount: 4, createdAt: { lt: comment.createdAt } },
        { highlighted: false, likeCount: 4, createdAt: comment.createdAt, id: { lt: 'cm1' } },
      ],
    });
  });
});
