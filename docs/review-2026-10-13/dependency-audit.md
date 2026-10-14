# Dependency audit — 2026-10-13

Command: `pnpm audit --prod --json` against the unchanged committed lockfile.

Reported advisory entries: **{'info': 0, 'low': 2, 'moderate': 13, 'high': 12, 'critical': 0}**. These are package-level reports, not a count of exploitable application bugs. Multiple entries can describe the same GHSA across versions.

- [x] **DEP-01 / P1 — Upgrade Sharp and restrict the actual image decoders used by anonymous uploads.** `apps/backend/package.json:29`, `pnpm-lock.yaml`, `apps/backend/src/lib/image-shrink.ts:76`. Locked Sharp 0.35.3 bundles libheif 1.23.1. A harmless AVIF renamed `forged.png` with MIME `image/png` passed `shrinkImageToFit(..., {strict:true})`; actual metadata format was `heif`. MIME validation does not restrict the decoder. Public forms invoke this path on untrusted files. Sharp advisories cover libheif and librsvg; no malicious exploit was executed. Refresh the lockfile to a patched release covering both advisories (audit reports 0.35.5 for the later one), block unused decoders, and validate detected format. Test PNG/JPEG/WebP acceptance and disguised AVIF/SVG refusal. See [Sharp libheif advisory](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c) and [Sharp librsvg advisory](https://github.com/advisories/GHSA-wq5f-xc86-pv6w).

- [x] **DEP-02 / P2 — Resolve and triage the remaining locked production advisories.** Update the compatible direct/transitive dependencies, regenerate the pnpm lockfile, rerun both suites/build, and rerun the audit. ExcelJS pulls multiple vulnerable brace-expansion versions; runtime reachability of attacker-controlled glob patterns was not proven. Hono is 4.12.25; many findings concern unused JSX, SSG, AWS, language, or proxy features. The CORS ReDoS advisory concerns inferred headers, while this application explicitly configures `allowHeaders`, so it is not reported as a confirmed reachable vulnerability. The Node adapter and esbuild Windows findings do not establish a Linux production exploit. Keep dispositions for deliberately unreachable advisories.

- [x] **DEP-03 / P2 — Add a repeatable dependency audit to CI or a scheduled workflow.** `.githooks/pre-push:43` audits only when a lockfile changes and only if developers installed the optional hook. `.github/workflows/backend-tests.yml` has no audit step. Newly published advisories against an unchanged lockfile receive no repository-owned automated signal. Use severity gating with reviewed reachability dispositions rather than treating every advisory as equally exploitable.

## Disposition (RS-252 batch A)

`pnpm audit --prod` reports **no known vulnerabilities** after sharp 0.35.5,
hono 4.13.13, @hono/node-server 1.19.17, tsx 4.23.15 (esbuild 0.28) and
workspace overrides pinning brace-expansion to 1.1.21+ / 2.1.7+ inside their
majors.  No advisory needed a reachability disposition.

## Raw advisory inventory (at review time)

| Severity | Package | Locked version | Advisory | Patched range reported by audit |
|---|---|---|---|---|
| low | esbuild | 0.27.7 | [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr) | `>=0.28.1` |
| high | brace-expansion | 2.1.1 | [GHSA-3jxr-9vmj-r5cp](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp) | `>=2.1.2` |
| high | brace-expansion | 1.1.15 | [GHSA-3jxr-9vmj-r5cp](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp) | `>=1.1.16` |
| moderate | hono | 4.12.25 | [GHSA-xgm2-5f3f-mvvc](https://github.com/advisories/GHSA-xgm2-5f3f-mvvc) | `>=4.12.27` |
| moderate | hono | 4.12.25 | [GHSA-hvrm-45r6-mjfj](https://github.com/advisories/GHSA-hvrm-45r6-mjfj) | `>=4.12.27` |
| moderate | hono | 4.12.25 | [GHSA-w62v-xxxg-mg59](https://github.com/advisories/GHSA-w62v-xxxg-mg59) | `>=4.12.27` |
| high | brace-expansion | 1.1.15 | [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg) | `>=1.1.17` |
| high | brace-expansion | 2.1.1 | [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg) | `>=2.1.3` |
| moderate | hono | 4.12.25 | [GHSA-8j4g-w8fx-2239](https://github.com/advisories/GHSA-8j4g-w8fx-2239) | `>=4.12.34` |
| high | brace-expansion | 2.1.1 | [GHSA-rgw5-rvv9-x895](https://github.com/advisories/GHSA-rgw5-rvv9-x895) | `>=2.1.4` |
| high | brace-expansion | 1.1.15 | [GHSA-rgw5-rvv9-x895](https://github.com/advisories/GHSA-rgw5-rvv9-x895) | `>=1.1.18` |
| moderate | hono | 4.12.25 | [GHSA-f23p-vx2j-j53r](https://github.com/advisories/GHSA-f23p-vx2j-j53r) | `>=4.12.34` |
| low | hono | 4.12.25 | [GHSA-79qm-7rj5-m7r9](https://github.com/advisories/GHSA-79qm-7rj5-m7r9) | `>=4.12.34` |
| moderate | hono | 4.12.25 | [GHSA-54fx-42gc-7vw4](https://github.com/advisories/GHSA-54fx-42gc-7vw4) | `>=4.12.34` |
| moderate | @hono/node-server | 1.19.14 | [GHSA-frvp-7c67-39w9](https://github.com/advisories/GHSA-frvp-7c67-39w9) | `>=1.19.15` |
| high | sharp | 0.35.3 | [GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c) | `>=0.35.4` |
| moderate | hono | 4.12.25 | [GHSA-gqvv-2mrq-wpjv](https://github.com/advisories/GHSA-gqvv-2mrq-wpjv) | `>=4.13.5` |
| moderate | hono | 4.12.25 | [GHSA-g6gw-c38x-mqfc](https://github.com/advisories/GHSA-g6gw-c38x-mqfc) | `>=4.13.5` |
| moderate | hono | 4.12.25 | [GHSA-crvj-82cr-hjcx](https://github.com/advisories/GHSA-crvj-82cr-hjcx) | `>=4.13.5` |
| moderate | brace-expansion | 1.1.15 | [GHSA-q2hr-2g5m-vwhr](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr) | `>=1.1.21` |
| moderate | brace-expansion | 2.1.1 | [GHSA-q2hr-2g5m-vwhr](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr) | `>=2.1.7` |
| high | brace-expansion | 1.1.15 | [GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7) | `>=1.1.20` |
| high | brace-expansion | 2.1.1 | [GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7) | `>=2.1.6` |
| high | brace-expansion | 1.1.15 | [GHSA-6j4f-fj2g-mc7p](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p) | `>=1.1.19` |
| high | brace-expansion | 2.1.1 | [GHSA-6j4f-fj2g-mc7p](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p) | `>=2.1.5` |
| moderate | hono | 4.12.25 | [GHSA-hxh3-vqpv-xpqv](https://github.com/advisories/GHSA-hxh3-vqpv-xpqv) | `>=4.13.7` |
| high | sharp | 0.35.3 | [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w) | `>=0.35.5` |
