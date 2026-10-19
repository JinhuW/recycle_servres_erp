import { describe, it, expect } from 'vitest';
import { summarizeTrial, TRIAL_MIN_LABELLED, type VsLive } from './tracker';

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
