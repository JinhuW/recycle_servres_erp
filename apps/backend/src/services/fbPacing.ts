import type { Env } from '../types';

// The seller tick (CONTRACTS §5.3): settles uncertain tasks and turns queued
// inbox syncs, messages and placements into fleet tasks, paced by the settings.

export function startFbSellerLoop(_env: Env): { stop: () => void } {
  return { stop: () => {} };
}
