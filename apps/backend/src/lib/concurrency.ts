// Run independent reads side by side without outrunning the pool. The prod
// pool is `max: 10`, and postgres.js pipelines queries past `max` onto busy
// connections rather than queueing them, so an unbounded Promise.all on one
// request can stall every other request sharing those connections. Pool
// `sql` only: inside `sql.begin` every query already rides one connection,
// and running them "in parallel" there just reorders them.

// The tuple bound returns `unknown`, not a Promise type: a contextual
// `PromiseLike<X>` return makes an untyped sql`` template infer its rows from
// X instead of its own default. A postgres.js query is a lazy thenable that
// only runs once awaited, which is also what keeps a queued task from
// starting early.
type Results<T extends readonly (() => unknown)[]> = {
  -readonly [K in keyof T]: Awaited<ReturnType<T[K]>>;
};

/** Runs `tasks` at most `limit` at a time; results keep the tasks' order.
 *  Rejects with the first failure, as Promise.all does — tasks already
 *  started still settle, but no new task starts after it. */
export function allLimited<const T extends readonly (() => unknown)[]>(
  tasks: T, limit?: number): Promise<Results<T>>;
export function allLimited<T>(tasks: readonly (() => PromiseLike<T>)[], limit?: number): Promise<T[]>;
export async function allLimited(
  tasks: readonly (() => unknown)[], limit = 4,
): Promise<unknown[]> {
  const out = new Array<unknown>(tasks.length);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < tasks.length) {
      const i = next++;
      try {
        out[i] = await tasks[i]();
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  const width = Math.max(1, Math.min(limit, tasks.length));
  await Promise.all(Array.from({ length: width }, worker));
  return out;
}
