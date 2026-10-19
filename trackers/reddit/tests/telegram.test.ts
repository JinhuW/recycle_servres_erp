import {afterEach, describe, expect, it, vi} from 'vitest';
import {escapeHtml, formatAlert, formatReview, sendMessage} from '../src/telegram.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

const noSleep = async (): Promise<void> => {};

function ok(): Response {
  return new Response(JSON.stringify({ok: true, result: {}}), {status: 200});
}

/** A Response body can only be read once, so each call needs a fresh one. */
function alwaysOk() {
  return vi.fn().mockImplementation(async () => ok());
}

function failure(description: string, status = 400): Response {
  return new Response(JSON.stringify({ok: false, description}), {status});
}

describe('escapeHtml', () => {
  it('escapes only the three characters HTML mode reserves', () => {
    expect(escapeHtml('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
  });

  it('leaves listing punctuation alone, which is why HTML beats MarkdownV2', () => {
    const title = '[USA-NY] [H] Dell R730 (2x E5-2680v4) [W] PayPal — $650!';

    expect(escapeHtml(title)).toBe(title);
  });
});

describe('formatAlert', () => {
  const alert = {
    subreddit: 'homelabsales',
    title: '[FS][USA-CO] Dell R730xd',
    summary: 'Dell R730xd with 256GB ECC RAM, good condition, Colorado.',
    price: '$650 shipped',
    url: 'https://www.reddit.com/r/homelabsales/comments/abc/fs_dell/',
  };

  it('carries the summary and the link, which is the whole deliverable', () => {
    const message = formatAlert(alert);

    expect(message).toContain(alert.summary);
    expect(message).toContain(alert.url);
    expect(message).toContain('r/homelabsales');
  });

  it('says so when no price was stated', () => {
    expect(formatAlert({...alert, price: null})).toContain('Price: not stated');
  });

  it('escapes summary text that would break HTML parse mode', () => {
    const message = formatAlert({...alert, summary: 'RAM <2GB & more'});

    expect(message).toContain('RAM &lt;2GB &amp; more');
  });

  it('leaves the URL unescaped so Telegram links it', () => {
    expect(formatAlert(alert)).toContain(alert.url);
  });
});

describe('sendMessage', () => {
  it('sends to every configured chat', async () => {
    const spy = alwaysOk();
    vi.stubGlobal('fetch', spy);

    const report = await sendMessage('token', ['111', '222'], 'hello', noSleep);

    expect(report.delivered).toEqual(['111', '222']);
    expect(report.failed).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('posts as HTML to the bot endpoint', async () => {
    const spy = alwaysOk();
    vi.stubGlobal('fetch', spy);

    await sendMessage('bot-token', ['111'], 'hello', noSleep);

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.telegram.org/botbot-token/sendMessage');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({chat_id: '111', text: 'hello', parse_mode: 'HTML'});
  });

  it('retries once after Telegram asks us to slow down', async () => {
    const spy = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ok: false, parameters: {retry_after: 3}}),
        {status: 429},
      ))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', spy);

    const report = await sendMessage('token', ['111'], 'hello', noSleep);

    expect(report.delivered).toEqual(['111']);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('reports a rejected chat without stopping the others', async () => {
    const spy = vi.fn()
      .mockResolvedValueOnce(failure('chat not found'))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal('fetch', spy);

    const report = await sendMessage('token', ['bad', 'good'], 'hello', noSleep);

    expect(report.delivered).toEqual(['good']);
    expect(report.failed).toEqual([{chatId: 'bad', error: 'chat not found'}]);
  });

  it('reports a transport failure as a failed chat', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));

    const report = await sendMessage('token', ['111'], 'hello', noSleep);

    expect(report.delivered).toEqual([]);
    expect(report.failed).toEqual([{chatId: '111', error: 'ECONNRESET'}]);
  });

  it('reports the message id of each delivery, which is what reactions are keyed by', async () => {
    const spy = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ok: true, result: {message_id: 501}}), {status: 200},
      ))
      .mockResolvedValueOnce(failure('chat not found'));
    vi.stubGlobal('fetch', spy);

    const report = await sendMessage('token', ['111', 'bad'], 'hello', noSleep);

    expect(report.sent).toEqual([{chatId: '111', messageId: 501}]);
    expect(report.delivered).toEqual(['111']);
  });

  it('makes no request when no chats are configured', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);

    const report = await sendMessage('token', [], 'hello', noSleep);

    expect(report).toEqual({delivered: [], sent: [], failed: []});
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('formatReview', () => {
  const alert = {
    subreddit: 'homelabsales',
    title: '[FS][US-CA] 21x Micron 1100 2TB SATA SSD',
    summary: '21 Micron 1100 2TB SATA SSDs, $120 each for 10+.',
    price: '$2300',
    url: 'https://www.reddit.com/r/homelabsales/comments/x/fs/',
  };

  it('says which prompt flagged the post and shows both verdicts', () => {
    const text = formatReview({
      alert,
      verdicts: [
        {label: 'Live', promptVersionId: 3, model: 'openai/gpt-4o-mini', isTarget: false,
          reasoning: 'Only 4 SSDs remain.'},
        {label: 'Candidate', promptVersionId: 5, model: 'openai/gpt-4o-mini', isTarget: true,
          reasoning: '21 SSDs available.'},
      ],
    });

    expect(text).toContain('flagged by candidate');
    expect(text).not.toContain('flagged by live');
    expect(text).toContain('<b>Live</b> v3 · openai/gpt-4o-mini — ❌ no alert');
    expect(text).toContain('<b>Candidate</b> v5 · openai/gpt-4o-mini — ✅ alert');
    expect(text).toContain(alert.url);
    expect(text).toContain('React 👍 if this is a lead');
  });

  it('names both prompts when they agree', () => {
    const text = formatReview({
      alert,
      verdicts: [
        {label: 'Live', promptVersionId: 3, model: 'm/a', isTarget: true, reasoning: 'x'},
        {label: 'Candidate', promptVersionId: 5, model: 'm/b', isTarget: true, reasoning: 'y'},
      ],
    });
    expect(text).toContain('flagged by live and candidate');
  });

  it('escapes reasoning and labels a verdict made before versioning', () => {
    const text = formatReview({
      alert,
      verdicts: [{label: 'Live', promptVersionId: null, model: null, isTarget: true,
        reasoning: 'Lot of <8 & more'}],
    });
    expect(text).toContain('Lot of &lt;8 &amp; more');
    expect(text).toContain('<b>Live</b> unversioned · unknown model');
  });
});
