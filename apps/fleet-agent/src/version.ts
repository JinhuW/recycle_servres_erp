import { readFileSync } from 'node:fs';

/**
 * The agent's version is the monorepo's: the image is tagged with the root
 * package.json version, and the image build writes it to VERSION next to dist.
 * A dev checkout reads the root manifest instead.
 */
export function agentVersion(): string {
  if (process.env.FLEET_AGENT_VERSION) return process.env.FLEET_AGENT_VERSION;
  for (const candidate of ['../VERSION', '../../../package.json']) {
    try {
      const text = readFileSync(new URL(candidate, import.meta.url), 'utf8');
      if (candidate.endsWith('.json')) {
        const v = (JSON.parse(text) as { version?: unknown }).version;
        if (typeof v === 'string') return v;
      } else if (text.trim()) {
        return text.trim();
      }
    } catch {
      // try the next
    }
  }
  return 'dev';
}
