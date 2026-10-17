// Watch one worker's browser: the vendored noVNC client over the console's
// WebSocket bridge (see rs_console/vnc.py).
//
// Flow: the page reads the worker id from its own path, trades the console
// token saved by the dashboard for a single-use ticket, and hands noVNC a
// wss:// URL carrying that ticket. The token itself never enters a URL.
//
// View-only by default. The session is shared with the scraper, so input
// is forwarded only while "Take control" is checked.

import RFB from '/static/novnc/core/rfb.js';

const TOKEN_KEY = 'rs-console-token'; // pragma: allowlist secret

const $ = (sel) => document.querySelector(sel);

const workerId = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() ?? '');
document.title = `${workerId} · Watch · Recycle Servers`;
$('#worker').textContent = workerId;

let rfb = null;

function setStatus(kind, text) {
  const el = $('#status');
  el.className = `vnc-status ${kind}`;
  $('#status-text').textContent = text;
}

function showOverlay(title, text, actions = []) {
  $('#overlay-title').textContent = title;
  $('#overlay-text').textContent = text;
  const box = $('#overlay-actions');
  box.innerHTML = '';
  for (const [label, onClick, primary] of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn${primary ? ' primary' : ''}`;
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    box.appendChild(btn);
  }
  $('#overlay').hidden = false;
}

function hideOverlay() { $('#overlay').hidden = true; }

async function ticket() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) {
    const err = new Error('No console token is saved in this browser. Open the fleet page and paste it once.');
    err.needsToken = true;
    throw err;
  }
  const res = await fetch(`/v1/vnc/${encodeURIComponent(workerId)}/ticket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    const err = new Error('The saved console token was rejected. Change it on the fleet page.');
    err.needsToken = true;
    throw err;
  }
  if (res.status === 404) throw new Error(`The console has no VNC target for ${workerId}. Add it to RS_VNC_TARGETS in deploy/docker-compose.console.yml.`);
  if (!res.ok) throw new Error(`Ticket request failed (${res.status}).`);
  return res.json();
}

async function connect() {
  $('#reconnect').hidden = true;
  setStatus('', 'Connecting…');
  hideOverlay();
  if (rfb) { try { rfb.disconnect(); } catch { /* already gone */ } rfb = null; }

  let grant;
  try {
    grant = await ticket();
  } catch (err) {
    setStatus('neg', 'Not connected');
    showOverlay('Cannot connect', err.message, err.needsToken
      ? [['Open the fleet page', () => { location.href = '/'; }, true]]
      : [['Try again', connect, true]]);
    return;
  }

  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${scheme}://${location.host}${grant.path}`;

  // Our own socket rather than noVNC's, so the bridge's close reason
  // ("rs-monitor-ne:5900 is not answering") reaches the overlay; noVNC only
  // logs it. addEventListener survives noVNC replacing `onclose`.
  let lastClose = null;
  const sock = new WebSocket(url);
  sock.addEventListener('close', (e) => { lastClose = { code: e.code, reason: e.reason }; });

  rfb = new RFB($('#screen'), sock, { shared: true });
  rfb.viewOnly = !$('#control').checked;
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  rfb.showDotCursor = true;
  // Compress harder: the operator is usually on the far side of a tunnel.
  rfb.qualityLevel = 5;
  rfb.compressionLevel = 6;

  rfb.addEventListener('connect', () => {
    setStatus('pos', rfb.viewOnly ? 'Watching' : 'In control');
    hideOverlay();
  });
  rfb.addEventListener('disconnect', (e) => {
    const clean = e.detail?.clean;
    setStatus('neg', 'Disconnected');
    $('#reconnect').hidden = false;
    const why = lastClose?.reason
      ? `The bridge closed the connection: ${lastClose.reason}.`
      : lastClose?.code === 1006 || lastClose?.code === 1008
        ? 'The bridge refused the connection. The ticket may have expired — reconnect to mint a new one.'
        : "The bridge closed the connection. The worker's container may be restarting, or its VNC port is not answering.";
    showOverlay(
      clean ? 'Disconnected' : 'Connection lost',
      clean ? 'The session ended.' : why,
      [['Reconnect', connect, true]],
    );
  });
  rfb.addEventListener('securityfailure', (e) => {
    setStatus('neg', 'Refused');
    showOverlay('Refused by the worker', e.detail?.reason ?? 'The VNC server rejected the connection.', [['Try again', connect, true]]);
  });
}

$('#control').addEventListener('change', (e) => {
  if (rfb) {
    rfb.viewOnly = !e.target.checked;
    if (rfb._rfbConnectionState === 'connected') setStatus('pos', rfb.viewOnly ? 'Watching' : 'In control');
  }
  document.body.classList.toggle('vnc-in-control', e.target.checked);
});

$('#reconnect').addEventListener('click', connect);

// "Re-login": ask the worker to re-run its Facebook login (username +
// password + 2FA code, all filled automatically). The console token never
// enters a URL — it rides in the Authorization header, same as the ticket.
async function requestRelogin() {
  const btn = $('#relogin');
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) {
    showOverlay('Cannot re-login', 'No console token is saved in this browser. Open the fleet page and paste it once.',
      [['Open the fleet page', () => { location.href = '/'; }, true]]);
    return;
  }
  if (!window.confirm(
    `Re-login ${workerId}?\n\nThe worker will re-enter its Facebook username, password and 2FA code on its next search cycle. Use this when the session is stuck or expired.`)) {
    return;
  }
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Requesting…';
  try {
    const res = await fetch(`/v1/workers/${encodeURIComponent(workerId)}/relogin`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      showOverlay('Re-login rejected', 'The saved console token was rejected. Change it on the fleet page.',
        [['Open the fleet page', () => { location.href = '/'; }, true]]);
      return;
    }
    if (!res.ok) throw new Error(`The coordinator returned ${res.status}.`);
    btn.textContent = 'Re-login queued';
    setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 4000);
    return;
  } catch (err) {
    showOverlay('Re-login failed', err.message, [['Close', hideOverlay, true]]);
  }
  btn.textContent = original;
  btn.disabled = false;
}

$('#relogin').addEventListener('click', requestRelogin);

// Give the tab back to the scraper if the operator wanders off mid-control.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && $('#control').checked) {
    $('#control').checked = false;
    $('#control').dispatchEvent(new Event('change'));
  }
});

connect();
