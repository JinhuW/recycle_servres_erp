---
id: RS-132
title: AI read mode in the serial-number scanner
type: story
status: in-progress
priority: P2
created: 2026-10-01
reporter: jinhu
branch: feat/rs132-sn-scanner-ai-read
pr:
version:
related: []
---

## Ask

> In the SN code scanner, Add an switch option to use openai api to extract the sn code from the image option cus some qr code is broken.

## Context

The phone serial scanner (`SnScanner`) only decodes QR / DataMatrix / Code-128.
A damaged code never fires, and the purchaser types the serial by hand. A
vision model can read the printed S/N off the same label. The requester chose
to reuse the existing OpenRouter pipeline (an OpenAI model, same key as label
and PayPal OCR) rather than a direct OpenAI key.

## Acceptance criteria

- [ ] The serial scanner on the phone Submit form has a QR / AI switch; it
      opens on QR every time.
- [ ] In AI mode a shutter sends the framed shot to `POST /api/scan/serial`,
      which returns the printed serial (or null).
- [ ] A read is shown with Use / Retake — never auto-added; Use adds the chip,
      a duplicate (case-insensitive) shows the "Already scanned" toast.
- [ ] No serial found / service failure shows a toast and the user can retake.
- [ ] The Shipping tracking scan is unchanged (no switch).

## Out of scope

Desktop (no camera serial scanner), the Shipping scan, remembering the mode,
several serials per shot.

## Notes

Plan: `~/.claude/plans/sunny-watching-parasol.md`. A module's QR often encodes
more than the printed S/N, so one stick read once by QR and once by AI can
produce two different chips — not deduplicated.
