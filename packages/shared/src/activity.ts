// Cross-ledger activity vocabulary — shared by the union query in
// apps/backend/src/routes/activity.ts and the register UI in
// apps/frontend/src/pages/desktop/DesktopActivity.tsx.
//
// The four audit ledgers name the same human concept differently:
// order_events says `advanced`, sell_order_events says `status_changed`,
// inventory_events says `status`. The Activity page presents one word, so the
// raw kind → action mapping lives here rather than being written twice and
// drifting. The backend also inverts this map to turn `?action=status` into
// the set of raw kinds to filter each branch on.

export const ACTIVITY_AREAS = ['po', 'so', 'inv', 'price'] as const;
export type ActivityArea = (typeof ACTIVITY_AREAS)[number];

export const ACTIVITY_ACTIONS = [
  'created', 'status', 'edited', 'added',
  'removed', 'priced', 'moved', 'archived', 'note',
] as const;
export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];

// Raw `kind` column value → normalised action, per ledger. `ref_price_events`
// has no kind column at all (only price/source/note), so the price ledger is
// absent here — every one of its rows is synthesised as `priced`.
export const ACTIVITY_KIND_MAP: Record<
  Exclude<ActivityArea, 'price'>,
  Record<string, ActivityAction>
> = {
  po: {
    created:             'created',
    submitted:           'status',
    advanced:            'status',
    line_added:          'added',
    line_removed:        'removed',
    line_edited:         'edited',
    meta_changed:        'edited',
    owner_changed:       'edited',
    status_meta_changed: 'note',
    // Not `note` like the status attachment above: that kind covers a note and
    // a file under one name and can only be generalised, while these two say
    // which way the photo went.
    line_photo_added:    'added',
    line_photo_removed:  'removed',
    archived:            'archived',
    unarchived:          'archived',
  },
  so: {
    created:             'created',
    status_changed:      'status',
    closed:              'status',
    reopened:            'status',
    line_added:          'added',
    line_removed:        'removed',
    line_edited:         'edited',
    meta_changed:        'edited',
    price_adjusted:      'priced',
    status_meta_changed: 'note',
    archived:            'archived',
    unarchived:          'archived',
  },
  inv: {
    created:     'created',
    status:      'status',
    received:    'status',
    reopened:    'status',
    edited:      'edited',
    priced:      'priced',
    transferred: 'moved',
  },
};

// Raw kinds in `area` that normalise to `action`. Empty means the action can't
// occur in that ledger — callers must treat that as "match nothing", not
// "match everything", or an action filter would silently widen to a whole
// ledger. The price ledger is entirely `priced`, so it has no kind list.
export function kindsForAction(
  area: Exclude<ActivityArea, 'price'>,
  action: ActivityAction,
): string[] {
  return Object.entries(ACTIVITY_KIND_MAP[area])
    .filter(([, a]) => a === action)
    .map(([kind]) => kind);
}
