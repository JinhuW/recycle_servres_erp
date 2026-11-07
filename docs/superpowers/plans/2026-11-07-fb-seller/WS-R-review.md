# WS-R — Independent review

Starts when A2, B, C, D1, D2 and E have merged. A fresh agent that did not
build any of it reviews the merged diff against `CONTRACTS.md` only — not the
workstream files, not the PR bodies — so it reads what the code does, not what
it was meant to do.

## Look for

1. **Duplicates**: any path where a lost lease, a retried report, a second
   backend instance or a double click sends a message twice or posts an ad
   twice.
2. **Guard bypasses**: a profile setting, a rule order, a skill prompt, a
   seller message or a model reply that gets a number above ceiling, an
   acceptance, or a "I'm a person" into a sent message. Try the injection
   fixtures plus your own.
3. **Logins**: anything that could make a worker exit (a 401/409 on a worker
   route, an unhandled exception in seller dispatch that kills the process),
   restart a container, or touch a session.
4. **Search regressions**: anything that changes what a search worker is
   handed, how its minutes count, or what the fleet pages show for search
   tasks.
5. **Data**: cost/margin leaking to a non-manager; personal data in logs;
   R2 keys guessable for screenshots; photo reuse under a race.
6. **Config**: every limit really read from the DB per tick/run; nothing
   reading `ads.toml` or another file.

## Output

- A findings list ranked by severity, each with the failing scenario.
- One PR fixing the confirmed ones, with a test per fix; anything not fixed
  is listed in the README Status notes with why.
