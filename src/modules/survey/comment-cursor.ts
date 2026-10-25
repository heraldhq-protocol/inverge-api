import type { Prisma } from '../../generated/prisma/client';
import {
  asCursorDate,
  decodeCursorValues,
  encodeCursorValues,
  invalidCursor,
} from '../../common/http/pagination';

/**
 * Comments are ordered by highlighted, likes, recency, then id. All four values
 * are part of the cursor because any of the first three can tie.
 *
 * The first three keys are mutable: a like or a highlight between page requests
 * can move a comment across the cursor. That is inherent to engagement ordering
 * and is accepted; the id tie-breaker guarantees no duplicate within a stable
 * page. A client that needs an immutable scroll should sort by recency instead.
 */
export interface CommentCursor {
  highlighted: boolean;
  likeCount: number;
  createdAt: Date;
  id: string;
}

export function encodeCommentCursor(
  comment: Pick<CommentCursor, 'highlighted' | 'likeCount' | 'createdAt' | 'id'>,
  fingerprint: string,
): string {
  return encodeCursorValues(
    [
      comment.highlighted ? 'true' : 'false',
      String(comment.likeCount),
      comment.createdAt.toISOString(),
    ],
    comment.id,
    fingerprint,
  );
}

export function decodeCommentCursor(
  value: string,
  fingerprint: string,
): CommentCursor {
  const { values, id } = decodeCursorValues(value, fingerprint, 3);
  const [highlighted, likeCount, createdAt] = values;

  if (highlighted !== 'true' && highlighted !== 'false') {
    throw invalidCursor();
  }
  if (!/^\d{1,12}$/.test(likeCount) || !Number.isSafeInteger(Number(likeCount))) {
    throw invalidCursor();
  }

  return {
    highlighted: highlighted === 'true',
    likeCount: Number(likeCount),
    createdAt: asCursorDate(createdAt),
    id,
  };
}

/** Rows strictly after the cursor in `highlighted, likeCount, createdAt, id` DESC. */
export function commentKeysetWhere(
  cursor: CommentCursor,
): Prisma.IdeaCommentWhereInput {
  const or: Prisma.IdeaCommentWhereInput[] = [];
  // `highlighted DESC`: after a highlighted row, every unhighlighted row follows.
  // A false cursor has nothing below it in this key.
  if (cursor.highlighted) or.push({ highlighted: false });

  or.push(
    {
      highlighted: cursor.highlighted,
      likeCount: { lt: cursor.likeCount },
    },
    {
      highlighted: cursor.highlighted,
      likeCount: cursor.likeCount,
      createdAt: { lt: cursor.createdAt },
    },
    {
      highlighted: cursor.highlighted,
      likeCount: cursor.likeCount,
      createdAt: cursor.createdAt,
      id: { lt: cursor.id },
    },
  );

  return { OR: or };
}
