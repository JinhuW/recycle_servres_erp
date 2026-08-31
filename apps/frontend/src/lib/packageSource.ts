// Buying channels for tracked packages. The id list is the shared single source
// of truth (@recycle-erp/shared, also used by the backend boundary and mirrored
// by the SQL CHECK on packages.source). Labels render through useT() with the
// shipSource_<id> key, so the picker and the read-only rows translate with the
// rest of the UI.
export { PACKAGE_SOURCES } from '@recycle-erp/shared';
export type { PackageSource } from '@recycle-erp/shared';

export function packageSourceLabelKey(id: string): string {
  return `shipSource_${id}`;
}
