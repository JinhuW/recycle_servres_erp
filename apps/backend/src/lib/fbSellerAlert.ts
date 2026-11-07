import type { SqlLike } from '../db';

// Tells managers about a seller-side event: in-app inside the transaction, and
// on Telegram after commit when a token and chat are set. The text gives the
// reason in words, never a status code.

export async function alertManagers(_tx: SqlLike, _a: { kind: string; title: string; reason: string; threadId?: number }): Promise<void> {
  throw new Error('alertManagers is not implemented');
}
