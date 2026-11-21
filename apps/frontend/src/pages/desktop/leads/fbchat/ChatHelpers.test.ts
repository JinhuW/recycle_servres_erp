import { describe, expect, it } from 'vitest';
import type { FbChatMessageRow } from '@recycle-erp/shared';
import { FB_CHAT_MEDIA_MAX_UPLOAD_BYTES, FB_CHAT_REPLY_MEDIA_MAX } from '@recycle-erp/shared';
import {
  chatCanRetry, chatCanSend, chatDaysAgo, chatFirstName, chatMediaUrl, chatMergeMessages, chatPacing, chatPhotoSlots,
  chatReplyRequest, chatReplySignature, chatTakeAttachments, chatTimeline, chatUploadError, chatUploadRetryable,
} from './ChatHelpers';

// Local-time constructors throughout: the day rules follow the viewer's clock,
// so the tests must not depend on the machine's time zone.
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).toISOString();

let nextId = 1;
function row(over: Partial<FbChatMessageRow>): FbChatMessageRow {
  const id = over.id ?? nextId++;
  return {
    id, seq: id, direction: 'in', source: 'facebook', body: `m${id}`, images: [], media: [], backfill: false,
    fb_sent_label: null, send_state: null, error: null, typing_ms: null, tg_user_name: null,
    erp_user_id: null, author_name: null, created_at: at(12, 9), sent_at: null, ...over,
  };
}
const shape = (rows: FbChatMessageRow[]) =>
  chatTimeline(rows).map(i => (i.kind === 'message' ? `${i.message.direction}${i.endsRun ? '.' : ''}` : i.kind));

describe('chatDaysAgo', () => {
  it('counts calendar days, not 24-hour spans', () => {
    const now = new Date(2026, 10, 12, 0, 5).getTime();
    expect(chatDaysAgo(at(12, 0, 1), now)).toBe(0);
    expect(chatDaysAgo(at(11, 23, 59), now)).toBe(1);
    expect(chatDaysAgo(at(5, 12), now)).toBe(7);
  });
});

describe('chatTimeline', () => {
  it('opens each day once and marks the last bubble of a run', () => {
    expect(shape([
      row({ created_at: at(11, 18) }), row({ created_at: at(11, 18, 5) }),
      row({ direction: 'out', created_at: at(11, 19) }),
      row({ created_at: at(12, 9) }),
    ])).toEqual(['day', 'in', 'in.', 'out.', 'day', 'in.']);
  });

  it('puts one note above history read in bulk and gives it no day', () => {
    expect(shape([
      row({ backfill: true, created_at: at(12, 9) }), row({ backfill: true, direction: 'out', created_at: at(12, 9) }),
      row({ created_at: at(12, 10) }),
    ])).toEqual(['history', 'in.', 'out.', 'day', 'in.']);
  });

  it('does not open an older day for a reply still waiting below newer messages', () => {
    expect(shape([
      row({ created_at: at(12, 9) }),
      row({ direction: 'out', seq: null, send_state: 'queued', created_at: at(11, 22) }),
    ])).toEqual(['day', 'in.', 'out.']);
  });

  it('is empty for an empty chat', () => {
    expect(chatTimeline([])).toEqual([]);
  });
});

describe('chatMergeMessages', () => {
  const pending = [{ key: 3, body: 'on its way', at: at(12, 11), previews: [] }];

  it('keeps an accepted reply the answer on screen is too old to hold', () => {
    const polled = [row({ id: 10 })];
    const accepted = [row({ id: 11, direction: 'out', source: 'erp', seq: null, send_state: 'queued' })];
    expect(chatMergeMessages(polled, accepted, []).map(m => m.id)).toEqual([10, 11]);
  });

  it('lets the server row win once the answer has it', () => {
    const sent = row({ id: 11, direction: 'out', source: 'erp', send_state: 'sent' });
    const accepted = [row({ id: 11, direction: 'out', source: 'erp', seq: null, send_state: 'queued' })];
    const merged = chatMergeMessages([row({ id: 10 }), sent], accepted, []);
    expect(merged.map(m => [m.id, m.send_state])).toEqual([[10, null], [11, 'sent']]);
  });

  it('draws a reply the server has not answered for as queued, last, from the ERP', () => {
    const merged = chatMergeMessages([row({ id: 10 })], [], pending);
    expect(merged[1]).toMatchObject({ id: -3, direction: 'out', source: 'erp', send_state: 'queued', body: 'on its way', seq: null });
    expect(chatCanRetry(merged[1]!)).toBe(false);
  });

  it('carries the local previews of a pending reply until the server row with media ids replaces it', () => {
    const withPhotos = [{ key: 4, body: '', at: at(12, 11), previews: ['blob:a', 'blob:b'] }];
    const merged = chatMergeMessages([], [], withPhotos);
    expect(merged[0]).toMatchObject({ id: -4, body: '', media: [], previews: ['blob:a', 'blob:b'] });
    const stored = row({ id: 12, direction: 'out', source: 'erp', seq: null, send_state: 'queued', body: '', media: ['m1', 'm2'] });
    expect(chatMergeMessages([], [stored], [])[0]).not.toHaveProperty('previews');
  });
});

