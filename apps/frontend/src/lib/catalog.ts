// Category-specific option lists. Sourced from the `catalog_options` table at
// app boot (see lib/lookups.ts) — these named exports are live references to
// arrays that get filled before the React tree renders.

import { catalog } from './lookups';

export { categories, categoryFilterOptions, type CategoryInfo } from './lookups';

export const RAM_BRANDS    = catalog.RAM_BRAND;
export const RAM_TYPES     = catalog.RAM_TYPE;
export const RAM_CLASS     = catalog.RAM_CLASS;
export const RAM_RANK      = catalog.RAM_RANK;
export const RAM_CAP       = catalog.RAM_CAP;
export const RAM_SPEED     = catalog.RAM_SPEED;
export const SSD_BRANDS    = catalog.SSD_BRAND;
export const SSD_INTERFACE = catalog.SSD_INTERFACE;
export const SSD_FORM      = catalog.SSD_FORM;
export const SSD_CAP       = catalog.SSD_CAP;
export const HDD_BRANDS    = catalog.HDD_BRAND;
export const HDD_INTERFACE = catalog.HDD_INTERFACE;
export const HDD_FORM      = catalog.HDD_FORM;
export const HDD_CAP       = catalog.HDD_CAP;
export const HDD_RPM       = catalog.HDD_RPM;
export const CONDITIONS    = catalog.CONDITION;
