// Load repo-root .env regardless of caller CWD.
//
// Why this exists: `pnpm db:migrate` etc. run with CWD = apps/backend/, so the
// default `dotenv/config` import would look for apps/backend/.env — but the
// project keeps a single .env at the repo root (also used by Compose). Anchor
// the path off this file's location so any caller, in any workspace, picks up
// the same file.
//
// In Docker the file is absent — env_file: .env already wrote everything into
// process.env, so the existsSync guard keeps the container log noise-free.

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { config } from 'dotenv';

const envPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../.env');
if (existsSync(envPath)) config({ path: envPath });
