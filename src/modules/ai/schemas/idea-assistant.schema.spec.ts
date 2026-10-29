import { parseIdeaAssistantOutput } from './idea-assistant.schema';

describe('parseIdeaAssistantOutput', () => {
  it('accepts a plain rewrite object', () => {
    // #given a model response for an improve action
    const result = parseIdeaAssistantOutput(
      JSON.stringify({
        proposal: 'A clearer problem statement.',
        notes: ['Named the affected group.'],
        assumptions: [],
      }),
      'improve',
    );

    // #then the proposal survives
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.proposal).toBe('A clearer problem statement.');
  });

  it('accepts JSON wrapped in prose and a code fence', () => {
    // #given a response with a fenced object between sentences
    const result = parseIdeaAssistantOutput(
      'Here you go:\n```json\n{"proposal":"Short.","notes":[],"assumptions":[]}\n```',
      'shorten',
    );

    // #then the object is extracted
    expect(result.ok).toBe(true);
  });

  it('forces critique to return no replacement even if the model sends one', () => {
    // #given a critique that wrongly includes a proposal
    const result = parseIdeaAssistantOutput(
      JSON.stringify({
        proposal: 'Rewritten anyway',
        notes: ['The ask is vague.'],
        assumptions: [],
      }),
      'critique',
    );

    // #then the replacement is dropped
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.proposal).toBeNull();
  });

  it('rejects a critique with no notes', () => {
    // #given a critique with an empty notes array
    const result = parseIdeaAssistantOutput(
      JSON.stringify({ proposal: null, notes: [], assumptions: [] }),
      'critique',
    );

    // #then the response is unusable
    expect(result).toEqual({
      ok: false,
      reason: 'A critique returned no notes',
    });
  });

  it('rejects a rewrite with no proposal', () => {
    // #given an improve response without replacement text
    const result = parseIdeaAssistantOutput(
      JSON.stringify({ proposal: null, notes: ['n'], assumptions: [] }),
      'improve',
    );

    // #then the response is unusable
    expect(result).toEqual({
      ok: false,
      reason: 'A rewrite returned no proposal',
    });
  });

  it('rejects prose with no JSON object', () => {
    // #given a non-JSON answer
    const result = parseIdeaAssistantOutput('I cannot help with that.', 'expand');

    // #then it fails without throwing
    expect(result.ok).toBe(false);
  });

  it('rejects notes that exceed the item cap', () => {
    // #given too many notes
    const result = parseIdeaAssistantOutput(
      JSON.stringify({
        proposal: 'x',
        notes: ['1', '2', '3', '4', '5', '6'],
        assumptions: [],
      }),
      'improve',
    );

    // #then schema validation rejects it
    expect(result.ok).toBe(false);
  });
});
