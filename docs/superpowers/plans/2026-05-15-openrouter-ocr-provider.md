# OpenRouter OCR Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an OpenRouter vision provider as the default label-OCR backend, behind the existing `scanLabel` interface, replacing `STUB_OCR` with credential-presence selection.

**Architecture:** `src/ai.ts` is split into a focused `src/ai/` module — `types.ts` (shared types, breaks the index↔provider import cycle), `prompts.ts`, `stub.ts`, `workers-ai.ts`, `openrouter.ts`, `index.ts` (selection + orchestration, re-exports the public surface). Provider chosen by `pickProvider(env)`: OpenRouter key → Workers AI binding → stub. OpenRouter/Workers-AI fail fast; the scan route returns 502 so the field user retries.

**Tech Stack:** TypeScript, Cloudflare Workers (Hono), Vitest, OpenRouter chat-completions API, Postgres.

**Spec:** `docs/superpowers/specs/2026-05-15-openrouter-ocr-provider-design.md`

**Deviation from spec §1 (intentional):** spec lists 5 files; this plan adds `src/ai/types.ts` (6 files) to hold `ScanResult`/`OcrProvider`/`CONFIDENCE_FLOOR` with zero deps. This removes the circular `index ↔ provider` type import and lets every task compile and test independently. The public surface is unchanged — `index.ts` re-exports these, so `import { scanLabel, ScanResult, CONFIDENCE_FLOOR } from '../ai'` still resolves.

**Working directory:** all paths are under `apps/backend/`. Run all commands from `apps/backend/`.

**Commit hygiene:** `main` has unrelated WIP (`src/db.ts`, `src/index.ts`). Every commit uses explicit `git add <paths>` — never `git add -A` / `git add .`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/ai/types.ts` (create) | `ScanResult`, `OcrProvider`, `CONFIDENCE_FLOOR`. No imports except `LineCategory`. |
| `src/ai/prompts.ts` (create) | `PROMPT_BY_CATEGORY` (RAM prompt gains PC-code + form-factor rules), `parseModelJson`. |
| `src/ai/stub.ts` (create) | `STUB_BY_CATEGORY`, `stubScan` (incl. `STUB_LOW_CONF`). |
| `src/ai/workers-ai.ts` (create) | `workersAiScan` — current Llama 3.2 logic, unchanged. |
| `src/ai/openrouter.ts` (create) | `openRouterScan` + `sniffMime`, `toBase64`. |
| `src/ai/index.ts` (create) | `pickProvider`, `scanLabel`; re-exports public surface. |
| `src/ai.ts` (delete) | Replaced by `src/ai/`. |
| `src/types.ts` (modify) | Env: add `OPENROUTER_API_KEY?`, `OPENROUTER_OCR_MODEL?`; remove `STUB_OCR?`. |
| `src/routes/scan.ts` (modify) | Wrap `scanLabel` in try/catch → 502. |
| `tests/helpers/app.ts` (modify) | `multipart()` gains `env` override; drop `STUB_OCR` from `testEnv`. |
| `tests/ai.test.ts` (create) | Unit: `pickProvider`, `parseModelJson`, `stubScan`, `openRouterScan` (mocked fetch). |
| `tests/scan.test.ts` (create) | Route integration: stub path, openrouter path, 502 on failure. |
| `wrangler.toml`, `.dev.vars.example`, `README.md` (modify) | Remove `STUB_OCR`; document OpenRouter. |

Run a single test file: `npx vitest run tests/<file>.ts`. Full suite: `npm test`. Typecheck: `npm run typecheck`. Tests need Postgres up (`docker compose up -d` from repo root) and `TEST_DATABASE_URL` (already in `.dev.vars`).

---

### Task 1: Shared types module

**Files:**
- Create: `src/ai/types.ts`

- [ ] **Step 1: Create the file**

```ts
// src/ai/types.ts
import type { LineCategory } from '../types';

export type OcrProvider = 'stub' | 'workers-ai' | 'openrouter';

export type ScanResult = {
  category: LineCategory;
  confidence: number;
  fields: Record<string, string>;
  provider: OcrProvider;
};

// Below this overall confidence we do NOT autofill the form — the user
// enters the line manually. Keep in sync with the frontend gate.
export const CONFIDENCE_FLOOR = 0.6;
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors; file is dependency-free apart from a type import).

- [ ] **Step 3: Commit**

