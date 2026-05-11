// Category-specific option lists, lifted from design/data.jsx so the desktop
// submit / inventory-edit forms render the same dropdown values as the
// prototype. Keep this in sync with the backend's seed when adding new options.

export const RAM_BRANDS   = ['Samsung', 'Hynix', 'Micron', 'Kingston', 'Crucial', 'Corsair'] as const;
export const RAM_TYPES    = ['DDR3', 'DDR4', 'DDR5'] as const;
export const RAM_CLASS    = ['UDIMM', 'RDIMM', 'LRDIMM', 'SODIMM'] as const;
export const RAM_RANK     = ['1Rx4', '1Rx8', '2Rx4', '2Rx8', '4Rx4'] as const;
export const RAM_CAP      = ['4GB', '8GB', '16GB', '32GB', '64GB', '128GB'] as const;
export const RAM_SPEED    = ['1600', '2133', '2400', '2666', '3200', '4800', '5600'] as const;
export const SSD_BRANDS   = ['Samsung', 'Intel', 'Micron', 'WD', 'Seagate', 'Kioxia'] as const;
export const SSD_INTERFACE = ['SATA', 'SAS', 'NVMe', 'U.2'] as const;
export const SSD_FORM     = ['2.5"', 'M.2 2280', 'M.2 22110', 'U.2', 'AIC'] as const;
export const SSD_CAP      = ['240GB', '480GB', '960GB', '1.92TB', '3.84TB', '7.68TB'] as const;
export const CONDITIONS   = ['New', 'Pulled — Tested', 'Pulled — Untested', 'Used'] as const;
