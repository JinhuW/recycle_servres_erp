# Git hooks

Tracked hooks, enabled per-clone with:

```sh
git config core.hooksPath .githooks
```

(Run once after cloning. CI doesn't use these — it runs the same checks
explicitly.)

## What runs when

| Hook | Check | Triggers | Blocks on |
|------|-------|----------|-----------|
| `pre-commit` | Secret scan | every commit | likely secret in staged diff |
| `pre-push` | Changelog gate | push with `feat:`/`fix:` commits | `CHANGELOG.md` not updated |
| `pre-push` | `pnpm audit` (high+) | push where `pnpm-lock.yaml` changed | high/critical advisory |
| `pre-push` | Static security | every push | dangerous code pattern in diff |
| `pre-push` | `semgrep` (optional) | push, if `semgrep` installed | semgrep findings |

Detection logic lives in `lib/scan.sh` — zero dependencies (git + grep).

## Escape hatches

- Bypass a hook once: `git commit --no-verify` / `git push --no-verify`.
- Secret false positive: append `# pragma: allowlist secret` to the line.
- Static-security false positive: add a trailing `nosec` comment.
- Dev defaults / placeholders (`change-me`, `dev-…`, `process.env`, `${…}`,
  `<placeholder>`) are allowlisted automatically.

The changelog gate is satisfied by `scripts/release.sh <patch|minor|major>`
(regenerates `CHANGELOG.md`) or a manual `## [Unreleased]` entry.