```bash
git add src/ai/types.ts
git commit -m "feat(ocr): add shared ai types module"
```

---

### Task 2: Prompts + JSON parser

**Files:**
- Create: `src/ai/prompts.ts`
- Test: `tests/ai.test.ts`

- [ ] **Step 1: Write the failing test** (create `tests/ai.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { parseModelJson, PROMPT_BY_CATEGORY } from '../src/ai/prompts';

describe('parseModelJson', () => {
  it('parses plain JSON', () => {
    expect(parseModelJson('{"brand":"Samsung"}')).toEqual({ brand: 'Samsung' });
  });
  it('strips ```json fences', () => {
    expect(parseModelJson('```json\n{"brand":"Micron"}\n```')).toEqual({ brand: 'Micron' });
  });
  it('extracts JSON embedded in prose', () => {
    expect(parseModelJson('Here you go: {"capacity":"32GB"} done')).toEqual({ capacity: '32GB' });
  });
  it('returns null when no JSON present', () => {
    expect(parseModelJson('no json here')).toBeNull();
  });
});

describe('PROMPT_BY_CATEGORY', () => {
  it('RAM prompt encodes the PC-code rule', () => {
    expect(PROMPT_BY_CATEGORY.RAM).toContain('PC4');
    expect(PROMPT_BY_CATEGORY.RAM).toContain('SODIMM = laptop');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ai.test.ts`
Expected: FAIL — cannot find module `../src/ai/prompts`.

- [ ] **Step 3: Create `src/ai/prompts.ts`**

```ts
// src/ai/prompts.ts
import type { LineCategory } from '../types';

export const PROMPT_BY_CATEGORY: Record<LineCategory, string> = {
  RAM: `You are reading a server RAM module label. Extract these fields and respond as compact JSON only:
{"brand":"Samsung|SK Hynix|Micron|Kingston|Other","capacity":"… GB","type":"DDR3|DDR4|DDR5","classification":"UDIMM|RDIMM|LRDIMM|SODIMM","rank":"1Rx16|1Rx8|1Rx4|2Rx16|2Rx8|2Rx4|4Rx8|4Rx4|8Rx4","speed":"MT/s number only","partNumber":"…"}
TYPE — use the "PC" code printed on the label, never infer the type from speed alone:
  PC2-… = DDR2, PC3-…/PC3L-… = DDR3, PC4-… = DDR4, PC5-… = DDR5.
CLASSIFICATION — from the module form factor: SODIMM = laptop, UDIMM = desktop, RDIMM/LRDIMM/ECC = server.
Only include a field if you can read it clearly on the label. Omit any field you are unsure about — do NOT guess. No prose.`,
  SSD: `You are reading an enterprise SSD label. Respond as compact JSON only:
{"brand":"…","capacity":"… GB or TB","interface":"SATA|SAS|NVMe|U.2","formFactor":"2.5\\"|M.2 2280|M.2 22110|U.2|AIC","partNumber":"…"}
Omit unknown fields. No prose.`,
  HDD: `You are reading an enterprise HDD label. Respond as compact JSON only:
{"brand":"…","capacity":"… TB","interface":"SATA|SAS","formFactor":"2.5\\"|3.5\\"","rpm":"5400|7200|10000|15000","partNumber":"…"}
Omit unknown fields. No prose.`,
  Other: `You are reading a server-component label (CPU, NIC, PSU, GPU, etc). Respond as compact JSON only:
{"description":"human-readable name","partNumber":"…"}
No prose.`,
};

// Models sometimes wrap JSON in ``` fences or add stray prose. Strip fences,
// try a direct parse, then fall back to the first {…} block.
export function parseModelJson(text: string): Record<string, unknown> | null {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned
      .replace(/^```(?:json)?\s*\n?/, '')
      .replace(/\n?```\s*$/, '')
      .trim();
  }
  try {
    return JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ai.test.ts`
Expected: PASS (6 assertions).

- [ ] **Step 5: Commit**

```bash
git add src/ai/prompts.ts tests/ai.test.ts
git commit -m "feat(ocr): add shared prompts + robust JSON parser"
```

---

### Task 3: Stub provider

**Files:**
- Create: `src/ai/stub.ts`
- Test: `tests/ai.test.ts` (append)

- [ ] **Step 1: Append failing tests to `tests/ai.test.ts`**

Add these imports at the top of the file (merge with existing import lines):

```ts
import { stubScan } from '../src/ai/stub';
import type { Env } from '../src/types';
```

Append this block:

```ts
describe('stubScan', () => {
  it('returns canned RAM extraction by default', () => {
    const r = stubScan({} as Env, 'RAM');
    expect(r.provider).toBe('stub');
    expect(r.confidence).toBe(0.94);
    expect(r.fields.brand).toBe('Samsung');
  });
  it('STUB_LOW_CONF=true → low confidence, empty fields', () => {
    const r = stubScan({ STUB_LOW_CONF: 'true' } as Env, 'SSD');
    expect(r.confidence).toBe(0.3);
    expect(r.fields).toEqual({});
    expect(r.provider).toBe('stub');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ai.test.ts`
Expected: FAIL — cannot find module `../src/ai/stub`.

- [ ] **Step 3: Create `src/ai/stub.ts`**

```ts
// src/ai/stub.ts
import type { Env, LineCategory } from '../types';
import type { ScanResult } from './types';

export const STUB_BY_CATEGORY: Record<LineCategory, Omit<ScanResult, 'provider'>> = {
  RAM: {
    category: 'RAM',
    confidence: 0.94,
    fields: {
      brand: 'Samsung',
      capacity: '32GB',
      type: 'DDR4',
      classification: 'RDIMM',
      rank: '2Rx4',
      speed: '3200',
      partNumber: 'M393A4K40DB3-CWE',
    },
  },
  SSD: {
    category: 'SSD',
    confidence: 0.91,
    fields: {
      brand: 'Samsung',
      capacity: '1.92TB',
      interface: 'NVMe',
      formFactor: 'M.2 22110',
      partNumber: 'MZ1L21T9HCLS-00A07',
    },
  },
  HDD: {
    category: 'HDD',
    confidence: 0.89,
    fields: {
      brand: 'Seagate',
      capacity: '4TB',
      interface: 'SAS',
      formFactor: '3.5"',
      rpm: '7200',
      partNumber: 'ST4000NM0023',
    },
  },
  Other: {
    category: 'Other',
    confidence: 0.88,
    fields: {
      description: 'Intel Xeon Gold 6248',
      partNumber: 'SRF90',
    },
  },
};

export function stubScan(env: Env, category: LineCategory): ScanResult {
  // STUB_LOW_CONF=true simulates an unreadable label so the manual-entry
  // path can be exercised without a real model.
  if ((env.STUB_LOW_CONF ?? 'false').toLowerCase() === 'true') {
    return { category, confidence: 0.3, fields: {}, provider: 'stub' };
  }
  return { ...STUB_BY_CATEGORY[category], provider: 'stub' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ai.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ai/stub.ts tests/ai.test.ts
git commit -m "feat(ocr): extract stub provider"
```

---

### Task 4: Workers AI provider

**Files:**
- Create: `src/ai/workers-ai.ts`

- [ ] **Step 1: Create `src/ai/workers-ai.ts`** (logic identical to old `ai.ts`, now using `parseModelJson`)

```ts
// src/ai/workers-ai.ts
import type { Env, LineCategory } from '../types';
import type { ScanResult } from './types';
import { PROMPT_BY_CATEGORY, parseModelJson } from './prompts';

export async function workersAiScan(
  env: Env,
  category: LineCategory,
  imageBytes: ArrayBuffer,
): Promise<ScanResult> {
  // Workers AI llava vision call. We pass the raw image bytes (max ~4MB).
  const ai = env.AI!;
  const response = (await ai.run('@cf/meta/llama-3.2-11b-vision-instruct', {
    image: Array.from(new Uint8Array(imageBytes)),
    prompt: PROMPT_BY_CATEGORY[category],
    max_tokens: 256,
  })) as { response?: string; description?: string };

  const text = (response.response ?? response.description ?? '').trim();
  const json = parseModelJson(text);

  return {
    category,
    confidence: json ? 0.85 : 0.4,
    fields: (json ?? {}) as Record<string, string>,
    provider: 'workers-ai',
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/ai/workers-ai.ts
git commit -m "feat(ocr): extract workers-ai provider"
```

---

### Task 5: OpenRouter provider

**Files:**
- Create: `src/ai/openrouter.ts`
- Test: `tests/ai.test.ts` (append)

- [ ] **Step 1: Append failing tests to `tests/ai.test.ts`**

Add to the import block at the top:

```ts
import { afterEach, vi } from 'vitest';
import { openRouterScan } from '../src/ai/openrouter';
```

Append this block:

```ts
describe('openRouterScan', () => {
  afterEach(() => vi.unstubAllGlobals());

  const img = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer; // JPEG magic

  function mockFetch(status: number, body: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })),
    );
  }

  it('parses a valid completion', async () => {
    mockFetch(200, { choices: [{ message: { content: '{"brand":"Samsung","capacity":"32GB"}' } }] });
    const r = await openRouterScan({ OPENROUTER_API_KEY: 'k' } as Env, 'RAM', img);
    expect(r.provider).toBe('openrouter');
    expect(r.confidence).toBe(0.85);
    expect(r.fields).toEqual({ brand: 'Samsung', capacity: '32GB' });
  });

  it('parses fenced JSON content', async () => {
    mockFetch(200, { choices: [{ message: { content: '```json\n{"brand":"Micron"}\n```' } }] });
    const r = await openRouterScan({ OPENROUTER_API_KEY: 'k' } as Env, 'RAM', img);
    expect(r.fields.brand).toBe('Micron');
  });

  it('throws on non-2xx (fail-fast)', async () => {
    mockFetch(500, 'upstream boom');
    await expect(openRouterScan({ OPENROUTER_API_KEY: 'k' } as Env, 'RAM', img)).rejects.toThrow(/OpenRouter 500/);
  });

  it('throws when no API key', async () => {
    await expect(openRouterScan({} as Env, 'RAM', img)).rejects.toThrow(/OPENROUTER_API_KEY/);
  });

  it('throws when content is unparseable', async () => {
    mockFetch(200, { choices: [{ message: { content: 'no json at all' } }] });
    await expect(openRouterScan({ OPENROUTER_API_KEY: 'k' } as Env, 'RAM', img)).rejects.toThrow(/parse/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ai.test.ts`
Expected: FAIL — cannot find module `../src/ai/openrouter`.

- [ ] **Step 3: Create `src/ai/openrouter.ts`**

```ts
// src/ai/openrouter.ts
import type { Env, LineCategory } from '../types';
import type { ScanResult } from './types';
import { PROMPT_BY_CATEGORY, parseModelJson } from './prompts';

const DEFAULT_MODEL = 'google/gemini-2.0-flash-001';
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

function sniffMime(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return 'image/webp';
  }
  return 'image/jpeg';
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function openRouterScan(
  env: Env,
  category: LineCategory,
  imageBytes: ArrayBuffer,
): Promise<ScanResult> {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');

  const bytes = new Uint8Array(imageBytes);
  const dataUrl = `data:${sniffMime(bytes)};base64,${toBase64(bytes)}`;

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://recycle-erp.local',
      'X-Title': 'Recycle ERP',
    },
    body: JSON.stringify({
      model: env.OPENROUTER_OCR_MODEL ?? DEFAULT_MODEL,
      temperature: 0.1,
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: PROMPT_BY_CATEGORY[category] },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenRouter ${res.status}: ${body}`);
  }

  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenRouter: no content in response');

  const json = parseModelJson(content);
  if (!json) throw new Error('OpenRouter: could not parse JSON from response');

  return {
    category,
    confidence: 0.85,
    fields: json as Record<string, string>,
    provider: 'openrouter',
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ai.test.ts`
Expected: PASS (all `openRouterScan` cases green).

- [ ] **Step 5: Commit**

```bash
git add src/ai/openrouter.ts tests/ai.test.ts
git commit -m "feat(ocr): add OpenRouter vision provider"
```

---

### Task 6: Selection + orchestration; delete old ai.ts

**Files:**
- Create: `src/ai/index.ts`
- Delete: `src/ai.ts`
- Modify: `src/types.ts`
- Test: `tests/ai.test.ts` (append)

- [ ] **Step 1: Modify `src/types.ts`** — in the `Env` type, delete the line `  STUB_OCR?: string;` and add the two OpenRouter lines next to it. Resulting region:

```ts
  JWT_ISSUER?: string;
  STUB_LOW_CONF?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_OCR_MODEL?: string;
  CF_ACCOUNT_ID?: string;
```

(Confirm `STUB_OCR?: string;` no longer appears anywhere in `src/types.ts`.)

- [ ] **Step 2: Append failing tests to `tests/ai.test.ts`**

Add to the import block:

```ts
import { pickProvider } from '../src/ai/index';
```

Append:

```ts
describe('pickProvider', () => {
  it('stub when no key and no AI binding', () => {
    expect(pickProvider({} as Env)).toBe('stub');
  });
  it('workers-ai when AI bound and no OpenRouter key', () => {
    expect(pickProvider({ AI: { run: async () => ({}) } } as unknown as Env)).toBe('workers-ai');
  });
  it('openrouter when key present', () => {
    expect(pickProvider({ OPENROUTER_API_KEY: 'k' } as Env)).toBe('openrouter');
  });
  it('openrouter wins over a Workers AI binding', () => {
    expect(
      pickProvider({ OPENROUTER_API_KEY: 'k', AI: { run: async () => ({}) } } as unknown as Env),
    ).toBe('openrouter');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/ai.test.ts`
Expected: FAIL — cannot find module `../src/ai/index`.

- [ ] **Step 4: Create `src/ai/index.ts`**

```ts
// Label OCR. Three providers behind one interface:
//
//   openrouter:  frontier vision model via OpenRouter (default; best accuracy)
//   workers-ai:  Cloudflare Workers AI vision (Llama 3.2 11B vision-instruct)
//   stub:        deterministic canned extraction (offline dev / tests / demo)
//
// Provider is picked by credential/binding presence — see pickProvider.
// openrouter and workers-ai fail fast; the scan route turns a throw into a
// 502 so the field user retries the shot.

import type { Env, LineCategory } from '../types';
import type { ScanResult, OcrProvider } from './types';
import { stubScan } from './stub';
import { workersAiScan } from './workers-ai';
import { openRouterScan } from './openrouter';

export type { ScanResult, OcrProvider } from './types';
export { CONFIDENCE_FLOOR } from './types';

export function pickProvider(env: Env): OcrProvider {
  if (env.OPENROUTER_API_KEY) return 'openrouter';
  if (env.AI) return 'workers-ai';
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
    case 'workers-ai':
      return workersAiScan(env, category, imageBytes);
    default:
      return stubScan(env, category);
  }
}
```

- [ ] **Step 5: Delete the old module**

Run: `git rm src/ai.ts`
Expected: `rm 'apps/backend/src/ai.ts'`. (`src/routes/scan.ts` imports `from '../ai'`, which now resolves to `src/ai/index.ts` — no edit needed there yet.)

- [ ] **Step 6: Typecheck + run tests**

Run: `npm run typecheck && npx vitest run tests/ai.test.ts`
Expected: typecheck PASS; all `tests/ai.test.ts` describes PASS. If typecheck reports `STUB_OCR` referenced anywhere, fix that reference (only `src/ai.ts` used it and it is now deleted).

- [ ] **Step 7: Commit**

```bash
git add src/ai/index.ts src/types.ts tests/ai.test.ts
git rm --cached src/ai.ts 2>/dev/null; git add -u src/ai.ts
git commit -m "feat(ocr): provider selection by credentials, drop STUB_OCR"
```

---

### Task 7: Scan route fail-fast + test harness env override

**Files:**
- Modify: `src/routes/scan.ts`
- Modify: `tests/helpers/app.ts`
- Test: `tests/scan.test.ts` (create)

- [ ] **Step 1: Modify `tests/helpers/app.ts`**

(a) Remove the `STUB_OCR: 'true',` line from `testEnv` (lines around 5-10). `testEnv` becomes:

```ts
export const testEnv: Env = {
  DATABASE_URL: TEST_DATABASE_URL,
  JWT_SECRET: 'test-secret-' + Math.random().toString(36).slice(2),
  JWT_ISSUER: 'recycle-erp-test',
};
```

(b) Replace the `multipart` signature + the `app.fetch` line so callers can override env. The function becomes:

```ts
export async function multipart(
  path: string,
  fields: Record<string, string | Blob>,
  opts: { token?: string; env?: Partial<Env> } = {},
): Promise<ApiResult> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const env = opts.env ? { ...testEnv, ...opts.env } : testEnv;
  const res = await app.fetch(
    new Request('http://test' + path, { method: 'POST', body: form, headers }),
    env,
  );
  const text = await res.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}
```

(`import type { Env } from '../../src/types';` already exists at the top of this file — no new import.)

- [ ] **Step 2: Write the failing test** (create `tests/scan.test.ts`)

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetDb, getTestDb } from './helpers/db';
import { multipart } from './helpers/app';
import { loginAs, MARCUS } from './helpers/auth';

function jpeg(): File {
  return new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], 'label.jpg', { type: 'image/jpeg' });
}

describe('POST /api/scan/label', () => {
  beforeEach(async () => { await resetDb(); });
  afterEach(() => vi.unstubAllGlobals());

  it('stub path: no key/no AI → canned extraction, persists a label_scans row', async () => {
    const { token } = await loginAs(MARCUS);
    const r = await multipart('/api/scan/label', { file: jpeg(), category: 'RAM' }, { token });
    expect(r.status).toBe(200);
    const body = r.body as { provider: string; extracted: Record<string, string>; confidence: number };
    expect(body.provider).toBe('stub');
    expect(body.extracted.brand).toBe('Samsung');
    const sql = getTestDb();
    const rows = await sql`SELECT provider FROM label_scans WHERE category = 'RAM'`;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].provider).toBe('stub');
  });

  it('openrouter path: env key + mocked fetch → provider openrouter', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '{"brand":"SK Hynix"}' } }] }), { status: 200 }),
      ),
    );
    const { token } = await loginAs(MARCUS);
    const r = await multipart(
      '/api/scan/label',
      { file: jpeg(), category: 'RAM' },
      { token, env: { OPENROUTER_API_KEY: 'test-key' } },
    );
    expect(r.status).toBe(200);
    const body = r.body as { provider: string; extracted: Record<string, string> };
    expect(body.provider).toBe('openrouter');
    expect(body.extracted.brand).toBe('SK Hynix');
  });

  it('fail-fast: OpenRouter 500 → route returns 502', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    const { token } = await loginAs(MARCUS);
    const r = await multipart(
      '/api/scan/label',
      { file: jpeg(), category: 'RAM' },
      { token, env: { OPENROUTER_API_KEY: 'test-key' } },
    );
    expect(r.status).toBe(502);
    expect((r.body as { error: string }).error).toMatch(/OCR failed/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/scan.test.ts`
Expected: the stub-path test PASSES already; the 502 test FAILS (route currently lets the throw become a 500, not 502).

- [ ] **Step 4: Modify `src/routes/scan.ts`** — replace the line `const result = await scanLabel(c.env, category, bytes);` with:

```ts
  let result;
  try {
    result = await scanLabel(c.env, category, bytes);
  } catch (e) {
    console.error('ocr error', e);
    return c.json({ error: 'label OCR failed — retry the shot' }, 502);
  }
```

(Everything below — the `INSERT INTO label_scans …` and the `c.json({...})` response — stays unchanged and now runs only on success.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/scan.test.ts`
Expected: PASS (all 3 cases).

- [ ] **Step 6: Commit**

```bash
git add src/routes/scan.ts tests/helpers/app.ts tests/scan.test.ts
git commit -m "feat(ocr): fail-fast 502 on OCR error; test harness env override"
```

---

### Task 8: Config + docs cleanup

**Files:**
- Modify: `wrangler.toml`
- Modify: `.dev.vars.example`
- Modify: `README.md`

- [ ] **Step 1: Edit `wrangler.toml`** — in the `[vars]` block remove the `STUB_OCR = "true"` line. Under the `# Secrets (set via \`wrangler secret put\`):` comment list, add `#   - OPENROUTER_API_KEY`. The `[vars]` block becomes:

```toml
[vars]
JWT_ISSUER = "recycle-erp"
# R2_ATTACHMENTS_PUBLIC_URL = "https://<your-r2-public-url>"

# Secrets (set via `wrangler secret put`):
#   - JWT_SECRET
#   - DATABASE_URL          (only if not using Hyperdrive)
#   - OPENROUTER_API_KEY    (label OCR; default provider)
#   - CF_ACCOUNT_ID
#   - CF_IMAGES_TOKEN
```

(Leave the `[ai] binding = "AI"` block as-is — Workers AI stays selectable when no OpenRouter key is set.)

- [ ] **Step 2: Overwrite `.dev.vars.example`** with:

```
DATABASE_URL=postgres://recycle:recycle@localhost:5432/recycle_erp
JWT_SECRET=dev-secret-change-me-please
OPENROUTER_API_KEY=
# OPENROUTER_OCR_MODEL=google/gemini-2.0-flash-001
CF_ACCOUNT_ID=
CF_IMAGES_TOKEN=
```

- [ ] **Step 3: Edit `README.md`** — replace the backend env fenced block in the "Environment variables" section with:

```
DATABASE_URL=postgres://recycle:recycle@localhost:5432/recycle_erp
JWT_SECRET=dev-secret-change-me
OPENROUTER_API_KEY=                # label OCR — default provider when set
# OPENROUTER_OCR_MODEL=google/gemini-2.0-flash-001   # or anthropic/claude-sonnet-4.5, openai/gpt-4o
CF_ACCOUNT_ID=                     # leave blank in dev to use stub Image storage
CF_IMAGES_TOKEN=
```

Then in the "Deployment notes" list replace the `STUB_OCR=false` Workers-AI bullet with:

```
- OCR provider is chosen by credentials: `OPENROUTER_API_KEY` set → OpenRouter
  (default); else a Workers AI `[ai]` binding → Llama 3.2 vision; else the
  deterministic stub. No `STUB_OCR` flag.
```

- [ ] **Step 4: Verify no STUB_OCR references remain**

Run: `grep -rn "STUB_OCR" src tests wrangler.toml .dev.vars.example README.md`
Expected: no output (exit 1). `STUB_LOW_CONF` may still appear — that is correct and expected.

- [ ] **Step 5: Commit**

```bash
git add wrangler.toml .dev.vars.example README.md
git commit -m "docs(ocr): document OpenRouter provider, remove STUB_OCR"
```

---

### Task 9: Full verification

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: PASS, no errors.

- [ ] **Step 2: Full test suite**

Run (Postgres must be up — `docker compose up -d` from repo root if not): `npm test`
Expected: all suites PASS, including the new `tests/ai.test.ts` and `tests/scan.test.ts`. No regressions in existing route tests (they never set `STUB_OCR`; with no key/no AI they now resolve to the stub via `pickProvider`, same behavior as before).

- [ ] **Step 3: Manual smoke (optional, requires real key in `.dev.vars`)**

Run: `npm run dev` then in another shell:
`curl -s -F file=@<a-real-ram-label.jpg> -F category=RAM -H "Authorization: Bearer <token>" http://localhost:8787/api/scan/label`
Expected: JSON with `"provider":"openrouter"` and populated `extracted` fields.

- [ ] **Step 4: Confirm clean tree for this feature**

Run: `git status --porcelain -- src/ai src/routes/scan.ts src/types.ts tests/ai.test.ts tests/scan.test.ts tests/helpers/app.ts wrangler.toml .dev.vars.example README.md`
Expected: no output (all feature changes committed). Unrelated WIP in `src/db.ts` / `src/index.ts` is left untouched and uncommitted by design.

---

## Self-Review

**Spec coverage:**
- §1 module split → Tasks 1–6 (types/prompts/stub/workers-ai/openrouter/index), old file deleted Task 6. `types.ts` addition documented as an intentional deviation in the header.
- §2 selection + `STUB_OCR` removal + fail-fast 502 → Task 6 (`pickProvider`, types.ts), Task 7 (route 502), Task 8 (config cleanup), grep gate Task 8 Step 4.
- §3 OpenRouter mechanics, mime sniff, base64, prompt upgrade, confidence 0.85, multi-module out of scope → Tasks 2 (RAM prompt rules) + 5 (provider).
- §4 config changes → Task 6 (types.ts) + Task 8 (wrangler/.dev.vars.example/README).
- §5 tests: stub, STUB_LOW_CONF, openrouter success/fenced/502, pickProvider, multipart env override → Tasks 3, 5, 6, 7.

**Placeholder scan:** no TBD/TODO/"handle errors"/vague steps; every code step has full code.

**Type consistency:** `ScanResult`/`OcrProvider`/`CONFIDENCE_FLOOR` defined once in `types.ts`, re-exported from `index.ts`; `scanLabel`/`pickProvider`/`stubScan`/`workersAiScan`/`openRouterScan`/`parseModelJson`/`PROMPT_BY_CATEGORY`/`STUB_BY_CATEGORY` names are consistent across all tasks and match the existing `scan.ts` import (`scanLabel` from `../ai`). `Env` field names (`OPENROUTER_API_KEY`, `OPENROUTER_OCR_MODEL`, `STUB_LOW_CONF`) consistent between `types.ts`, providers, and tests.
