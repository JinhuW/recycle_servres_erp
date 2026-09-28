---
id: RS-115
title: Switch image AI to OpenAI gpt-6-luna, and let new sheet scans append to the table
type: story
status: done
priority: P2
created: 2026-09-26
reporter: jinhu
branch: feat/openai-image-ai-and-append-scans
pr: "#416"
version: 1.181.0
related: [RS-109, RS-114]
---

## Ask

> update the model to use openai model which is cheap, but reliable for image recognization.

> also when i start a new scan, it should append to the existing table instead from new.

Answers after a benchmark was shown: model "gpt-6-luna"; scope "All image AI".

## Context

All three image-AI features (RAM/SSD/HDD label scans, purchase-receipt rename, PayPal txn id) share `openRouterImageJson`, defaulting to `google/gemini-2.5-flash`. Nothing overrides it in dev or prod.

On real RAM label crops, using the ERP prompt and normalizer, `openai/gpt-6-luna` read every field right on 300 dpi scans (48/48) and 93/96 overall. It costs about $0.21 per 1,000 sticks against Gemini's $0.70, at ~3.8 s against ~1.6 s. OpenAI models only work well with `detail: "high"` and minimal reasoning, and they need more output room than the old 1024 tokens.

In the Scan RAM sheet dialog, every scan replaced the table, so a pallet that spans several pages couldn't be collected in one go.

## Acceptance criteria

- [x] Image AI requests go to `openai/gpt-6-luna` with high image detail, minimal reasoning, JSON output and no temperature. `OPENROUTER_OCR_MODEL` still overrides, and a Gemini override sends today's request.
- [x] An empty or truncated model answer is retried once, not failed.
- [x] RAM crops from a real 300 dpi scan read correctly. Receipt and PayPal extraction is sanity-checked against Gemini before merge.
- [x] A second scan or upload adds its sticks below the first, numbered on from the last. It is grouped per scan, with Remove per group and Clear all.
- [x] Rescanning the same sheet is flagged, so combining identical part numbers doesn't double qty unnoticed.

## Out of scope

Per-scan page tabs (only the latest page is previewed); a separate model setting per feature.

## Notes

Live checks before merge, through the real code paths:
- gpt-6-luna read both sticks of a real 300 dpi scan correctly 3 times out of 3.
- It named Alipay ¥1,250.00 and Zelle $980.00 receipts correctly.
- It read the PayPal transaction ID and seller exactly.

In the smoke, the 150 dpi sample misread or omitted a field in about half the reads, for example a 32GB Samsung as 8GB. Enlarging the crop 2× didn't fix it. The user chose to ship luna anyway.

Rollback: set `OPENROUTER_OCR_MODEL=google/gemini-2.5-flash` on Railway. No deploy is needed.
