import { Hono } from 'hono';
import type { Env, User } from '../types';
import { authorizationServerMetadata, protectedResourceMetadata } from './metadata';

const wellKnown = new Hono<{ Bindings: Env; Variables: { user: User } }>();

wellKnown.get('/oauth-authorization-server', (c) =>
  c.json(authorizationServerMetadata(c.env)),
);

wellKnown.get('/oauth-protected-resource', (c) =>
  c.json(protectedResourceMetadata(c.env)),
);

export default wellKnown;
