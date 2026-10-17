// Shared scaffolding for the worker loops. Each loop is a plain
// do-work-then-wait ticker; keeping the retry/shutdown plumbing here means the
// loop bodies contain only their own logic.

import type {Logger} from '../logger.ts';

export interface LoopHandle {
  /** Resolves once the loop has finished its current iteration and exited. */
  stopped: Promise<void>;
  stop(): void;
}

export interface LoopOptions {
  name: string;
  logger: Logger;
  /** Pause between iterations that found nothing to do. */
  idleMs: number;
  /** Pause between iterations that did work — usually much shorter. */
  busyMs?: number;
}

/**
 * Runs `iteration` until stopped. The iteration reports whether it found work,
 * so a busy loop keeps going promptly while an idle one stops hammering the
 * database.
 */
export function startLoop(
  options: LoopOptions,
  iteration: () => Promise<boolean>,
): LoopHandle {
  let running = true;
  let wake: (() => void) | null = null;

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
    const timer = setTimeout(() => {
      wake = null;
      resolve();
    }, ms);
    // Shutdown should not wait out a full idle interval.
    wake = () => {
      clearTimeout(timer);
      wake = null;
      resolve();
    };
  });

  const stopped = (async () => {
    options.logger.info(`${options.name} loop started`);
    while (running) {
      let didWork = false;
      try {
        didWork = await iteration();
      } catch (e) {
        // An unexpected throw must not kill the loop; the next tick retries.
        options.logger.error(`${options.name} iteration failed`, {
          error: e instanceof Error ? e.message : String(e),
        });
      }
      if (!running) break;
      await sleep(didWork ? (options.busyMs ?? 0) : options.idleMs);
    }
    options.logger.info(`${options.name} loop stopped`);
  })();

  return {
    stopped,
    stop() {
      running = false;
      wake?.();
    },
  };
}
