#!/usr/bin/env node
// Adds accounts to the Facebook account pool through its service-client route.
// Usage: add.mjs <rows.json> [--send]    rows.json: { "batch": "...", "rows": [...] }
// Without --send it only previews. Nothing it prints may carry a secret.
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cookieUid, normalizeFbPoolDraft, validateFbPoolDraft } from '../../../packages/shared/src/facebookPool.ts';

const CREDS = process.env.RS_POOL_CREDS ?? join(homedir(), '.config/recycle-erp/pool-client.env');

function die(message) {
  console.error(message);
  process.exit(1);
}

function readCreds() {
  let mode;
  try {
    mode = statSync(CREDS).mode;
  } catch {
    die(`No credentials at ${CREDS}. See "Setup" in SKILL.md.`);
  }
  if (mode & 0o077) die(`${CREDS} is readable by others. Run: chmod 600 ${CREDS}`);
  const creds = Object.fromEntries(
    readFileSync(CREDS, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.includes('=') && !line.trimStart().startsWith('#'))
      .map((line) => [line.slice(0, line.indexOf('=')).trim(), line.slice(line.indexOf('=') + 1).trim()]),
  );
  for (const name of ['RS_ERP_URL', 'RS_POOL_CLIENT_ID', 'RS_POOL_CLIENT_SECRET']) {
    if (!creds[name]) die(`${CREDS} has no ${name}.`);
  }
  return { ...creds, RS_ERP_URL: creds.RS_ERP_URL.replace(/\/+$/, '') };
}

const cutEmail = (email) => {
  const at = email.lastIndexOf('@');
  return !email ? '-' : at < 0 ? `${email.slice(0, 2)}•••` : `${email.slice(0, 2)}•••${email.slice(at)}`;
};
const has = (value) => (value ? 'yes' : '-');

function preview(rows) {
  const seen = new Set();
  let refused = 0;
  rows.forEach((row, index) => {
    const draft = normalizeFbPoolDraft({
      uid: '', password: '', totp: '', email: '', emailPassword: '', recovery: '', cookie: '', token: '', note: '',
      ...row, status: 'available', holder: null,
    });
    const notes = validateFbPoolDraft(draft, seen);
    seen.add(draft.uid);
    if (notes.length) refused += 1;
    if (!draft.totp) notes.push('no 2FA key: the fleet will not take it');
    if (draft.cookie && cookieUid(draft.cookie) !== draft.uid) notes.push('cookie c_user is not this uid');
    console.log(
      `${index}\t${draft.uid}\t${cutEmail(draft.email)}\tpassword:${has(draft.password)}\t2fa:${has(draft.totp)}\tcookie:${has(draft.cookie)}\t${notes.join(', ')}`,
    );
  });
  return refused;
}

async function send(creds, batch, rows) {
  const tokenRes = await fetch(`${creds.RS_ERP_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: creds.RS_POOL_CLIENT_ID,
      client_secret: creds.RS_POOL_CLIENT_SECRET,
      scope: 'pool:write',
    }),
  });
  if (!tokenRes.ok) die(`The ERP refused the service client: ${(await tokenRes.json().catch(() => ({}))).error ?? tokenRes.statusText}`);
  const { access_token: token } = await tokenRes.json();
  const res = await fetch(`${creds.RS_ERP_URL}/api/facebook-pool/push/accounts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ batch, rows }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status !== 201) {
    console.error(`Nothing was added: ${body.error ?? res.statusText}`);
    for (const f of body.failures ?? []) console.error(`row ${f.index}\t${f.uid}\t${f.codes.join(', ')}`);
    process.exit(1);
  }
  console.log(`Added ${body.added.length} to batch "${body.batch}":`);
  for (const { no, uid } of body.added) console.log(`#${no}\t${uid}`);
}

const [path, flag] = process.argv.slice(2);
if (!path || (flag && flag !== '--send')) die('Usage: add.mjs <rows.json> [--send]');
const { batch, rows } = JSON.parse(readFileSync(path, 'utf8'));
if (!Array.isArray(rows) || rows.length === 0) die('rows.json has no rows.');
const creds = readCreds();

if (flag === '--send') {
  await send(creds, batch, rows);
} else {
  console.log(`Target: ${creds.RS_ERP_URL}\nBatch: ${batch || 'API'}\nRows: ${rows.length}\n`);
  const refused = preview(rows);
  if (refused) console.log(`\n${refused} row(s) would be refused, and then nothing is added.`);
}
