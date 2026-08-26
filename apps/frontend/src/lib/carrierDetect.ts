// Carrier detection for the add-label forms. The vocabulary and shape rules
// live in @recycle-erp/shared so the backend /api/packages boundary applies
// the exact same normalization — this module only re-exports them for the
// existing frontend import paths.

export {
  CARRIERS, detectCarriers, extractTrackingFromBarcode, normalizeTracking, type Carrier,
} from '@recycle-erp/shared';
