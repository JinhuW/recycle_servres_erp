// Where a tracked package's deal came from — the buying channel, captured once
// when the box is added. Fixed taxonomy shared by the backend boundary
// (apps/backend/src/routes/packages.ts) and the frontend pickers. The SQL CHECK
// constraint on packages.source must list the same values (it can't import TS);
// adding a channel means extending this array AND writing a new migration to
// widen the CHECK.
export const PACKAGE_SOURCES = ['facebook', 'local', 'reddit', 'other'] as const;
export type PackageSource = (typeof PACKAGE_SOURCES)[number];
