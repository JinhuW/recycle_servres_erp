// A process-wide cap on how many of one expensive thing run at once, for work
// that pins the event loop or a lot of memory (bcrypt, image re-encodes).
// Callers past the cap queue; one that has waited `waitMs` gives up with the
// error `onTimeout` builds, so a flood sheds load instead of piling up.
export function createSemaphore(max: number, waitMs: number, onTimeout: () => Error) {
  let active = 0;
  const waiting: Array<() => void> = [];

  return async function run<T>(work: () => Promise<T>): Promise<T> {
    if (active >= max) {
      await new Promise<void>((resolve, reject) => {
        const go = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => {
          const i = waiting.indexOf(go);
          if (i >= 0) waiting.splice(i, 1);
          reject(onTimeout());
        }, waitMs);
        waiting.push(go);
      });
    } else {
      active++;
    }
    try {
      return await work();
    } finally {
      // The slot passes straight to the next waiter, so `active` only drops
      // when nobody is queued.
      const next = waiting.shift();
      if (next) next(); else active--;
    }
  };
}
