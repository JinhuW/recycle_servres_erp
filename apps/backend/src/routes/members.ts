// Manager-only members admin. Persistence + business logic lives in
// `services/members.ts`; this file owns the HTTP shape only.

import { Hono } from 'hono';
import { getDb } from '../db';
import {
  listMembers,
  createMember,
  updateMember,
  deactivateMember,
  getMemberStatus,
  countOtherActiveManagers,
  type MemberRole,
  type CreateMemberInput,
  type UpdateMemberInput,
} from '../services/members';
import type { Env, User } from '../types';

const members = new Hono<{ Bindings: Env; Variables: { user: User } }>();

members.use('*', async (c, next) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  await next();
});

members.get('/', async (c) => {
  const includeInactive = c.req.query('includeInactive') === 'true';
  const sql = getDb(c.env);
  const items = await listMembers(sql, { includeInactive });
  return c.json({ items });
});

members.post('/', async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | Partial<CreateMemberInput>
    | null;
  if (!body?.email || !body?.name || !body?.role) {
    return c.json({ error: 'email, name, role required' }, 400);
  }
  const sql = getDb(c.env);
  const r = await createMember(sql, {
    email: body.email,
    name: body.name,
    role: body.role as MemberRole,
    team: body.team,
    phone: body.phone,
    title: body.title,
    password: body.password,
  });
  return c.json(r, 201);
});

members.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as UpdateMemberInput | null;
  if (!body) return c.json({ error: 'invalid body' }, 400);
  const sql = getDb(c.env);
  await updateMember(sql, id, body);
  return c.json({ ok: true });
});

// Soft delete: deactivate the account so they can't sign in and disappear
// from the member picker, while keeping their order/audit history intact
// (orders.user_id is ON DELETE CASCADE, so a hard delete would wipe history).
members.delete('/:id', async (c) => {
  const id = c.req.param('id');
  if (id === c.var.user.id) {
    return c.json({ error: "You can't remove yourself" }, 400);
  }
  const sql = getDb(c.env);
  const target = await getMemberStatus(sql, id);
  if (!target) return c.json({ error: 'Member not found' }, 404);
  if (target.role === 'manager' && target.active) {
    const others = await countOtherActiveManagers(sql, id);
    if (others === 0) {
      return c.json({ error: "Can't remove the last active manager" }, 400);
    }
  }
  const updated = await deactivateMember(sql, id);
  if (!updated) return c.json({ error: 'Member not found' }, 404);
  return c.json({ ok: true });
});

export default members;
