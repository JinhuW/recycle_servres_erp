// The write side of the preferences provider, kept out of React so the two
// rules it has to keep can be tested: saves go to the server one at a time,
// in order, and a reply is applied only to the identity it was sent for.
// The provider used to start a PATCH per debounce window without waiting for
// the previous one, and every reply replaced the whole bag — two edits 400 ms
// apart could settle out of order and the older reply undo the newer choice,
// and a reply started for one user could land after the next had signed in.
export type PrefBag = Record<string, unknown>;

export type PrefRollback = { values: PrefBag; absent: Set<string> };

export type PrefSaver = {
  save: (batch: PrefBag, rollback: PrefRollback) => Promise<void>;
};

export function createPrefSaver(opts: {
  patch: (batch: PrefBag) => Promise<PrefBag>;
  identity: () => string | null;
  onServer: (server: PrefBag) => void;
  onRollback: (keys: string[], rollback: PrefRollback) => void;
}): PrefSaver {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    save(batch, rollback) {
      const forUser = opts.identity();
      const run = async () => {
        try {
          const server = await opts.patch(batch);
          if (opts.identity() !== forUser) return;
          opts.onServer(server);
        } catch (err) {
          if (opts.identity() !== forUser) return;
          opts.onRollback(Object.keys(batch), rollback);
          throw err;
        }
      };
      const next = chain.then(run, run);
      chain = next.catch(() => undefined);
      return next;
    },
  };
}
