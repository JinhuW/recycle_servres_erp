// Password length policy — the single source of truth shared by the backend
// password routes (me.ts change-password, members.ts admin-create) and the
// frontend client-side checks. Raising the minimum is a one-line change here.
export const MIN_PASSWORD_LEN = 8;
export const MAX_PASSWORD_LEN = 200;
