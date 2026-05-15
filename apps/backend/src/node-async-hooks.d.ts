// Minimal ambient types for node:async_hooks. The Workers runtime provides the
// real implementation via the `nodejs_compat` compatibility flag; this only
// satisfies the type checker (the project pins `types` to workers-types and has
// no @types/node, so the built-in module is otherwise untyped).
declare module 'node:async_hooks' {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined;
    run<R>(store: T, callback: () => R): R;
  }
}
