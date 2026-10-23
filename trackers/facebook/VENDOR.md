# Vendored projects

Two directories in this tree are **not tracked by this repository**. Each is a
checkout of someone else's project with its own git history, and each is
gitignored at the root.

Keeping them separate is deliberate. `ai-marketplace-monitor` is a fork we
rebase onto new upstream releases, and that only stays cheap while its upstream
history is intact — folding the files into this repo would throw that away, and
a gitlink would record an upstream commit that does not contain our patches at
all. So they are pinned here by commit instead, and
`scripts/check-vendor.sh` verifies the working copies still match.

| Path | Upstream | Branch | Pinned commit |
| --- | --- | --- | --- |
| `ai-marketplace-monitor/` | https://github.com/BoPeng/ai-marketplace-monitor | `recycle-patches` | `93e2566965b6b305de8bc3f7d0360ec381fd1407` |
| `facebook-marketplace-bot/` | https://github.com/GeorgiKeranov/facebook-marketplace-bot | (as cloned) | `3bda6b40dc6be0a613c3785bed3eb0409f9b5377` |

## ai-marketplace-monitor

The engine every worker runs. Our changes live on **`recycle-patches`**, which
branches from upstream `16394b3e2a8c232f6d78a942fb85237f4e193a85` (release 0.10.2). README.md carries the
table of what those changes are and why.

Reconstitute it:

```bash
git clone https://github.com/BoPeng/ai-marketplace-monitor
cd ai-marketplace-monitor && git checkout recycle-patches
```

`recycle-patches` is local-only. It is **never pushed to `origin`** — that
remote is the upstream author's repository, not ours. Give it a private remote
before relying on a clone of this tree being enough to redeploy.

Before pulling upstream, **rebase** that branch rather than merging into it, and
re-run `scripts/check-vendor.sh` to refresh the pin above.

**Why `recycle-patches` has `8979534`, not `96d9204`.** `96d9204` (the RS-338 endpoint
fix that 0.13.12 shipped) existed only in a worktree's clone, and that clone
was deleted. With no private remote, no copy of the commit survived. `8979534`
rebuilds it:

- Same parent, `c20d341`.
- Same single-file change to `token_session.py`, copied from the VM.
- An rsync checksum dry run found no content difference against the deployed
  tree on the VM. That covers every file except what `deploy.rsync-filter`
  keeps off the VM: `.git` and five docs PNGs.

The code the fleet runs is unchanged; only the hash moved. The private remote
asked for above is what would have prevented this.

## facebook-marketplace-bot

Reference only — stale Selenium, never run. Its posting flow was reimplemented
in `rs_poster`, which is tracked here. Kept solely so the original can be read.
