import { AML_GENERIC_EXTERNAL, buildBrief, buildReasons, route } from './moderation-routing';
import { CategoryFinding } from '../../ports/moderation/moderation.port';

const cat = (code: string, riskScore: number, draftReason = 'reframe'): CategoryFinding =>
  ({ code: code as any, riskScore, excerpt: 'x', draftReason });

describe('route (FR-1004, D1 no auto-reject)', () => {
  it('auto-clears when L1 passes and no category is flagged', () => {
    expect(route(true, [], [])).toEqual({ decision: 'AUTO_CLEAR', reasonCodes: [] });
  });

  it('holds when a category is at/above threshold', () => {
    expect(route(true, [], ['POL-SEC'])).toEqual({ decision: 'HELD_FOR_REVIEW', reasonCodes: ['POL-SEC'] });
  });

  it('holds on an L1 failure (merging L1 + L2 codes, de-duped)', () => {
    expect(route(false, ['L1-SUBMITTER-BANNED'], ['POL-SEC'])).toEqual({
      decision: 'HELD_FOR_REVIEW',
      reasonCodes: ['L1-SUBMITTER-BANNED', 'POL-SEC'],
    });
  });

  it('never returns a REJECT outcome even at max risk (auto-reject disabled)', () => {
    expect(route(true, [], ['POL-SEC', 'POL-CAT']).decision).toBe('HELD_FOR_REVIEW');
  });
});

describe('buildReasons (FR-1006 dual reasons, FR-1007/D2 tipping-off)', () => {
  it('uses the generic external reason whenever POL-AML contributes — even as a hold', () => {
    const { internalReason, externalReason } = buildReasons([], [cat('POL-AML', 0.8, 'structuring')], ['POL-AML']);
    expect(externalReason).toBe(AML_GENERIC_EXTERNAL);
    expect(externalReason).not.toMatch(/aml|launder|financial.crime|structuring/i);
    expect(internalReason).toMatch(/POL-AML/); // full detail retained internally
  });

  it('gives creator-facing coaching for a non-AML flag', () => {
    const { externalReason } = buildReasons([], [cat('POL-SEC', 0.9, 'Remove ROI language.')], ['POL-SEC']);
    expect(externalReason).toBe('Remove ROI language.');
  });

  it('empty external reason on a clean auto-clear', () => {
    expect(buildReasons([], [], []).externalReason).toBe('');
  });
});

describe('buildBrief (FR-1005)', () => {
  it('summarizes L1 outcome and L2 flags with suggested reason codes', () => {
    const brief = buildBrief('idea', true, [], [cat('POL-SEC', 0.9)], 'HELD_FOR_REVIEW');
    expect(brief).toMatch(/decision: HELD_FOR_REVIEW/);
    expect(brief).toMatch(/L1 gates: passed/);
    expect(brief).toMatch(/L2 POL-SEC risk=0.9/);
    expect(brief).toMatch(/suggested reason: POL-SEC/);
  });

  it('notes an L1 hold', () => {
    expect(buildBrief('idea', false, ['L1-SUBMITTER-BANNED'], [], 'HELD_FOR_REVIEW')).toMatch(
      /L1 gates: HELD \(L1-SUBMITTER-BANNED\)/,
    );
  });
});
