// The eBay developer app this ERP connects through, read from Env. Sandbox and
// production are separate keysets on separate hosts, so the environment picks
// both the hosts and which credentials are meaningful.

import type { Env } from '../types';

export type EbayEnvironment = 'sandbox' | 'production';

export interface EbayConfig {
  clientId: string;
  clientSecret: string;
  /** The RuName (eBay redirect URL name): the `redirect_uri` of every grant. */
  ruName: string;
  environment: EbayEnvironment;
  /** REST host, e.g. https://api.ebay.com (also serves the token endpoint). */
  apiBase: string;
  /** Consent host, e.g. https://auth.ebay.com. */
  authBase: string;
}

const HOSTS: Record<EbayEnvironment, { apiBase: string; authBase: string }> = {
  production: { apiBase: 'https://api.ebay.com', authBase: 'https://auth.ebay.com' },
  sandbox: { apiBase: 'https://api.sandbox.ebay.com', authBase: 'https://auth.sandbox.ebay.com' },
};

/** Anything other than an explicit 'production' is the sandbox. */
export function ebayEnvironment(env: Env): EbayEnvironment {
  return env.EBAY_ENV?.trim().toLowerCase() === 'production' ? 'production' : 'sandbox';
}

/** True when the app credentials and the RuName are all set. */
export function ebayConfigured(env: Env): boolean {
  return ebayConfig(env) !== null;
}

/** The connection settings, or null when eBay is not configured. */
export function ebayConfig(env: Env): EbayConfig | null {
  const clientId = env.EBAY_CLIENT_ID?.trim();
  const clientSecret = env.EBAY_CLIENT_SECRET?.trim();
  const ruName = env.EBAY_RU_NAME?.trim();
  if (!clientId || !clientSecret || !ruName) return null;
  const environment = ebayEnvironment(env);
  return { clientId, clientSecret, ruName, environment, ...HOSTS[environment] };
}
