// Facebook seller accounts: the "we buy" ads they post, the photo pools those
// ads draw from, the Marketplace conversations they read, and the agent that
// screens and negotiates in them. Wire shapes for /api/fb-seller and
// /api/fb-agent and the agent's own types, snake_case like fleet.ts, every
// instant an ISO-8601 string and every NUMERIC a number. The worker-facing
// shapes (payloads, reports) are in fleet.ts beside the rest of the protocol.

// ─── Settings ─────────────────────────────────────────────────────────────────

export type FbSellerSettings = {
  /** true: no agent run sends, and queued agent messages are held. */
  kill_switch: boolean;
  /** 'HH:MM' and an IANA zone; outside them no seller task is due. */
  active_hours: { start: string; end: string; tz: string };
  pacing: {
    /** Between any ad-post or ad-delete on one account. */
    ad_action_gap_minutes: number;
    max_live_ads_per_account: number;
    /** Placements of one ad in one location per day. */
    same_ad_location_per_day: number;
    /** The default for new ads. */
    renew_days: number;
    renew_jitter_days: number;
    /** Between msg-send tasks on one account. */
    send_gap_seconds: number;
    send_jitter_seconds: number;
    sends_per_account_day: number;
    inbox_every_minutes: number;
    inbox_jitter_minutes: number;
    inbox_max_threads: number;
    inbox_max_messages: number;
  };
  offer: {
    /** The first offer, as % of the ceiling. */
    opening_pct: number;
    /** Added per round, in % of the ceiling. */
    step_pct: number;
    max_rounds: number;
    /** A Market price older than this hands the thread off. */
    price_max_age_days: number;
  };
  agent: {
    /** Every run, shadow runs included. */
    daily_spend_usd: number;
    /** Consecutive guard or send failures on one account before its agent_on goes false. */
    circuit_breaker_failures: number;
  };
  /** Unused photos left in a pool that raise an alert. */
  photos: { low_pool_warning: number };
  alerts: { telegram_chat_id: string | null };
};

/** What migration 0232 seeds; a test holds the row to this. */
export const FB_SELLER_DEFAULT_SETTINGS: FbSellerSettings = {
  kill_switch: false,
  active_hours: { start: '08:00', end: '22:00', tz: 'America/Denver' },
  pacing: {
    ad_action_gap_minutes: 20, max_live_ads_per_account: 3, same_ad_location_per_day: 1,
    renew_days: 7, renew_jitter_days: 2,
    send_gap_seconds: 60, send_jitter_seconds: 30, sends_per_account_day: 40,
    inbox_every_minutes: 5, inbox_jitter_minutes: 2, inbox_max_threads: 10, inbox_max_messages: 25,
  },
  offer: { opening_pct: 70, step_pct: 10, max_rounds: 3, price_max_age_days: 30 },
  agent: { daily_spend_usd: 5, circuit_breaker_failures: 3 },
  photos: { low_pool_warning: 15 },
  alerts: { telegram_chat_id: null },
};

/** One saved change to the settings, from the append-only history. */
export type FbSettingsChange = {
  id: number;
  version: number;
  before: FbSellerSettings | null;
  after: FbSellerSettings;
  changed_by: string | null;
  changed_by_name: string | null;
  changed_at: string;
};

/** A refusal from either route family: `detail` is a sentence, never a status code. */
export type FbRefusal = { error: string; detail: string };

// ─── Summary and accounts ─────────────────────────────────────────────────────

/** The badge counts Leads ▸ Facebook polls. */
export type FbSellerSummary = {
  needs_human: number;
  unread: number;
  uncertain_placements: number;
  needs_photos: number;
  /** Pools under `photos.low_pool_warning` unused photos. */
  low_pools: number;
};

export type FbSellerRole = 'search' | 'seller';

