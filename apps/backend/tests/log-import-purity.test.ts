import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// src/lib/log.ts must stay importable by BARE NODE: the container's CMD runs
// `node ./scripts/migrate.mjs && node ./scripts/init-admin.mjs && pnpm start`
// (Dockerfile), and both .mjs scripts import the .ts module directly, relying
// on Node's TypeScript type-stripping. That resolves only while every import in
// log.ts is a `node:` builtin — the rest of src/ uses extensionless specifiers
// which bare node cannot resolve. Break it and the container fails to BOOT, so
// the constraint needs a test rather than the header comment at log.ts:13.

const here = dirname(fileURLToPath(import.meta.url));
const backendRoot = join(here, '..');
const logModule = join(backendRoot, 'src', 'lib', 'log.ts');
const migrateScript = join(backendRoot, 'scripts', 'migrate.mjs');
const initAdminScript = join(backendRoot, 'scripts', 'init-admin.mjs');

// DATABASE_URL='' — NEVER `delete process.env.DATABASE_URL`. The repo-root .env
// defines it, and scripts/load-env.mjs fills any key ABSENT from process.env,
// so deleting it hands the script the developer's real dev database and
// init-admin.mjs writes an admin row into it. Present-but-empty is skipped by
// dotenv and still trips each script's `if (!url)` guard.
const NO_DB = { ...process.env, DATABASE_URL: '' };

/** Parsed JSON log lines from a stream; non-JSON noise is dropped. */
function logLines(stream: string): Array<Record<string, unknown>> {
  return stream
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('log.ts stays importable by bare node', () => {
  it('loads and emits under plain node with no transpiler', () => {
    // Strictly stronger than reading the source: this proves every specifier
    // resolves, that the syntax survives type-stripping (an enum or a
    // parameter property would fail here and nowhere else — tsconfig does not
    // set erasableSyntaxOnly), and that the package.json walk in
    // readRootVersion still resolves from the file's real on-disk location,
    // which a vitest-resolved import can never verify.
    const src = `import { log } from ${JSON.stringify(pathToFileURL(logModule).href)};`
      + ` log.info('purity probe');`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], {
      encoding: 'utf8',
      env: { ...process.env, APP_VERSION: '', GIT_SHA: '' },
    });

    expect(r.status, `bare node could not load log.ts:\n${r.stderr}`).toBe(0);
    const [line] = logLines(r.stdout);
    expect(line).toMatchObject({ level: 'info', message: 'purity probe' });
    expect(line.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('imports only node: builtins', () => {
    // Redundant with the probe above, but it names the offending import
    // instead of failing with an exit code and a module-resolution stack.
    const source = readFileSync(logModule, 'utf8');
    const specifiers = [...source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)]
      .map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const spec of specifiers) {
      expect(spec.startsWith('node:'), `log.ts imports "${spec}" — it must import only`
        + ' node: builtins so the .mjs boot scripts can load it under bare node'
        + ' (see the header comment in src/lib/log.ts)').toBe(true);
    }
  });
});

describe('boot scripts run under bare node', () => {
  // The container CMD chain is gated on exit codes, so "reached its own guard
  // and exited 1" is the real assertion — a module-resolution failure also
  // exits non-zero, but prints no log line of ours.
  it.each([
    { name: 'migrate.mjs', script: migrateScript, module: 'migrate' },
    { name: 'init-admin.mjs', script: initAdminScript, module: 'init-admin' },
  ])('$name reaches its own DATABASE_URL guard', ({ script, module }) => {
    const r = spawnSync(process.execPath, [script], { encoding: 'utf8', env: NO_DB });

    expect(r.status, `${script} did not reach its guard:\n${r.stderr}`).toBe(1);
    const line = logLines(r.stderr).find((l) => l.module === module);
    expect(line, `no ${module} log line in:\n${r.stderr}`).toBeDefined();
    expect(line).toMatchObject({ level: 'error', module });
    expect(String(line!.message)).toContain('DATABASE_URL is not set');
    expect(line!.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
