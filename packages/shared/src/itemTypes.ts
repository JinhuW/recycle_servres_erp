// Filter sentinel for `Other` lines that carry no item type — every line
// created before item types existed, plus anything a purchaser hasn't gone
// back to classify. It travels on the wire as one more `?itemType=` value so
// the facet UI needs no separate control, and the backend turns it into
// `item_type IS NULL`.
//
// The double-underscore form is deliberate: a real type is a part name a
// purchaser typed, so this cannot be mistaken for one.
export const UNTYPED_ITEM = '__untyped__';