describe('chatCanRetry', () => {
  it('follows the server: an outgoing reply that failed or may not have arrived, not yet seen on Facebook', () => {
    const base = { id: 5, direction: 'out', seq: null } as const;
    expect(chatCanRetry({ ...base, send_state: 'failed' })).toBe(true);
    expect(chatCanRetry({ ...base, send_state: 'uncertain' })).toBe(true);
    expect(chatCanRetry({ ...base, send_state: 'queued' })).toBe(false);
    expect(chatCanRetry({ ...base, send_state: 'sent' })).toBe(false);
    expect(chatCanRetry({ ...base, seq: 9, send_state: 'failed' })).toBe(false);
    expect(chatCanRetry({ ...base, direction: 'in', send_state: null })).toBe(false);
  });
});

describe('chat photos', () => {
  it('loads stored copies from the media route and keeps a placeholder for the rest', () => {
    expect(chatMediaUrl('a1b2')).toBe('/api/fb-chat/media/a1b2');
    expect(chatMediaUrl('a/b')).toBe('/api/fb-chat/media/a%2Fb');
    expect(chatPhotoSlots(row({ images: ['x', 'y'], media: ['m1'] }))).toEqual({ media: ['m1'], missing: 1 });
    expect(chatPhotoSlots(row({ images: ['x'], media: [] }))).toEqual({ media: [], missing: 1 });
    expect(chatPhotoSlots(row({ images: [], media: ['m1'] }))).toEqual({ media: ['m1'], missing: 0 });
  });
});

describe('chatFirstName', () => {
  it('takes the first word, and nothing from nothing', () => {
    expect(chatFirstName('Jin Hu')).toBe('Jin');
    expect(chatFirstName('  Kevin ')).toBe('Kevin');
    expect(chatFirstName(null)).toBe('');
  });
});

describe('chatPacing', () => {
  const field = (key: string, def: number) => ({ key, type: 'number' as const, label: key, default: def, versions: ['0.3.0'] });
  const entry = (key: string, account_id: number | null, value: unknown) => ({ key, account_id, value, updated_at: at(12, 9), updated_by: null });
  const fields = [field('typingPace', 1), field('minSendIntervalSec', 20)];

  it("reads the account's own value, then every account's, then the default", () => {
    const page = { fields, entries: [entry('minSendIntervalSec', null, 30), entry('minSendIntervalSec', 2, 45)] };
    expect(chatPacing(page, 2)).toEqual({ pace: 1, gapSec: 45 });
    expect(chatPacing(page, 4)).toEqual({ pace: 1, gapSec: 30 });
  });

  it('says nothing until both values are known', () => {
    expect(chatPacing(null, 2)).toBeNull();
    expect(chatPacing({ fields: [fields[0]!], entries: [] }, 2)).toBeNull();
  });
});

describe('reply photos', () => {
  const img = (type = 'image/jpeg', size = 1000) => ({ type, size });

  it('takes images up to the per-reply limit, in order, and counts what it left out', () => {
    const files = Array.from({ length: 4 }, (_, i) => img('image/png', i + 1));
    const { take, skipped } = chatTakeAttachments(FB_CHAT_REPLY_MEDIA_MAX - 2, files);
    expect(take.map(f => f.size)).toEqual([1, 2]);
    expect(skipped).toEqual({ overLimit: 2, badType: 0, tooBig: 0 });
    expect(chatTakeAttachments(FB_CHAT_REPLY_MEDIA_MAX, [img()]).take).toEqual([]);
  });

  it('leaves out what the hub would refuse before it uploads', () => {
    const { take, skipped } = chatTakeAttachments(0, [
      img('image/heic'), img('image/gif'), img('image/webp', FB_CHAT_MEDIA_MAX_UPLOAD_BYTES + 1),
      img('image/webp', FB_CHAT_MEDIA_MAX_UPLOAD_BYTES),
    ]);
    expect(take).toHaveLength(1);
    expect(skipped).toEqual({ overLimit: 0, badType: 2, tooBig: 1 });
  });

  it('opens Send with text or an uploaded photo, never while one is uploading or failed', () => {
    const done = { state: 'done' } as const;
    expect(chatCanSend('', [])).toBe(false);
    expect(chatCanSend('   ', [])).toBe(false);
    expect(chatCanSend('hi', [])).toBe(true);
    expect(chatCanSend('', [done])).toBe(true);
    expect(chatCanSend('hi', [done, { state: 'uploading' }])).toBe(false);
    expect(chatCanSend('hi', [done, { state: 'failed' }])).toBe(false);
    expect(chatCanSend('', Array(FB_CHAT_REPLY_MEDIA_MAX + 1).fill(done))).toBe(false);
  });

  it('builds the reply body with media only when there are photos', () => {
    expect(chatReplyRequest('hi', 'k1', [])).toEqual({ body: 'hi', clientKey: 'k1' });
    expect(chatReplyRequest('', 'k2', ['a', 'b'])).toEqual({ body: '', clientKey: 'k2', media: ['a', 'b'] });
  });

  it('treats the same text with other photos as another reply', () => {
    expect(chatReplySignature('hi', ['a'])).toBe(chatReplySignature('hi', ['a']));
    expect(chatReplySignature('hi', ['a'])).not.toBe(chatReplySignature('hi', ['b']));
    expect(chatReplySignature('hi', [])).not.toBe(chatReplySignature('hi', ['a']));
  });

  it('reads why an upload was refused, and which are worth retrying', () => {
    expect([413, 415, 503, 500, undefined].map(chatUploadError)).toEqual(['tooBig', 'type', 'storage', 'other', 'other']);
    expect(chatUploadRetryable('storage')).toBe(true);
    expect(chatUploadRetryable('other')).toBe(true);
    expect(chatUploadRetryable('tooBig')).toBe(false);
    expect(chatUploadRetryable('type')).toBe(false);
  });
});
