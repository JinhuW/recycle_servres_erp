import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8'));
  return pkg.version ?? '0.0.0';
}

// When the running image was built — what the UI shows in place of a commit
// sha. Stamped into the image by the Dockerfile rather than handed in as a
// build arg: release.sh could supply one, but Railway builds every prod deploy
// and passes no args, nor does it inject a build timestamp of its own. Null on
// a host `pnpm dev` run, where no image exists.
let buildTimeCache: string | null | undefined;
export function readBuildTime(): string | null {
  if (buildTimeCache === undefined) {
    let stamp: string | null = null;
    try {
      const here = dirname(fileURLToPath(import.meta.url));
      const raw = readFileSync(join(here, '..', '..', '..', '..', 'BUILD_TIME'), 'utf8').trim();
      if (raw) stamp = raw;
    } catch {
      // Fall through to null — health must never fail on provenance.
    }
    buildTimeCache = stamp;
  }
  return buildTimeCache;
}
