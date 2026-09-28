import type { MiddlewareHandler } from 'hono';
import type { Env, Role, User } from '../types';

// A manager can opt to preview the app as a purchaser via the
// `tweaks.rolePreview` preference (set from the RolePicker / Settings →
// Tweaks panel). The frontend already downgrades the visible UI; this
// helper extends the same downgrade to backend read scopes so a manager
// in preview mode genuinely sees only their own work.
//
// Write/edit paths intentionally still consult `user.role` directly — the
// preview is a viewing convenience, not a permission demotion.
export function effectiveRole(user: User): Role {
  if (user.role !== 'manager') return user.role;
  const pref = (user.preferences as Record<string, unknown> | null | undefined)?.['tweaks.rolePreview'];
  return pref === 'as_purchaser' ? 'purchaser' : 'manager';
}

// Router-level gate for manager-only sub-apps. Raw `role`, per the rule above:
// a manager previewing as a purchaser keeps manager access.
export const requireManager: MiddlewareHandler<{
  Bindings: Env;
  Variables: { user: User };
}> = async (c, next) => {
  if (c.var.user.role !== 'manager') return c.json({ error: 'Forbidden' }, 403);
  return next();
};
