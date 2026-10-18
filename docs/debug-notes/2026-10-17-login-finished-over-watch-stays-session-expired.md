# A login finished over Watch stays "Session expired" until the next sweep

**Fixed** in facebook-tracker 0.10.3 (RS-289). The idle worker now checks its
login every minute, and SIGTERM saves the session before exit.

**Seen:** 2026-10-17, va-2 (`rs-monitor-va2`, facebook-tracker 0.10.0).

## Symptom

The operator pressed Re-login, then finished the Facebook login by hand in
Watch. The browser was logged in, as a screenshot of `:99` confirmed, but the
fleet row kept saying **Needs attention · Session expired**, and
`/data/fb_state.json` held `{"cookies": [], "origins": []}`.

```
20:37:24  WARNING  [Login] Session invalid; falling back to password login.
20:37:59  INFO     [Login] Waiting 2 minutes ...
20:39:59  WARNING  [Login] Not saving the session: this browser is no longer logged in
          INFO     [Schedule] Next job to search server_ram ... 2026-10-18 10:00:00
```

## Cause

The vault had credentials, so the forced login typed the password and waited
out `login_wait_time` (2 minutes). The operator finished after the window
closed. Only the no-credentials path *parked* the page, and the idle loop only
looked for a by-hand login on a parked page. So nothing re-checked the login,
and the heartbeat repeater kept restating the last state, `SESSION_EXPIRED`,
until the next sweep 13 hours later. The session lived only in the browser's
memory, so a restart in that window would have thrown it away.

0.10.1 made a timed-out password login park. 0.10.3 removes the dependency on
parking altogether: the idle loop compares the browser with the last reported
state every minute (`check_session`).

## Traps hit while recovering it

- **Don't restart the container to "pick up" a hand login.** Before 0.10.3
  the monitor died on SIGTERM without saving, and the session was only in
  memory. Check `wc -c /data/fb_state.json` before any restart or deploy.
- **Don't press Re-login on a browser that is already logged in.** A forced
  login drops the session cookies first.
- **Editing the worker's config on the host does not wake the monitor.** The
  config is a single-file bind mount
  (`configs/homelab-<x>.toml:/root/.ai-marketplace-monitor/config.toml:ro`).
  The monitor's watchdog watches the *container's* directory, but inotify
  reports writes to a bind-mounted file on the host's `configs/` directory.
  The change lands in the file, and `doze()` never hears of it. The web UI's
  "restart monitor" button touches the same file, so it does nothing on the
  homelab workers either.

## Rolling out a fix like this

The process that holds the unsaved login runs the *old* code, so the deploy
that ships the SIGTERM save is itself the restart that loses the login. Let
the worker's next sweep save the session first (`fb_state.json` well over 31
bytes), then deploy.
