import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8'));
  return pkg.version ?? '0.0.0';
}

// The release version lives in the ROOT package.json (bumped on every dev
// push), not the backend's own package.json (pinned at 0.1.0). The workspace
// root ships in the image (pnpm needs it to install), so reading it at
// runtime works on Railway, where no release-time build args are passed.
let rootVersionCache: string | undefined;
export function readRootVersion(): string {
  if (rootVersionCache === undefined) {
    let version = 'unknown';
    try {
      const here = dirname(fileURLToPath(import.meta.url));
      const pkg = JSON.parse(
        readFileSync(join(here, '..', '..', '..', '..', 'package.json'), 'utf8'),
      );
      if (typeof pkg.version === 'string') version = pkg.version;
    } catch {
      // Fall through to 'unknown' — health must never fail on provenance.
    }
    rootVersionCache = version;
  }
  return rootVersionCache;
}
