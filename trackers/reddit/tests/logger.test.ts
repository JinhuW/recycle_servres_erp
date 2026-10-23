import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createLogger, type ProblemHook} from '../src/logger.ts';

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// RS-376: the heartbeat learns about problems from the logger.
describe('problem hook', () => {
  it('sees warn and error lines with their scope, whatever the log level', () => {
    const seen: Parameters<ProblemHook>[] = [];
    const logger = createLogger('w-1', 'error', undefined, (...args) => seen.push(args));

    logger.child('evaluate').warn('evaluation failed', {error: '401'});
    logger.child('poll').child('reddit').error('blocked by reddit');
    logger.error('fatal', {error: 'boom'});

    expect(seen).toEqual([
      ['evaluate', 'warn', 'evaluation failed', {error: '401'}],
      ['poll:reddit', 'error', 'blocked by reddit', {}],
      ['', 'error', 'fatal', {error: 'boom'}],
    ]);
  });

  it('ignores info, debug and events', () => {
    const hook = vi.fn();
    const logger = createLogger('w-1', 'debug', 'poll', hook);

    logger.debug('fetching');
    logger.info('poll loop started');
    logger.event('post_evaluated', {verdict: 'target'});

    expect(hook).not.toHaveBeenCalled();
  });
});