/** One fleet slot as the seller pages see it. */
export type FbSellerAccount = {
  account_no: number;
  role: FbSellerRole;
  agent_on: boolean;
  /** Null follows the active profile. */
  agent_profile_id: number | null;
  worker_id: string | null;
  /** The account's last known state (HEALTHY, CHECKPOINT, …); null for none. */
  account_state: string | null;
  live_ads: number;
  open_threads: number;
  needs_human: number;
  sends_today: number;
};

// ─── Photos ───────────────────────────────────────────────────────────────────

export type FbPhotoPool = {
  id: number;
  name: string;
  note: string;
  used: number;
  unused: number;
  created_by: string | null;
  created_at: string;
  archived_at: string | null;
};

export type FbPhoto = {
  id: number;
  pool_id: number;
  url: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  sha256: string;
  uploaded_by: string | null;
  uploaded_at: string;
  /** Set once, never cleared: a photo is used once, ever. */
  used_at: string | null;
  used_by_placement: number | null;
};

// ─── Ads and placements ───────────────────────────────────────────────────────

export const FB_AD_STATES = ['draft', 'ready', 'archived'] as const;
export type FbAdState = (typeof FB_AD_STATES)[number];

export type FbAdInput = {
  title: string;
  description: string;
  price_usd: number;
  category?: string;
  condition?: string;
  renew_days?: number;
  photo_pool_id: number | null;
  photos_min?: number;
  photos_max?: number;
};

export const FB_PLACEMENT_STATES = ['needs_photos', 'queued', 'live', 'removing', 'removed', 'failed', 'uncertain'] as const;
export type FbPlacementState = (typeof FB_PLACEMENT_STATES)[number];

/** The ad's text as it was when the placement was made. */
export type FbPlacementContent = {
  title: string;
  description: string;
  price_usd: number;
  category: string;
  condition: string;
};

