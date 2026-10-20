import { describe, it, expect } from 'vitest';
import { EVALUATOR_MODEL, summarizeTrial, TRIAL_MIN_LABELLED, type VsLive } from './tracker';

const cell = (posts: number, leads = 0, notLeads = 0) => ({ posts, leads, notLeads });

describe('summarizeTrial', () => {
  it('reads each cell as what promoting the candidate would gain, lose or drop', () => {
    const vs: VsLive = {
      both: cell(10, 4, 1),
      liveOnly: cell(8, 1, 5),
      candidateOnly: cell(3, 2, 0),
      neither: cell(250),
    };

    expect(summarizeTrial(vs)).toEqual({
      labelled: 13,
      unlabelled: 8,
      leadsGained: 2,
      leadsLost: 1,
      junkDropped: 5,
      junkAdded: 0,
      enoughData: false,
    });
  });

  it('leaves posts neither prompt flagged out, since nobody could react to them', () => {
    const vs: VsLive = { both: cell(0), liveOnly: cell(0), candidateOnly: cell(0), neither: cell(900) };

    expect(summarizeTrial(vs)).toMatchObject({ labelled: 0, unlabelled: 0 });
  });

  it(`calls the trial only once ${TRIAL_MIN_LABELLED} posts are labelled`, () => {
    const at = (leads: number): VsLive => ({
      both: cell(leads, leads), liveOnly: cell(0), candidateOnly: cell(0), neither: cell(0),
    });

    expect(summarizeTrial(at(TRIAL_MIN_LABELLED - 1)).enoughData).toBe(false);
    expect(summarizeTrial(at(TRIAL_MIN_LABELLED)).enoughData).toBe(true);
  });
});

describe('EVALUATOR_MODEL', () => {
  const entry = (id: string, structuredOutputs = true) => ({
    id, name: id, contextLength: 128000, promptPerM: 0.15, completionPerM: 0.6,
    structuredOutputs, inputModalities: ['text'], outputModalities: ['text'],
  });

  it('offers pinned structured-output models and drops floating aliases', () => {
    expect(EVALUATOR_MODEL(entry('anthropic/claude-haiku-5.5'))).toBe(true);
    expect(EVALUATOR_MODEL(entry('openai/gpt-4o-mini:batch'))).toBe(true);
    expect(EVALUATOR_MODEL(entry('~anthropic/claude-haiku-latest'))).toBe(false);
    expect(EVALUATOR_MODEL(entry('openrouter/auto', false))).toBe(false);
  });
});
