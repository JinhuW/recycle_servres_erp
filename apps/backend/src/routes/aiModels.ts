import { Hono } from 'hono';
import { AI_PROVIDER_LABELS, type AiProviderId } from '@recycle-erp/shared';
import { authMiddleware } from '../auth';
import { log } from '../lib/log';
import { requireManager } from '../lib/role';
import { catalogue } from '../ai/catalogue';
import { envModel } from '../ai/llm';
import { PROVIDERS } from '../ai/providers';
import type { Env, User } from '../types';

export { _resetForTests } from '../ai/catalogue';

const rlog = log.child({ module: 'ai-models' });

const aiModels = new Hono<{ Bindings: Env; Variables: { user: User } }>()
  .use('*', authMiddleware)
  .use('*', requireManager);

aiModels.get('/models', async (c) => {
  try {
    return c.json(await catalogue(c.env));
  } catch (err) {
    rlog.warn('model catalogue unreachable', err);
    return c.json({ error: err instanceof Error ? err.message : 'Model catalogue unreachable' }, 502);
  }
});

// Which providers have a key. Keys live in the env only; the page that
// switches models never sees one.
aiModels.get('/providers', (c) => {
  const providers = (Object.keys(PROVIDERS) as AiProviderId[]).map((id) => ({
    id,
    label: AI_PROVIDER_LABELS[id],
    configured: PROVIDERS[id].configured(c.env),
    keyName: PROVIDERS[id].keyName,
  }));
  return c.json({ providers, envModel: envModel(c.env) });
});

export default aiModels;
