#!/usr/bin/env node
// Idempotently provision a single default admin user so the first
// `docker compose up` lets you log in without manual seeding.
//
// Skips silently if a user with ADMIN_EMAIL already exists, so subsequent
// boots are no-ops and password changes made in-app are preserved.
//
// Env (all optional — sensible dev defaults baked into the backend image):
//   ADMIN_EMAIL     default 'admin@recycle.local'
//   ADMIN_PASSWORD  default 'admin'  (warns at runtime if left at default)
//   ADMIN_NAME      default 'Admin'
//   ADMIN_ROLE      default 'manager'  (must be 'manager' or 'purchaser')

import postgres from 'postgres';
import bcrypt from 'bcryptjs';
import './load-env.mjs';
// Plain-node import of a .ts module: Node strips the types. log.ts is kept
// free of intra-repo imports so this resolves without a transpiler.
import { log as rootLog } from '../src/lib/log.ts';

const log = rootLog.child({ module: 'init-admin' });

const url = process.env.DATABASE_URL;
if (!url) {
  log.error('DATABASE_URL is not set');
  process.exit(1);
}

const email = (process.env.ADMIN_EMAIL ?? 'admin@recycle.local').toLowerCase().trim();
const password = process.env.ADMIN_PASSWORD ?? 'admin';
const name = process.env.ADMIN_NAME ?? 'Admin';
const role = process.env.ADMIN_ROLE ?? 'manager';

if (!['manager', 'purchaser'].includes(role)) {
  log.error("ADMIN_ROLE must be 'manager' or 'purchaser'", { role });
  process.exit(1);
}

const initials =
  name
    .split(/\s+/)
    .map((w) => w[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase() || 'AD';

const sql = postgres(url, { onnotice: () => {} });

try {
  const existing = await sql`SELECT id FROM users WHERE email = ${email} LIMIT 1`;
  if (existing.length > 0) {
    log.info('admin already exists, skipping', { email });
  } else {
    // Never provision a manager account with the published default password in
    // production — fail the boot so the misconfiguration is impossible to miss.
    if (process.env.NODE_ENV === 'production' && password === 'admin') {
      log.error(
        'refusing to create the default admin with password "admin" in production — set ADMIN_PASSWORD in .env',
      );
      await sql.end();
      process.exit(1);
    }
    const hash = await bcrypt.hash(password, 10);
    await sql`
      INSERT INTO users (email, name, initials, role, password_hash, active)
      VALUES (${email}, ${name}, ${initials}, ${role}, ${hash}, TRUE)
    `;
    log.info('created admin', { role, email });
    if (password === 'admin') {
      log.warn(
        'using DEFAULT password "admin" — set ADMIN_PASSWORD in repo-root .env before exposing the service.',
      );
    }
  }
} catch (e) {
  log.error('init-admin failed', e);
  process.exitCode = 1;
} finally {
  await sql.end();
}
