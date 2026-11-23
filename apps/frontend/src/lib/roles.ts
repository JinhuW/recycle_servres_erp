import type { Role } from './types';

// Every role a member can hold, in the order the Members page lists them.
export const ROLES: readonly Role[] = ['manager', 'purchaser', 'ebay'];

export const roleLabelKey = (role: Role): string => 'role_' + role;

// What a role may do, as the Members page's role cards say it.
export const roleDescKey = (role: Role): string =>
  role === 'manager' ? 'memRoleMgrDesc' : role === 'purchaser' ? 'memRolePurchDesc' : 'memRoleEbayDesc';
