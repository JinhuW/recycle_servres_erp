---
id: RS-509
title: Chip die code accepts any three letters and misses a bare HYNIX prefix
type: bug
status: backlog
priority: P2
created: 2026-11-02
reporter: jinhu
branch: JinhuW/walrus
pr:
version:
related: [RS-508, RS-503]
---


## Ask

> /code-review all dev changes and merge to main, then release to prod.
>
> pls. create an fix plan , then start the implementation

## Context

Split out of RS-508 (the pre-release review of v1.401.0–v1.407.0).
`chipDieCode` in `packages/shared/src/chipNumber.ts` accepts any
three-letter word as a bare die code (`BARE_DIE`'s `[A-Z]{3}` branch), and
`NOT_A_DIE` blocks only five. A Kingston lot whose Chip # reads `SEC`, `KVR`,
`DDR` or `NEW` gets that word as its short code, and `ramBidKey` folds
unrelated lots into one bid row under it. `MAKER_PREFIX` also misses a bare
`HYNIX` prefix, so `Hynix CJR` returns null.

## Acceptance criteria

- [ ] A bare three-letter Chip # counts as a die only if it is a known die code (an allowlist per maker, or a shape rule that rejects words).
- [ ] `Hynix CJR` and `HYNIX-CJR` read as `CJR`.
- [ ] `tests/chip-number-canon.test.ts` covers `SEC`, `KVR`, `DDR`, `NEW` → null.

## Out of scope

—
