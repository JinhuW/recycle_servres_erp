import { Hono } from 'hono';
import type { Env, User } from '../types';
import { authorizationServerMetadata, protectedResourceMetadata } from './metadata';

const oauth = new Hono<{ Bindings: Env; Variables: { user: User } }>();

oauth.get('/oauth-authorization-server', (c) =>
  c.json(authorizationServerMetadata(c.env as Env)),
);

oauth.get('/oauth-protected-resource', (c) =>
  c.json(protectedResourceMetadata(c.env as Env)),
);

export default oauth;
