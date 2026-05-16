# Cloudflare Workers → Docker Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the Recycle ERP backend as a self-hosted Docker stack (Node + Hono + Postgres + Caddy) instead of a Cloudflare Worker, keeping R2 storage via its S3-compatible API.

**Architecture:** The existing Hono `app` is unchanged; a new `src/server.ts` serves it with `@hono/node-server`, injecting an `Env` built from `process.env` (replacing Cloudflare bindings). R2 is accessed via `@aws-sdk/client-s3` against R2's S3 endpoint. Workers AI is removed (OpenRouter is the prod default; stub stays for tests). The container runs TypeScript directly with `tsx` (no emit step — the codebase uses extensionless imports + `moduleResolution: Bundler`, which `tsc` emit cannot produce without rewriting every import). One `docker compose up` runs Postgres, the backend, and a Caddy service that serves the built SPA and reverse-proxies `/api/*`.

**Tech Stack:** Node 22, Hono, `@hono/node-server`, `@aws-sdk/client-s3`, `tsx`, `postgres` (postgres-js), pnpm workspaces, Docker Compose, Caddy 2.

---

## File Structure

**Backend (`apps/backend/`):**
- `src/types.ts` — modify: `Env` loses Cloudflare bindings (`HYPERDRIVE`, `AI`, `R2_ATTACHMENTS` object, `CF_*`), gains R2 S3 config fields.
- `src/r2.ts` — rewrite: S3 SDK upload/delete; stub fallback preserved.
- `src/env.ts` — create: `buildEnv()` reads `process.env` → `Env`.
- `src/server.ts` — create: `@hono/node-server` entry point.
- `src/db.ts` — modify: drop `HYPERDRIVE` branch.
- `src/ai/index.ts` — modify: drop `workers-ai` provider branch.
- `src/ai/types.ts` — modify: `OcrProvider` drops `'workers-ai'`.
- `src/ai/workers-ai.ts` — delete.
- `scripts/migrate.mjs`, `scripts/seed.mjs` — modify: load `.env` not `.dev.vars`.
- `package.json` — modify: scripts + deps.
- `tsconfig.json` — modify: `types: ["node"]`.
- `wrangler.toml` — delete.
- `Dockerfile`, `.dockerignore` — create.
- `tests/helpers/app.ts` — modify: `testEnv` field rename only if needed (it isn't — see Task 8 note).
- `tests/scan-r2.test.ts` — modify: S3-mock contract.
- `tests/ai.test.ts` — modify: drop workers-ai case.

**Frontend (`apps/frontend/`):**
- `Dockerfile` — create: build SPA → serve via Caddy + reverse-proxy `/api`.
- `Caddyfile` — create.

**Repo root:**
- `docker-compose.yml` — modify: add `backend` and `web` services.
- `.dev.vars` → `.env` — rename (git-ignored already).
- `README.md` — modify: deployment section.

---

## Task 1: Add Node/S3 dependencies

**Files:**
- Modify: `apps/backend/package.json`

- [ ] **Step 1: Add runtime deps and remove wrangler**

In `apps/backend/package.json`, set `dependencies` and `devDependencies` to:

```json
  "dependencies": {
    "@aws-sdk/client-s3": "^3.700.0",
    "@hono/node-server": "^1.13.7",
    "@recycle-erp/shared": "workspace:*",
    "@tsndr/cloudflare-worker-jwt": "^3.1.4",
    "bcryptjs": "^2.4.3",
    "hono": "^4.6.14",
    "postgres": "^3.4.5",
    "tsx": "^4.21.0"
  },
  "devDependencies": {
    "@types/bcryptjs": "^2.4.6",
    "@types/node": "^25.6.2",
    "dotenv": "^16.4.7",
    "typescript": "^5.7.2",
    "vitest": "^4.1.5"
  }
```

(`tsx` moves devDeps→deps; `wrangler` and `@cloudflare/workers-types` removed.)

- [ ] **Step 2: Install**

Run: `cd /srv/data/recycle_erp && pnpm install`
Expected: completes; `pnpm-lock.yaml` updated; `@aws-sdk/client-s3` and `@hono/node-server` resolved.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/package.json pnpm-lock.yaml
git commit -m "build(backend): add node-server + aws s3 sdk, drop wrangler deps"
```

---

## Task 2: Replace Cloudflare bindings in the Env type

**Files:**
- Modify: `apps/backend/src/types.ts:1-27`

- [ ] **Step 1: Rewrite the Env type**

Replace lines 1–27 (the header comment through the end of the `Env` type) with:

```typescript
// App configuration, built from process.env (see src/env.ts). Passed to the
// Hono app as `Bindings` so existing `c.env` / getDb(c.env) call sites work
// unchanged.

export type Env = {
  DATABASE_URL?: string;
  JWT_SECRET: string;
  JWT_ISSUER?: string;
  STUB_LOW_CONF?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_OCR_MODEL?: string;
  // Cloudflare R2 via its S3-compatible API. When any of endpoint / key /
  // secret / bucket is missing, uploadAttachment returns a stub (dev/tests).
  R2_S3_ENDPOINT?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET?: string;
  R2_ATTACHMENTS_PUBLIC_URL?: string;
};
```

- [ ] **Step 2: Verify it compiles in isolation**

Run: `cd /srv/data/recycle_erp/apps/backend && pnpm tsc --noEmit 2>&1 | head -20`
Expected: errors ONLY in `src/r2.ts`, `src/db.ts`, `src/ai/*`, and the two named tests (they still reference removed fields). No other files. This confirms the blast radius matches Tasks 3–6.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/types.ts
git commit -m "refactor(backend): Env holds plain config, not CF bindings"
```

---

## Task 3: Rewrite r2.ts to use the S3 SDK (TDD)

**Files:**
- Test: `apps/backend/tests/r2.test.ts` (create)
- Modify: `apps/backend/src/r2.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/backend/tests/r2.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const send = vi.fn();
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(() => ({ send })),
  PutObjectCommand: vi.fn((input) => ({ __type: 'Put', input })),
  DeleteObjectCommand: vi.fn((input) => ({ __type: 'Delete', input })),
}));

import { uploadAttachment, deleteAttachment } from '../src/r2';
import type { Env } from '../src/types';

const s3Env: Env = {
  JWT_SECRET: 'x',
  R2_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
  R2_ACCESS_KEY_ID: 'AK',
  R2_SECRET_ACCESS_KEY: 'SK',
  R2_BUCKET: 'recycle-erp-attachments',
  R2_ATTACHMENTS_PUBLIC_URL: 'https://cdn.example.com',
};

function jpeg(): File {
  return new File([new Uint8Array([0xff, 0xd8])], 'My Label.jpg', { type: 'image/jpeg' });
}

describe('r2 via S3 API', () => {
  beforeEach(() => { send.mockReset(); send.mockResolvedValue({}); });

  it('uploads to S3 and returns a real public URL', async () => {
    const r = await uploadAttachment(s3Env, jpeg(), 'label-scans');
    expect(r.provider).toBe('r2');
    expect(r.storageKey).toMatch(/^label-scans\/[0-9a-f-]+-My_Label\.jpg$/);
    expect(r.deliveryUrl).toBe(`https://cdn.example.com/${r.storageKey}`);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('returns a stub when S3 is unconfigured', async () => {
    const r = await uploadAttachment({ JWT_SECRET: 'x' } as Env, jpeg(), 'p');
    expect(r.provider).toBe('stub');
    expect(r.storageKey.startsWith('stub-')).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it('deletes a real key, skips stub keys', async () => {
    await deleteAttachment(s3Env, 'label-scans/abc-x.jpg');
    expect(send).toHaveBeenCalledTimes(1);
    send.mockClear();
    await deleteAttachment(s3Env, 'stub-123');
    expect(send).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /srv/data/recycle_erp/apps/backend && pnpm vitest run tests/r2.test.ts`
Expected: FAIL — `src/r2.ts` still references `env.R2_ATTACHMENTS` (type error / wrong behavior).

- [ ] **Step 3: Rewrite src/r2.ts**

Replace the entire contents of `apps/backend/src/r2.ts` with:

```typescript
// Attachment storage for sell-order status evidence and label-scan images.
// Uses Cloudflare R2 via its S3-compatible API. When the R2 env vars are
// absent (dev / tests), returns a stub key + data: URL so the app still works.

import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { Env } from './types';

export type UploadResult = {
  storageKey: string;
  deliveryUrl: string;
  provider: 'r2' | 'stub';
};

function client(env: Env): S3Client | null {
  if (
    !env.R2_S3_ENDPOINT ||
    !env.R2_ACCESS_KEY_ID ||
    !env.R2_SECRET_ACCESS_KEY ||
    !env.R2_BUCKET ||
    !env.R2_ATTACHMENTS_PUBLIC_URL
  ) {
    return null;
  }
  return new S3Client({
    region: 'auto',
    endpoint: env.R2_S3_ENDPOINT,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });
}

export async function uploadAttachment(
  env: Env,
  file: File,
  prefix: string,
): Promise<UploadResult> {
  const s3 = client(env);
  if (!s3) {
    const stubId = 'stub-' + crypto.randomUUID();
    return {
      storageKey: stubId,
      deliveryUrl: `data:${file.type || 'application/octet-stream'};name=${encodeURIComponent(file.name)}`,
      provider: 'stub',
    };
  }

  const safeName = file.name.replace(/[^A-Za-z0-9._-]+/g, '_');
  const key = `${prefix}/${crypto.randomUUID()}-${safeName}`;
  const body = new Uint8Array(await file.arrayBuffer());
  await s3.send(
    new PutObjectCommand({
      Bucket: env.R2_BUCKET,
      Key: key,
      Body: body,
      ContentType: file.type || 'application/octet-stream',
    }),
  );
  return {
    storageKey: key,
    deliveryUrl: `${env.R2_ATTACHMENTS_PUBLIC_URL!.replace(/\/$/, '')}/${key}`,
    provider: 'r2',
  };
}

export async function deleteAttachment(env: Env, storageKey: string): Promise<void> {
  if (storageKey.startsWith('stub-')) return;
  const s3 = client(env);
  if (!s3) return;
  await s3.send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET, Key: storageKey }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /srv/data/recycle_erp/apps/backend && pnpm vitest run tests/r2.test.ts`
Expected: PASS — all 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/r2.ts apps/backend/tests/r2.test.ts
git commit -m "feat(backend): R2 attachments via S3 API instead of Worker binding"
```

---

## Task 4: Update the R2 integration test to the S3 contract

**Files:**
- Modify: `apps/backend/tests/scan-r2.test.ts:20-49,76-90`

- [ ] **Step 1: Inspect current assertions**

Run: `cd /srv/data/recycle_erp && sed -n '60,100p' apps/backend/tests/scan-r2.test.ts`
Expected: shows the second `it` block (`env = { R2_ATTACHMENTS: bucket, ... }` around line 80) so you replace both occurrences.

- [ ] **Step 2: Replace the Worker-bucket fake with an S3 mock**

At the top of `apps/backend/tests/scan-r2.test.ts`, after the existing imports on lines 1–4, add:

```typescript
const s3Send = vi.fn(async () => ({}));
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(() => ({ send: s3Send })),
  PutObjectCommand: vi.fn((input) => ({ input })),
  DeleteObjectCommand: vi.fn((input) => ({ input })),
}));

const S3_ENV = {
  R2_S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
  R2_ACCESS_KEY_ID: 'AK',
  R2_SECRET_ACCESS_KEY: 'SK',
  R2_BUCKET: 'recycle-erp-attachments',
  R2_ATTACHMENTS_PUBLIC_URL: PUBLIC_BASE,
};
```

(Move the `const PUBLIC_BASE = 'https://cdn.example.com';` line above this block if it is currently declared below it.)

- [ ] **Step 3: Swap the two env injections and the put assertion**

Replace the first injection (line ~29):

```typescript
      { token, env: S3_ENV },
```

Replace the second injection (line ~80):

```typescript
    const env = S3_ENV;
```

Replace the `expect(put).toHaveBeenCalledTimes(1);` assertion (line ~35) with:

```typescript
    expect(s3Send).toHaveBeenCalledTimes(1);
```

Delete the now-unused `const put = vi.fn(...)` / `const fakeBucket = ...` lines (≈21–22) and any later `bucket`/`put` references in the second block, replacing a `bucket` fake with reliance on `s3Send`.

- [ ] **Step 4: Run the test**

Run: `cd /srv/data/recycle_erp/apps/backend && pnpm vitest run tests/scan-r2.test.ts`
Expected: PASS — image stored via S3 mock, `delivery_url` flows through `label_scans` → order-line JOIN exactly as before.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/tests/scan-r2.test.ts
git commit -m "test(backend): scan-r2 asserts S3 contract, not Worker binding"
```

---

## Task 5: Remove the Workers AI OCR provider

**Files:**
- Delete: `apps/backend/src/ai/workers-ai.ts`
- Modify: `apps/backend/src/ai/index.ts`, `apps/backend/src/ai/types.ts:4`, `apps/backend/tests/ai.test.ts:113-114`

- [ ] **Step 1: Update the ai.test.ts expectation (failing first)**

In `apps/backend/tests/ai.test.ts`, delete the test at lines 113–114:

```typescript
  it('workers-ai when AI bound and no OpenRouter key', () => {
    expect(pickProvider({ AI: { run: async () => ({}) } } as unknown as Env)).toBe('workers-ai');
  });
```

If an adjacent test asserts `pickProvider({})` → `'stub'`, leave it; otherwise add right where the deleted test was:

```typescript
  it('stub when neither OpenRouter key nor any AI is configured', () => {
    expect(pickProvider({ JWT_SECRET: 'x' } as Env)).toBe('stub');
  });
```

- [ ] **Step 2: Delete the provider module**

Run: `git rm apps/backend/src/ai/workers-ai.ts`
Expected: file removed.

- [ ] **Step 3: Simplify ai/index.ts**

Replace the entire contents of `apps/backend/src/ai/index.ts` with:

```typescript
// Label OCR. Two providers behind one interface:
//
//   openrouter:  frontier vision model via OpenRouter (default; best accuracy)
//   stub:        deterministic canned extraction (offline dev / tests / demo)
//
// Provider is picked by credential presence — see pickProvider. openrouter
// fails fast; the scan route turns a throw into a 502 so the field user
// retries the shot.

import type { Env, LineCategory } from '../types';
import type { ScanResult, OcrProvider } from './types';
import { stubScan } from './stub';
import { openRouterScan } from './openrouter';

export type { ScanResult, OcrProvider } from './types';
export { CONFIDENCE_FLOOR } from './types';

export function pickProvider(env: Env): OcrProvider {
  if (env.OPENROUTER_API_KEY) return 'openrouter';
  return 'stub';
}

export async function scanLabel(
  env: Env,
  category: LineCategory,
  imageBytes: ArrayBuffer,
): Promise<ScanResult> {
  switch (pickProvider(env)) {
    case 'openrouter':
      return openRouterScan(env, category, imageBytes);
    default:
      return stubScan(env, category);
  }
}
```

- [ ] **Step 4: Drop `'workers-ai'` from the OcrProvider union**

In `apps/backend/src/ai/types.ts` line 4, change:

```typescript
export type OcrProvider = 'stub' | 'openrouter';
```

- [ ] **Step 5: Run the AI tests**

Run: `cd /srv/data/recycle_erp/apps/backend && pnpm vitest run tests/ai.test.ts`
Expected: PASS — no `workers-ai` references remain.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/src/ai/ apps/backend/tests/ai.test.ts
git commit -m "refactor(backend): drop Workers AI OCR provider (OpenRouter only)"
```

---

## Task 6: Drop the Hyperdrive branch in db.ts

**Files:**
- Modify: `apps/backend/src/db.ts:1-34`

- [ ] **Step 1: Update the header comment and createClient**

In `apps/backend/src/db.ts`, replace lines 1–2:

```typescript
// Postgres client. Connection string comes from DATABASE_URL. One pooled
// client per request, torn down when the request ends.
```

Then in `createClient` (line ~26) replace:

```typescript
  const url = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
```

with:

```typescript
  const url = env.DATABASE_URL;
```

Leave the `prepare: false` option and its comment as-is (still desirable; harmless on direct Postgres).

- [ ] **Step 2: Typecheck db.ts path**

Run: `cd /srv/data/recycle_erp/apps/backend && pnpm tsc --noEmit 2>&1 | grep -c "src/db.ts" || echo 0`
Expected: `0` — no remaining type errors in db.ts.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/db.ts
git commit -m "refactor(backend): db reads DATABASE_URL only (no Hyperdrive)"
```

---

## Task 7: Add buildEnv() (TDD)

**Files:**
- Test: `apps/backend/tests/env.test.ts` (create)
- Create: `apps/backend/src/env.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/backend/tests/env.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildEnv } from '../src/env';

describe('buildEnv', () => {
  it('maps process.env into the Env shape', () => {
    const env = buildEnv({
      DATABASE_URL: 'postgres://x',
      JWT_SECRET: 's',
      OPENROUTER_API_KEY: 'k',
      R2_BUCKET: 'b',
    } as NodeJS.ProcessEnv);
    expect(env.DATABASE_URL).toBe('postgres://x');
    expect(env.JWT_SECRET).toBe('s');
    expect(env.OPENROUTER_API_KEY).toBe('k');
    expect(env.R2_BUCKET).toBe('b');
    expect(env.JWT_ISSUER).toBe('recycle-erp');
  });

  it('throws when JWT_SECRET is missing', () => {
    expect(() => buildEnv({} as NodeJS.ProcessEnv)).toThrow(/JWT_SECRET/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /srv/data/recycle_erp/apps/backend && pnpm vitest run tests/env.test.ts`
Expected: FAIL — `src/env.ts` does not exist.

- [ ] **Step 3: Create src/env.ts**

```typescript
// Builds the app Env from process.env. Replaces Cloudflare's injected
// bindings now that the backend runs as a plain Node process.

import type { Env } from './types';

export function buildEnv(src: NodeJS.ProcessEnv = process.env): Env {
  if (!src.JWT_SECRET) throw new Error('JWT_SECRET is not configured');
  return {
    DATABASE_URL: src.DATABASE_URL,
    JWT_SECRET: src.JWT_SECRET,
    JWT_ISSUER: src.JWT_ISSUER ?? 'recycle-erp',
    STUB_LOW_CONF: src.STUB_LOW_CONF,
    OPENROUTER_API_KEY: src.OPENROUTER_API_KEY,
    OPENROUTER_OCR_MODEL: src.OPENROUTER_OCR_MODEL,
    R2_S3_ENDPOINT: src.R2_S3_ENDPOINT,
    R2_ACCESS_KEY_ID: src.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: src.R2_SECRET_ACCESS_KEY,
    R2_BUCKET: src.R2_BUCKET,
    R2_ATTACHMENTS_PUBLIC_URL: src.R2_ATTACHMENTS_PUBLIC_URL,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /srv/data/recycle_erp/apps/backend && pnpm vitest run tests/env.test.ts`
Expected: PASS — both tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/env.ts apps/backend/tests/env.test.ts
git commit -m "feat(backend): buildEnv() maps process.env to Env"
```

---

## Task 8: Add the Node HTTP server entry point

**Files:**
- Create: `apps/backend/src/server.ts`

Note: `tests/helpers/app.ts` imports `app` from `src/index.ts` and calls `app.fetch(req, env)` directly. `server.ts` is a *separate* entry that is never imported by tests, so the test harness needs no change here.

- [ ] **Step 1: Create src/server.ts**

```typescript
// Node entry point. Serves the existing Hono app with @hono/node-server,
// injecting an Env built from process.env in place of Cloudflare bindings.
// @hono/node-server otherwise passes Node's req/res as `env`, which would
// shadow our config — so we pass buildEnv() explicitly per request.

import 'dotenv/config';
import { serve } from '@hono/node-server';
import app from './index';
import { buildEnv } from './env';

const env = buildEnv();
const port = Number(process.env.PORT ?? 8787);

serve({ fetch: (request) => app.fetch(request, env), port }, (info) => {
  console.log(`recycle-erp-backend listening on :${info.port}`);
});
```

- [ ] **Step 2: Verify the server boots against the dev database**

Run:
```bash
cd /srv/data/recycle_erp && docker compose up -d postgres && \
cd apps/backend && DATABASE_URL=postgres://recycle:recycle@localhost:5432/recycle_erp \
JWT_SECRET=dev-secret pnpm tsx src/server.ts &
sleep 3 && curl -s localhost:8787/ && kill %1
```
Expected: prints `recycle-erp-backend listening on :8787` then JSON `{"service":"recycle-erp-backend","docs":"/api/* — see README.md"}`.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/server.ts
git commit -m "feat(backend): @hono/node-server entry point"
```

---

## Task 9: Switch scripts/config off Wrangler

**Files:**
- Modify: `apps/backend/package.json`, `apps/backend/tsconfig.json`, `apps/backend/scripts/migrate.mjs:13-24`, `apps/backend/scripts/seed.mjs:12-21`
- Rename: `apps/backend/.dev.vars` → `apps/backend/.env`
- Delete: `apps/backend/wrangler.toml`

- [ ] **Step 1: Update package.json scripts**

Set the `scripts` block in `apps/backend/package.json` to:

```json
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "start": "tsx src/server.ts",
    "db:migrate": "node ./scripts/migrate.mjs",
    "db:seed": "node ./scripts/seed.mjs",
    "db:reset": "node ./scripts/migrate.mjs --reset && node ./scripts/seed.mjs",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  }
```

- [ ] **Step 2: Point tsconfig at Node types**

In `apps/backend/tsconfig.json`, change `"types": ["@cloudflare/workers-types"]` to:

```json
    "types": ["node"],
```

- [ ] **Step 3: Rename the env file**

Run: `cd /srv/data/recycle_erp/apps/backend && git mv .dev.vars .env 2>/dev/null || mv .dev.vars .env`
(`.env` is already git-ignored, so it leaves the index — that is expected and correct; secrets stay untracked.)

Then edit `apps/backend/.env`: delete the `CF_ACCOUNT_ID` / `CF_IMAGES_TOKEN` lines and their comment block, and add the R2 S3 settings:

```
R2_S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=<R2_ACCESS_KEY_ID>
R2_SECRET_ACCESS_KEY=<R2_SECRET_ACCESS_KEY>
R2_BUCKET=recycle-erp-attachments
R2_ATTACHMENTS_PUBLIC_URL=https://static.recycleservers.com
```

(The `<...>` values are the R2 API token credentials you generate in the Cloudflare dashboard — R2 → Manage API Tokens.)

- [ ] **Step 4: Make migrate.mjs / seed.mjs read .env**

In `apps/backend/scripts/migrate.mjs`, replace the `loadDevVars()` function and its call (lines ~13–24) with nothing — `import 'dotenv/config'` (already present at line 9) loads `.env` from the backend dir automatically. Do the same in `apps/backend/scripts/seed.mjs` (lines ~12–21). Keep the `import 'dotenv/config';` line in both.

- [ ] **Step 5: Delete wrangler.toml**

Run: `git rm apps/backend/wrangler.toml`

- [ ] **Step 6: Full typecheck + test suite**

Run: `cd /srv/data/recycle_erp/apps/backend && pnpm typecheck && pnpm test`
Expected: typecheck clean (no `@cloudflare/workers-types` needed); all test files pass, including `r2.test.ts`, `env.test.ts`, `scan-r2.test.ts`, `ai.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/package.json apps/backend/tsconfig.json apps/backend/scripts/migrate.mjs apps/backend/scripts/seed.mjs
git rm --cached apps/backend/wrangler.toml 2>/dev/null; git add -A apps/backend/wrangler.toml 2>/dev/null
git commit -m "build(backend): tsx dev/start, .env config, drop wrangler.toml"
```

---

## Task 10: Backend Dockerfile

**Files:**
- Create: `apps/backend/Dockerfile`, `apps/backend/.dockerignore`

- [ ] **Step 1: Create apps/backend/.dockerignore**

```
node_modules
dist
.env
*.log
```

- [ ] **Step 2: Create apps/backend/Dockerfile**

Build context is the repo root (pnpm workspace needs `@recycle-erp/shared` and the lockfile):

```dockerfile
# Build context: repository root.
FROM node:22-slim AS base
RUN corepack enable
WORKDIR /app

# Workspace manifests first for layer caching.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/backend/package.json apps/backend/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter recycle-erp-backend...

# Source.
COPY packages/shared packages/shared
COPY apps/backend apps/backend

WORKDIR /app/apps/backend
ENV NODE_ENV=production
EXPOSE 8787
# Run migrations, then start the server (single instance — no migration race).
CMD ["sh", "-c", "node ./scripts/migrate.mjs && pnpm start"]
```

- [ ] **Step 3: Build the image**

Run: `cd /srv/data/recycle_erp && docker build -f apps/backend/Dockerfile -t recycle-erp-backend .`
Expected: build succeeds; final image tagged `recycle-erp-backend`.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/Dockerfile apps/backend/.dockerignore
git commit -m "build(backend): Dockerfile (node22 + tsx, migrate-then-serve)"
```

---

## Task 11: Frontend Dockerfile + Caddy

**Files:**
- Create: `apps/frontend/Dockerfile`, `apps/frontend/Caddyfile`, `apps/frontend/.dockerignore`

- [ ] **Step 1: Create apps/frontend/.dockerignore**

```
node_modules
dist
*.log
```

- [ ] **Step 2: Create apps/frontend/Caddyfile**

Caddy serves the built SPA and reverse-proxies the API to the backend container. `:80` inside the container; TLS terminates at the host/edge.

```
:80 {
	encode gzip
	# API → backend container.
	handle /api/* {
		reverse_proxy backend:8787
	}
	# SPA static assets with history-API fallback.
	handle {
		root * /srv
		try_files {path} /index.html
		file_server
	}
}
```

- [ ] **Step 3: Create apps/frontend/Dockerfile**

Build context is the repo root:

```dockerfile
# Build context: repository root.
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/frontend/package.json apps/frontend/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter recycle-erp-frontend...
COPY packages/shared packages/shared
COPY apps/frontend apps/frontend
RUN pnpm --filter recycle-erp-frontend build

FROM caddy:2-alpine
COPY apps/frontend/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/frontend/dist /srv
EXPOSE 80
```

- [ ] **Step 4: Build the image**

Run: `cd /srv/data/recycle_erp && docker build -f apps/frontend/Dockerfile -t recycle-erp-web .`
Expected: Vite build succeeds; final `caddy:2-alpine` image tagged `recycle-erp-web` with `/srv/index.html` present.

- [ ] **Step 5: Commit**

```bash
git add apps/frontend/Dockerfile apps/frontend/Caddyfile apps/frontend/.dockerignore
git commit -m "build(frontend): Dockerfile + Caddy (static SPA + /api proxy)"
```

---

## Task 12: Wire the full stack in docker-compose

**Files:**
- Modify: `docker-compose.yml`

- [ ] **Step 1: Replace docker-compose.yml**

Keep the existing `postgres` service and `volumes`; add `backend` and `web`:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    container_name: recycle_pg
    restart: unless-stopped
    environment:
      POSTGRES_USER: recycle
      POSTGRES_PASSWORD: recycle
      POSTGRES_DB: recycle_erp
    ports:
      - "5432:5432"
    volumes:
      - recycle_pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U recycle -d recycle_erp"]
      interval: 5s
      timeout: 3s
      retries: 10

  backend:
    build:
      context: .
      dockerfile: apps/backend/Dockerfile
    container_name: recycle_backend
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    env_file:
      - apps/backend/.env
    environment:
      DATABASE_URL: postgres://recycle:recycle@postgres:5432/recycle_erp
      PORT: "8787"
    expose:
      - "8787"

  web:
    build:
      context: .
      dockerfile: apps/frontend/Dockerfile
    container_name: recycle_web
    restart: unless-stopped
    depends_on:
      - backend
    ports:
      - "8080:80"

volumes:
  recycle_pgdata:
```

(`DATABASE_URL` in `environment` overrides any `.env` value so the backend reaches the `postgres` service by its compose hostname. The host-facing app is `http://localhost:8080`.)

- [ ] **Step 2: Bring the stack up**

Run: `cd /srv/data/recycle_erp && docker compose up -d --build && sleep 15 && docker compose ps`
Expected: `postgres` healthy, `backend` and `web` running.

- [ ] **Step 3: Smoke test the stack**

Run:
```bash
docker compose logs backend --tail 20
curl -s localhost:8080/api/auth/demo-accounts
curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/
```
Expected: backend log shows migrations applied + `listening on :8787`; demo-accounts returns JSON; `/` returns `200` (SPA `index.html`).

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml
git commit -m "build: full-stack docker compose (postgres + backend + web)"
```

---

## Task 13: Documentation cleanup

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Rewrite the architecture/deploy sections**

In `README.md`, replace the Cloudflare-specific bullets (the `backend/` description ~lines 7–9, the ASCII diagram ~line 49, and the entire `## Deployment notes` section ~lines 99+) with a Docker description:

```markdown
- **`backend/`** — Node + Hono + Postgres. Runs as a container; R2 (via its
  S3 API) stores label-scan images and sell-order attachments. OpenRouter
  vision does OCR, with a deterministic stub fallback so dev/tests run offline.
```

```
┌─────────────────┐  HTTPS  ┌──────────────────────┐
│  React SPA      │ ──────▶ │  Caddy (web)         │
│  (served by     │         │   / → static SPA     │
│   Caddy)        │         │   /api → backend     │
└─────────────────┘         └──────────┬───────────┘
                                       │
                            ┌──────────▼───────────┐
                            │  backend (Node/Hono) │
                            │  Postgres · R2(S3) · │
                            │  OpenRouter OCR      │
                            └──────────────────────┘
```

```markdown
## Deployment

Single-host Docker Compose:

1. Create `apps/backend/.env` with `JWT_SECRET`, `OPENROUTER_API_KEY`, and the
   R2 S3 settings (`R2_S3_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
   `R2_BUCKET=recycle-erp-attachments`,
   `R2_ATTACHMENTS_PUBLIC_URL=https://static.recycleservers.com`). Generate the
   R2 credentials in the Cloudflare dashboard → R2 → Manage API Tokens.
2. `docker compose up -d --build`
3. App is served at `http://<host>:8080` (put it behind your TLS-terminating
   edge / reverse proxy). The backend runs DB migrations on start.

Local dev (no containers except Postgres): `docker compose up -d postgres`,
then `pnpm --filter recycle-erp-backend dev` and
`pnpm --filter recycle-erp-frontend dev`.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README reflects Docker deployment, not Cloudflare"
```

---

## Task 14: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Clean typecheck + full test suite**

Run: `cd /srv/data/recycle_erp/apps/backend && pnpm typecheck && pnpm test`
Expected: typecheck clean; every test file PASSES (no `wrangler`, `@cloudflare/workers-types`, `R2_ATTACHMENTS` binding, or `workers-ai` references remain).

- [ ] **Step 2: No Cloudflare residue**

Run: `cd /srv/data/recycle_erp && grep -rn "wrangler\|R2_ATTACHMENTS\b\|workers-ai\|HYPERDRIVE\|@cloudflare/workers-types" apps/backend/src apps/backend/package.json apps/backend/tsconfig.json docker-compose.yml || echo "CLEAN"`
Expected: `CLEAN` (the only allowed remaining mention of Cloudflare is R2 *S3* config and prose in README/comments).

- [ ] **Step 3: Cold-start the full stack from scratch**

Run:
```bash
cd /srv/data/recycle_erp && docker compose down -v && docker compose up -d --build && sleep 20 && \
curl -s -X POST localhost:8080/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"alex@recycleservers.com","password":"demo"}' | head -c 200
```
Expected: a JSON response containing a JWT `token` — proving migrations ran, Postgres is reachable, and the SPA→Caddy→backend→Postgres path works end-to-end on a fresh volume.

- [ ] **Step 4: Final commit (if any docs/nits remain)**

```bash
git status --porcelain
# commit anything outstanding, else nothing to do
```

---

## Self-Review Notes

- **Spec coverage:** runtime seam → Tasks 7/8/9; R2 S3 seam → Tasks 2/3/4; Workers AI removal → Task 5; containers & tooling → Tasks 9/10/11/12; verification → Tasks 8/12/14; docs → Task 13. Hyperdrive removal (implied by "plain config fields") → Task 6. All spec sections covered.
- **Deviation from spec (documented):** spec said "multi-stage build with `tsc` → `dist`"; the codebase's `noEmit` + `moduleResolution: Bundler` + extensionless imports make `tsc` emit impractical without rewriting every import. The plan runs `tsx` in-container instead. Intent (containerized long-running Node process, single `docker compose up`) is preserved.
- **Test contract changes:** `scan-r2.test.ts` and `ai.test.ts` assert the Cloudflare binding contract directly, so the spec's "suite essentially untouched" is qualified — exactly two tests change (Tasks 4, 5), nothing else.
- **Type consistency:** `Env` keeps its name and all surviving fields; `UploadResult`, `OcrProvider`, `buildEnv`, `pickProvider` signatures are consistent across tasks. New env vars (`R2_S3_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`) are identical in `types.ts`, `env.ts`, `r2.ts`, tests, `.env`, and compose.
