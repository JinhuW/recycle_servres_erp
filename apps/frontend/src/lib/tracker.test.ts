import { describe, it, expect } from 'vitest';
import {
  EVALUATOR_MODEL, evaluatorModelProblem, funnelCounts, summarizeTrial, TRIAL_MIN_LABELLED, workerHaystack,
  type TrackerWorker, type VsLive,
} from './tracker';

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

  it('accepts only an id the catalogue lists as an evaluator model', () => {
    const catalogue = [entry('openai/gpt-4o-mini'), entry('meta-llama/llama-3-8b-instruct', false)];
    expect(evaluatorModelProblem('openai/gpt-4o-mini', catalogue)).toBeNull();
    expect(evaluatorModelProblem('meta-llama/llama-3-8b-instruct', catalogue)).toBe('unlisted');
    expect(evaluatorModelProblem('vendor/not-in-catalogue', catalogue)).toBe('unlisted');
    expect(evaluatorModelProblem('openai/gpt-4o-mini', null)).toBe('loading');
    expect(evaluatorModelProblem('gpt-4o-mini', catalogue)).toBe('shape');
  });
});

describe('funnelCounts', () => {
  it('reads the window as one cohort: everything polled, then what passed each stage', () => {
    const stats = {
      posts: { new: 4, rejected: 30, target: 2, notified: 5, failed: 1 },
      oldestPending: null,
      failed: [],
    };

    expect(funnelCounts(stats)).toEqual({ poll: 42, evaluate: 7, notify: 5 });
  });

  it('counts a status with no posts as zero, and no stats as nothing', () => {
    expect(funnelCounts({ posts: { notified: 3 }, oldestPending: null, failed: [] }))
      .toEqual({ poll: 3, evaluate: 3, notify: 3 });
    expect(funnelCounts(null)).toBeNull();
  });
});

describe('workerHaystack', () => {
  const worker: TrackerWorker = {
    workerId: 'oci-7f3a', role: 'api', startedAt: '', lastHeartbeatAt: '', secondsSinceHeartbeat: 0, loops: {},
  };

  it('matches on the id, the raw role and the label the table shows', () => {
    expect(workerHaystack(worker, 'API 服务')).toBe('oci-7f3a api API 服务');
  });
});