export type FbPlacement = {
  id: number;
  ad_id: number;
  account_no: number | null;
  location: string;
  content: FbPlacementContent;
  photo_ids: number[];
  state: FbPlacementState;
  /** The placement this one replaced. */
  renews_id: number | null;
  fb_listing_id: string | null;
  posted_at: string | null;
  next_renew_at: string | null;
  removed_at: string | null;
  last_error: string | null;
  task_id: number | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type FbAd = {
  id: number;
  title: string;
  description: string;
  price_usd: number;
  category: string;
  condition: string;
  renew_days: number;
  photo_pool_id: number | null;
  photos_min: number;
  photos_max: number;
  state: FbAdState;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  live_placements: number;
  /** Present on GET /ads/:id only. */
  placements?: FbPlacement[];
};

// ─── Threads and messages ─────────────────────────────────────────────────────

export const FB_THREAD_STAGES = ['new', 'screening', 'negotiating', 'closing', 'won', 'lost'] as const;
export type FbThreadStage = (typeof FB_THREAD_STAGES)[number];

export type FbThreadMode = 'agent' | 'human';
export type FbMessageDirection = 'in' | 'out' | 'unknown';
/** 'facebook': an outbound message we did not queue. */
export type FbMessageAuthor = 'seller' | 'agent' | 'staff' | 'facebook';
export type FbSendState = 'queued' | 'held' | 'sending' | 'sent' | 'uncertain' | 'failed';

export type FbThreadRow = {
  id: number;
  account_no: number | null;
  fb_thread_id: string;
  seller_name: string;
  listing_title: string;
  placement_id: number | null;
  stage: FbThreadStage;
  mode: FbThreadMode;
  needs_human: boolean;
  human_reason: string | null;
  human_at: string | null;
  offer_usd: number | null;
  ceiling_usd: number | null;
  round: number;
  unread: boolean;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
  /** The newest message's text, for the list. */
  last_body: string | null;
  closed_at: string | null;
  updated_at: string;
};

export type FbMessage = {
  id: number;
  thread_id: number;
  /** Null while an outbound has not been seen to land. */
  seq: number | null;
  direction: FbMessageDirection;
  author: FbMessageAuthor;
  body: string;
  has_image: boolean;
  /** Null for inbound. */
  send_state: FbSendState | null;
  task_id: number | null;
  agent_run_id: number | null;
  staff_user_id: string | null;
  staff_name: string | null;
  error: string | null;
  created_at: string;
  sent_at: string | null;
};

export const FB_THREAD_EVENT_KINDS = [
  'created', 'inbound', 'agent_sent', 'staff_sent', 'handed_off', 'taken_over', 'handed_back',
  'stage', 'offer', 'closed', 'send_failed', 'send_uncertain', 'realigned',
] as const;
export type FbThreadEventKind = (typeof FB_THREAD_EVENT_KINDS)[number];

export type FbThreadEvent = {
  id: number;
  thread_id: number;
  kind: FbThreadEventKind;
  actor_id: string | null;
  actor_name: string;
  detail: Record<string, unknown>;
  created_at: string;
};

/** One agent run as the thread page lists it. */
export type FbAgentRunBrief = {
  id: number;
  profile_id: number | null;
  shadow: boolean;
  state: 'queued' | 'running' | 'done' | 'failed';
  outcome: 'send' | 'handoff' | 'noop' | 'blocked' | 'error' | null;
  decision: AgentDecision | null;
  cost_usd: number | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
};

/** A Market row matched to an item the seller named. */
export type FbMarketMatch = {
  canon: string;
  part_number: string;
  label: string;
  max_buy_unit: number | null;
  price_at: string | null;
};

export type FbThreadDetail = FbThreadRow & {
  extracted: AgentExtract | Record<string, never>;
  close_note: string | null;
  messages: FbMessage[];
  events: FbThreadEvent[];
  runs: FbAgentRunBrief[];
  market: FbMarketMatch[];
};

/** What the agent loop reads about one thread (fbThreads.loadThreadSnapshot). */
export type FbThreadSnapshot = {
  thread: {
    id: number;
    account_no: number | null;
    stage: FbThreadStage;
    mode: FbThreadMode;
    needs_human: boolean;
    round: number;
    offer_usd: number | null;
    ceiling_usd: number | null;
    listing_title: string;
    extracted: AgentExtract | Record<string, never>;
  };
  /** In seq order; unseen outbounds (seq null) last. */
  messages: { id: number; seq: number | null; direction: FbMessageDirection; author: FbMessageAuthor; body: string; has_image: boolean }[];
};

// ─── Agent ────────────────────────────────────────────────────────────────────

export type AgentInput = {
  thread: { id: number | null; stage: FbThreadStage; round: number; offer_usd: number | null; listing_title: string };
  messages: { seq: number; direction: FbMessageDirection; author: string; body: string; has_image: boolean }[];
  /** Built by code; never goes into a prompt. */
  market: FbMarketMatch[];
  /** Never goes into a prompt. */
  settings: FbSellerSettings['offer'];
  now: string;
};

export const AGENT_INTENTS = [
  'offer_items', 'question', 'counter', 'agree', 'decline', 'logistics', 'bot_question', 'hostile', 'off_topic', 'other',
] as const;
export type AgentIntent = (typeof AGENT_INTENTS)[number];

export type AgentExtract = {
  items: { part_number: string | null; description: string; qty: number | null }[];
  seller_ask_usd: number | null;
  intent: AgentIntent;
  agreeing: boolean;
  /** 0..1 */
  confidence: number;
};

export type AgentDecision = {
  outcome: 'send' | 'handoff' | 'noop' | 'blocked';
  extract: AgentExtract | null;
  skill: string | null;
  /** The final text, placeholder filled. */
  reply: string | null;
  offer: { offer_usd: number; ceiling_usd: number; round: number } | null;
  stage: FbThreadStage | null;
  rules_fired: { kind: string; reason: string }[];
  guard: { ok: boolean; failures: string[] };
  /** In words, shown to managers. */
  handoff_reason: string | null;
  usage: { model: string; prompt_tokens: number; completion_tokens: number; cost_usd: number }[];
};

export const FB_AGENT_PROFILE_STATES = ['draft', 'candidate', 'active', 'retired'] as const;
export type FbAgentProfileState = (typeof FB_AGENT_PROFILE_STATES)[number];

export type FbAgentModule = { kind: string; enabled: boolean; params: Record<string, unknown> };

export type FbAgentProfile = {
  id: number;
  name: string;
  version: number;
  state: FbAgentProfileState;
  prompts: { system: string; extract: string; skills: Record<string, string> };
  skills: FbAgentModule[];
  /** Run in this order. */
  rules: FbAgentModule[];
  models: { extract: string; reply: string };
  notes: string;
};

/** A profile version in the list, with its lineage. */
export type FbAgentProfileRow = FbAgentProfile & {
  based_on: number | null;
  created_by: string | null;
  created_at: string;
  promoted_at: string | null;
};

/** The small JSON-schema subset a rule's or skill's params use, which the editor renders as a form. */
export type ParamSchema = {
  type: 'object';
  properties: Record<string, ParamField>;
  required?: string[];
};

export type ParamField =
  | { type: 'number'; label: string; minimum?: number; maximum?: number; default?: number }
  | { type: 'integer'; label: string; minimum?: number; maximum?: number; default?: number }
  | { type: 'boolean'; label: string; default?: boolean }
  | { type: 'string'; label: string; default?: string }
  | { type: 'array'; label: string; items: { type: 'string'; enum?: string[] }; default?: string[] };

export type RegistryEntry = { kind: string; label: string; params: ParamSchema };

export type EvalExpectation = {
  handoff: boolean;
  reason_kind?: string;
  max_offer_usd?: number;
  must_not_contain?: string[];
};

export type FbAgentEvalCase = {
  id: number;
  name: string;
  source_thread_id: number | null;
  input: AgentInput;
  expected: EvalExpectation;
  created_by: string | null;
  created_at: string;
  archived_at: string | null;
};

export type FbAgentEvalRun = {
  id: number;
  profile_id: number;
  state: 'queued' | 'running' | 'done' | 'failed';
  cases: number;
  passed: number;
  failed: number;
  cost_usd: number;
  created_by: string | null;
  created_at: string;
  finished_at: string | null;
};

// ─── Shadow runs and evals (/api/fb-agent, CONTRACTS §6.7) ────────────────────

/** A candidate's shadow decision beside the live one for the same inbound message. */
export type FbShadowPair = {
  trigger_message_id: number | null;
  thread_id: number | null;
  trigger_body: string | null;
  created_at: string;
  shadow: FbAgentRunBrief;
  /** Null when the live run is gone or never happened. */
  live: FbAgentRunBrief | null;
};

export type FbShadowPage = { rows: FbShadowPair[]; next: string | null };

/** One case of an eval run, graded against the case's expectation. */
export type FbEvalCaseResult = {
  case_id: number;
  case_name: string;
  run_id: number;
  state: 'queued' | 'running' | 'done' | 'failed';
  decision: AgentDecision | null;
  /** Null while the case has not run. */
  passed: boolean | null;
  /** Why it failed, in words; empty when it passed. */
  why: string[];
  cost_usd: number | null;
  error: string | null;
};

export type FbAgentEvalRunDetail = FbAgentEvalRun & {
  profile: { id: number; name: string; version: number };
  /** Why the run stopped early, in words. */
  error: string | null;
  results: FbEvalCaseResult[];
};

/** What compare looks at in one case's decision. */
export type FbEvalCaseSummary = {
  handoff: boolean;
  reason_kind: string | null;
  offer_usd: number | null;
  reply: string | null;
  passed: boolean | null;
};

export type FbEvalCompareRow = {
  case_id: number;
  case_name: string;
  /** Null when the case is missing from that run. */
  a: FbEvalCaseSummary | null;
  b: FbEvalCaseSummary | null;
  changed: boolean;
  /** The fields that differ: handoff, reason_kind, offer_usd, reply, passed, or present. */
  changes: string[];
};

export type FbEvalCompare = { a: FbAgentEvalRun; b: FbAgentEvalRun; rows: FbEvalCompareRow[]; changed: number };
