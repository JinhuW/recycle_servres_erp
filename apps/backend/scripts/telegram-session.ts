// Signs a Telegram account in once and prints the session string the Facebook
// chat hub runs on (FB_CHAT_TELEGRAM_SESSION), plus the ids of the groups the
// account is in. Run it yourself in a terminal: it asks for the account's
// phone number, the login code Telegram sends to the app and the two-step
// verification password, and the string it prints is full access to the
// account.
//
//   cd apps/backend && node scripts/telegram-session.ts
//
// FB_CHAT_TELEGRAM_API_ID and FB_CHAT_TELEGRAM_API_HASH are read from the
// environment when set, and asked for otherwise.

import { createInterface } from 'node:readline/promises';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

const rl = createInterface({ input: process.stdin, output: process.stdout });
const apiId = Number(process.env.FB_CHAT_TELEGRAM_API_ID || (await rl.question('api_id: ')));
const apiHash = process.env.FB_CHAT_TELEGRAM_API_HASH || (await rl.question('api_hash: '));
const client = new TelegramClient(new StringSession(''), apiId, apiHash.trim(), { connectionRetries: 3 });
client.setLogLevel('none' as never);
await client.start({
  phoneNumber: () => rl.question('Phone number, with country code (+1...): '),
  phoneCode: () => rl.question('Login code Telegram sent to the app: '),
  password: () => rl.question('Two-step verification password (blank if none): '),
  onError: (error) => { console.error(String(error)); },
});
const me = await client.getMe();
console.log(`\nSigned in as ${[me.firstName, me.lastName].filter(Boolean).join(' ')} (user id ${me.id}).`);
console.log('\nForum groups this account is in (FB_CHAT_TELEGRAM_CHAT_ID is the -100... number):');
for (const dialog of await client.getDialogs({ limit: 200 })) {
  const entity = dialog.entity as { forum?: boolean } | undefined;
  if (dialog.isChannel || dialog.isGroup) console.log(`  ${dialog.id}  ${dialog.title}${entity?.forum ? '' : '  (Topics off)'}`);
}
console.log('\nFB_CHAT_TELEGRAM_SESSION (a secret: store it, never share it):\n');
console.log(client.session.save());
await client.disconnect();
rl.close();
process.exit(0);
