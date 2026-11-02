import { aiEntitlement } from './ai-entitlement.service';
import type { AiAccessGrant } from '../../generated/prisma/client';

const NOW = new Date('2026-10-29T12:00:00.000Z');

function grant(overrides: Partial<AiAccessGrant> = {}): AiAccessGrant {
  return {
    id: 'grant-1',
    userId: 'user-1',
    status: 'APPROVED',
    source: 'ADMIN',
    requestedAt: NOW,
    decidedAt: NOW,
    decidedBy: 'admin-1',
    expiresAt: null,
    externalReference: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as AiAccessGrant;
}

describe('aiEntitlement', () => {
  it('gives an admin access without a grant or request', () => {
    // #given an admin account
    const result = aiEntitlement('ADMIN', null, NOW);

    // #then the assistant is available and no request is shown
    expect(result).toEqual({
      premium: true,
      requestStatus: 'NOT_REQUIRED',
      canRequest: false,
    });
  });

  it('keeps an account without a grant locked but requestable', () => {
    // #given an ordinary account with no grant row
    const result = aiEntitlement('USER', null, NOW);

    // #then the assistant is locked and the request path is open
    expect(result).toEqual({
      premium: false,
      requestStatus: 'NONE',
      canRequest: true,
    });
  });

  it('unlocks only an approved, unexpired grant', () => {
    // #given an approved grant that expires in the future
    const result = aiEntitlement(
      'USER',
      grant({ expiresAt: new Date('2026-11-29T12:00:00.000Z') }),
      NOW,
    );

    // #then access is granted and a new request is not offered
    expect(result.premium).toBe(true);
    expect(result.requestStatus).toBe('APPROVED');
    expect(result.canRequest).toBe(false);
  });

  it('treats an expired approval as expired and requestable again', () => {
    // #given an approved grant whose expiry has passed
    const result = aiEntitlement(
      'USER',
      grant({ expiresAt: new Date('2026-10-28T12:00:00.000Z') }),
      NOW,
    );

    // #then the assistant is locked and the creator can request again
    expect(result.premium).toBe(false);
    expect(result.requestStatus).toBe('EXPIRED');
    expect(result.canRequest).toBe(true);
  });

  it('does not offer a second request while one is pending', () => {
    // #given a pending request
    const result = aiEntitlement('USER', grant({ status: 'PENDING' }), NOW);

    // #then the assistant stays locked and the request button is hidden
    expect(result.premium).toBe(false);
    expect(result.requestStatus).toBe('PENDING');
    expect(result.canRequest).toBe(false);
  });

  it('allows a rejected creator to request again', () => {
    // #given a rejected request
    const result = aiEntitlement('USER', grant({ status: 'REJECTED' }), NOW);

    // #then access is still locked but a new request is allowed
    expect(result.premium).toBe(false);
    expect(result.requestStatus).toBe('REJECTED');
    expect(result.canRequest).toBe(true);
  });
});
