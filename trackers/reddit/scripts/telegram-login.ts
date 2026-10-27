#!/usr/bin/env tsx
// Logs the alert-sending Telegram user account in once and prints the session
// string for TELEGRAM_USER_SESSION. Interactive: Telegram sends the login code
// to the account's other devices. Run it on a trusted machine, and never run
// it against a session the api is using (see src/userSender.ts).
//
//   TELEGRAM_API_ID=… TELEGRAM_API_HASH=… pnpm tsx scripts/telegram-login.ts

import {createInterface} from 'node:readline/promises';
import {TelegramClient} from 'telegram';
import {StringSession} from 'telegram/sessions/index.js';

const apiId = Number(process.env['TELEGRAM_API_ID']);
const apiHash = process.env['TELEGRAM_API_HASH'] ?? '';
if (!Number.isInteger(apiId) || !apiHash) {
  throw new Error('Set TELEGRAM_API_ID and TELEGRAM_API_HASH (from my.telegram.org → API development tools)');
}

const rl = createInterface({input: process.stdin, output: process.stdout});
const client = new TelegramClient(new StringSession(''), apiId, apiHash, {connectionRetries: 5});
await client.start({
  phoneNumber: () => rl.question('Phone number (international, e.g. +1303…): '),
  phoneCode: () => rl.question('Login code: '),
  password: () => rl.question('Two-step verification password: '),
  onError: (e) => console.error(e.message),
});
rl.close();
const me = await client.getMe();
console.log(`\nLogged in as ${[me.firstName, me.lastName].filter(Boolean).join(' ')} (@${me.username ?? '—'}).`);
console.log('TELEGRAM_USER_SESSION=' + String(client.session.save()));
await client.destroy();
