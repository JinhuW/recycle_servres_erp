// Provider selection. Unlike OCR there is NO silent stub fallback: a source
// without keys is reported as not configured so the sync response (and the
// Payments page) can say so. BANKTX_STUB=1 opts into canned data explicitly.

import type { Env } from '../types';
import { mercuryProvider } from './mercury';
import { paypalProvider } from './paypal';
import { stubMercuryProvider, stubPaypalProvider } from './stub';
import type { BankProvider, BankSource } from './types';

export type BankProviderPick = {
  providers: BankProvider[];
  notConfigured: BankSource[];
};

export function pickBankProviders(env: Env): BankProviderPick {
  if (env.BANKTX_STUB === '1') {
    return { providers: [stubMercuryProvider(), stubPaypalProvider()], notConfigured: [] };
  }
  const providers: BankProvider[] = [];
  const notConfigured: BankSource[] = [];
  if (env.MERCURY_API_TOKEN) providers.push(mercuryProvider(env));
  else notConfigured.push('mercury');
  if (env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET) providers.push(paypalProvider(env));
  else notConfigured.push('paypal');
  return { providers, notConfigured };
}
