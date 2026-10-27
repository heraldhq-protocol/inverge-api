import {
  backerVerificationRequired,
  evaluateIdentityOnly,
  evaluateVerification,
  type VerificationFacts,
} from './verification-policy';
import { verificationFailure } from './verification-errors';
import type { CaseFacts } from './verification-policy';

const options = { policyVersion: 'test', requireKeyPeople: true };

function individual(over: Partial<CaseFacts> = {}): CaseFacts {
  return {
    features: ['ID_VERIFICATION', 'LIVENESS', 'FACE_MATCH', 'AML'],
    providerStatus: 'Approved',
    risk: 'CLEAR',
    state: 'APPROVED',
    ...over,
  };
}

function facts(over: Partial<VerificationFacts> = {}): VerificationFacts {
  return {
    accountType: 'INDIVIDUAL',
    business: null,
    individual: individual(),
    ...over,
  };
}

const approvedBusiness = {
  features: ['KYB_REGISTRY', 'KYB_DOCUMENTS', 'KYB_KEY_PEOPLE', 'AML'],
  providerStatus: 'Approved',
  registered: true,
  risk: 'CLEAR' as const,
  state: 'APPROVED' as const,
};

describe('evaluateVerification (individual)', () => {
  it('is eligible only when identity is approved and AML is clear', () => {
    expect(evaluateVerification(facts(), options).eligible).toBe(true);

    const noAml = evaluateVerification(
      facts({ individual: individual({ risk: 'NOT_ASSESSED' }) }),
      options,
    );
    expect(noAml.eligible).toBe(false);
    expect(noAml.blockers).toContain('Sanctions, PEP and adverse-media screening');
  });

  it('never treats a review as an approval', () => {
    const review = evaluateVerification(
      facts({ individual: individual({ risk: 'REVIEW', state: 'IN_REVIEW' }) }),
      options,
    );
    expect(review.eligible).toBe(false);
    expect(review.nextAction).toBe('resolve_review');
  });

  it('offers a retry after a decline and support after an error', () => {
    expect(
      evaluateVerification(
        facts({ individual: individual({ risk: 'NOT_ASSESSED', state: 'DECLINED' }) }),
        options,
      ).nextAction,
    ).toBe('retry');
    expect(
      evaluateVerification(
        facts({ individual: individual({ risk: 'NOT_ASSESSED', state: 'ERROR' }) }),
        options,
      ).nextAction,
    ).toBe('contact_support');
  });
});

describe('evaluateVerification (business)', () => {
  it('requires the representative identity as well as the business', () => {
    const missingRep = evaluateVerification(
      facts({ accountType: 'BUSINESS', business: approvedBusiness, individual: null }),
      options,
    );
    expect(missingRep.eligible).toBe(false);
    expect(missingRep.blockers).toContain('Authorised representative identity');
  });

  it('rejects a business approval that did not run key people', () => {
    const noKeyPeople = evaluateVerification(
      facts({
        accountType: 'BUSINESS',
        business: { ...approvedBusiness, features: ['KYB_REGISTRY'] },
        individual: individual(),
      }),
      options,
    );
    expect(noKeyPeople.eligible).toBe(false);
    expect(noKeyPeople.blockers).toContain(
      'Directors, beneficial owners and persons with control',
    );
  });

  it('asks for the business profile before verification when unregistered', () => {
    const evaluation = evaluateVerification(
      facts({
        accountType: 'BUSINESS',
        business: null,
        individual: individual(),
      }),
      options,
    );
    expect(evaluation.nextAction).toBe('complete_business_profile');
  });

  it('is eligible when business, key people, AML and the representative all pass', () => {
    expect(
      evaluateVerification(
        facts({
          accountType: 'BUSINESS',
          business: approvedBusiness,
          individual: individual(),
        }),
        options,
      ).eligible,
    ).toBe(true);
  });
});

describe('evaluateIdentityOnly', () => {
  it('grants the idea tier on identity alone', () => {
    const evaluation = evaluateIdentityOnly(
      { individual: individual({ risk: 'NOT_ASSESSED' }) },
      'test',
    );
    expect(evaluation.eligible).toBe(true);
  });
});

describe('verificationFailure', () => {
  it('returns the actionable code in precedence order', () => {
    const evaluation = evaluateVerification(
      facts({ individual: individual({ state: 'IN_REVIEW', risk: 'REVIEW' }) }),
      options,
    );
    expect(
      verificationFailure(facts({ individual: individual({ state: 'IN_REVIEW', risk: 'REVIEW' }) }), evaluation, {
        complianceHold: false,
      })?.code,
    ).toBe('VERIFICATION_IN_REVIEW');
  });

  it('reports a compliance hold ahead of a review state', () => {
    const f = facts({ individual: individual({ state: 'IN_REVIEW', risk: 'REVIEW' }) });
    const evaluation = evaluateVerification(f, options);
    expect(
      verificationFailure(f, evaluation, { complianceHold: true })?.code,
    ).toBe('VERIFICATION_COMPLIANCE_HOLD');
  });

  it('returns null when eligible and not held', () => {
    const f = facts();
    expect(
      verificationFailure(f, evaluateVerification(f, options), {
        complianceHold: false,
      }),
    ).toBeNull();
  });
});

describe('backerVerificationRequired', () => {
  it('requires verification only when the pledge crosses the threshold', () => {
    expect(backerVerificationRequired(0, 200, 200)).toBe(false);
    expect(backerVerificationRequired(150, 51, 200)).toBe(true);
  });

  it('fails closed on corrupt amounts', () => {
    expect(backerVerificationRequired(Number.NaN, 10, 200)).toBe(true);
  });
});
