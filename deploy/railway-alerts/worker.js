// Ops alerts → a Telegram forum group, one topic per kind of alert.
//
// `POST /` takes Railway project webhooks. Railway formats its payload only
// for Discord and Slack; any other URL gets raw JSON, which Telegram's
// sendMessage can't take. `POST /alert` takes our own senders (uptime monitor,
// reddit watchdog), which name a topic key and leave the group and thread ids
// to this file's config. This runs on Cloudflare rather than Railway so an
// alert still gets out while Railway is the thing failing.

const TOPIC_BY_TYPE = {
  'Deployment.failed': 'deploy_failed',
  'Deployment.crashed': 'crashed',
  'Deployment.oom_killed': 'crashed',
};

const LABEL_BY_TYPE = {
  'Deployment.failed': '🔴 Deploy failed',
  'Deployment.crashed': '🔴 Crashed',
  'Deployment.oom_killed': '🔴 Out of memory',
  'Monitor.triggered': '⚠️ Monitor triggered',
  'Monitor.resolved': '✅ Monitor resolved',
  'VolumeAlert.triggered': '⚠️ Volume alert',
  'VolumeAlert.resolved': '✅ Volume alert resolved',
};

// Railway also puts these in `details` for a deployment; the commit line
// already says what matters about them.
const COMMIT_KEYS = new Set(['id', 'source', 'status', 'branch', 'commitHash', 'commitAuthor', 'commitMessage']);
// Telegram caps a message at 4096 characters, and refusing an over-long one
// would leave a sender retrying it forever.
const MAX_DETAIL_LINES = 10;
const MAX_ALERT_CHARS = 3800;

const ICON_BY_STATUS = { firing: '🔴', resolved: '✅', info: 'ℹ️' };

// Each route has its own bearer, so the Railway webhooks and our own senders
// rotate independently.
const ROUTES = {
  '/': { secret: (env) => env.WEBHOOK_SECRET, render: railwayMessage },
  '/alert': { secret: (env) => env.ALERT_TOKEN, render: alertMessage },
};

export default {
  async fetch(request, env) {
    const route = ROUTES[new URL(request.url).pathname];
    if (request.method !== 'POST' || !route) {
      return new Response('Not found', { status: 404 });
    }
    if (!(await authorized(request, route.secret(env)))) {
      return new Response('Unauthorized', { status: 401 });
    }
    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response('Bad JSON', { status: 400 });
    }
    console.log(JSON.stringify(payload));

    const { text, topic } = route.render(payload);
    const thread = env.TOPICS && Object.hasOwn(env.TOPICS, topic) ? env.TOPICS[topic] : undefined;
    let sent = await send(env, text, thread);
    // A topic deleted in Telegram must not swallow the alert: General still
    // reaches the same people.
    if (!sent.ok && thread !== undefined && /thread not found/i.test(sent.description)) {
      sent = await send(env, text, undefined);
    }
    if (!sent.ok) {
      console.error(`telegram rejected the alert: ${sent.description}`);
      // Railway retries a non-2xx delivery up to three times; our senders
      // retry on their next tick.
      return new Response('Telegram rejected the alert', { status: 502 });
    }
    return new Response(null, { status: 204 });
  },
};

function railwayMessage(payload) {
  return { text: format(payload), topic: topicKey(String(payload.type ?? '')) };
}

// `{topic, status, title, lines?, link?}` from our own senders.
export function alertMessage(payload) {
  const status = String(payload.status ?? 'info');
  const lines = [`<b>${ICON_BY_STATUS[status] ?? ICON_BY_STATUS.info} ${escapeHtml(clip(String(payload.title ?? 'Alert')))}</b>`];
  const extra = Array.isArray(payload.lines) ? payload.lines : [];
  const link = payload.link ? `<a href="${escapeHtml(String(payload.link))}">Open</a>` : '';
  let length = lines[0].length + link.length;
  let shown = 0;
  for (const line of extra) {
    const html = escapeHtml(clip(String(line)));
    if (length + html.length + 1 > MAX_ALERT_CHARS) break;
    lines.push(html);
    length += html.length + 1;
    shown++;
  }
  if (shown < extra.length) lines.push(`… ${extra.length - shown} more`);
  if (link) lines.push(link);
  return { text: lines.join('\n'), topic: String(payload.topic ?? '') };
}

// Railway doesn't sign its webhooks; every project's webhook carries this
// bearer as a custom header instead. Digests are compared, not the strings, so
// the comparison's timing says nothing about the secret.
async function authorized(request, secret) {
  if (!secret) return false;
  const [got, want] = await Promise.all([
    digest(request.headers.get('Authorization') ?? ''),
    digest(`Bearer ${secret}`),
  ]);
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
}

async function digest(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

export function topicKey(type) {
  if (TOPIC_BY_TYPE[type]) return TOPIC_BY_TYPE[type];
  if (type.startsWith('Monitor.')) return 'monitor';
  if (type.startsWith('VolumeAlert.')) return 'volume';
  return undefined;
}

export function format(payload) {
  const type = String(payload.type ?? 'unknown');
  const resource = payload.resource ?? {};
  const details = payload.details ?? {};
  const lines = [`<b>${escapeHtml(LABEL_BY_TYPE[type] ?? type)}</b>`];

  const where = [resource.project, resource.environment, resource.service, resource.volume]
    .map((r) => r?.name)
    .filter(Boolean);
  if (where.length) lines.push(escapeHtml(where.join(' / ')));

  if (details.commitHash) {
    const message = String(details.commitMessage ?? '').split('\n')[0];
    const author = details.commitAuthor ? ` — ${escapeHtml(String(details.commitAuthor))}` : '';
    lines.push(`<code>${escapeHtml(String(details.commitHash).slice(0, 7))}</code> ${escapeHtml(clip(message))}${author}`);
  }
  // Railway documents only the deployment shape and its test events send an
  // empty `details`, so monitor and volume fields are listed as they come.
  const rest = Object.fromEntries(Object.entries(details).filter(([key]) => !COMMIT_KEYS.has(key)));
  for (const [key, value] of flatten(rest).slice(0, MAX_DETAIL_LINES)) {
    lines.push(`${escapeHtml(key)}: ${escapeHtml(clip(String(value)))}`);
  }

  const link = railwayLink(resource);
  if (link) lines.push(`<a href="${escapeHtml(link)}">Open in Railway</a>`);
  return lines.join('\n');
}

function railwayLink({ project, environment, service, deployment }) {
  if (!project?.id) return null;
  const base = `https://railway.com/project/${encodeURIComponent(project.id)}`;
  const inEnv = environment?.id ? `environmentId=${encodeURIComponent(environment.id)}` : '';
  if (!service?.id) return inEnv ? `${base}?${inEnv}` : base;
  const params = [deployment?.id ? `id=${encodeURIComponent(deployment.id)}` : '', inEnv].filter(Boolean).join('&');
  return `${base}/service/${encodeURIComponent(service.id)}${params ? `?${params}` : ''}`;
}

function flatten(value, prefix = '') {
  return Object.entries(value).flatMap(([key, v]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (v === null || v === undefined || v === '') return [];
    return typeof v === 'object' ? flatten(v, path) : [[path, v]];
  });
}

function clip(text) {
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function send(env, text, thread) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      message_thread_id: thread,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok && body.ok === true, description: body.description ?? `HTTP ${res.status}` };
}
