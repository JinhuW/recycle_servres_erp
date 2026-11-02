---
id: RS-503
title: RAM short code reads the chip die on Kingston and other brands
type: story
status: done
priority: P2
created: 2026-11-02
reporter: jinhu
branch: JinhuW/gulper
pr: https://github.com/JinhuW/recycle_servres_erp/pull/1056
version: 1.407.0
related: []
---

## Ask

> review all my history of ram inventory / product in the system, pls help me double check all of them chips number(DDR4 only). Fill the information of the chips. if miss.
> also help me correct the short code of them.
> based on refernence of following context:
> 三星
> 8G 1R8  2133（BB0）
> 8G 1R8  24/26/32（BB1/BB2/CB1/CB2/DB1/EB1）
> 16G 2R8 （价格*2）
>
> 16G 1R8   32（AB2/BB2/CB2）
> 32G 2R8 （价格*2）
>
> 镁光
> 8G 1R8  24/26/32（VPP/TBH/TZV/WSM/WFL/BPJ）
> 16G 2R8 （价格*2）
>
> 16G 1R8   32（XPF/CJV）
> 32G 2R8 （价格*2）
>
> 海力士
> 8G 1R8  24/26/32（AFR/JJR、DJR）
> 8G 1R8  26/32  CJR
> 16G 2R8 （价格*2）
>
> 16G 1R8   32（AJR）
> 16G 1R8   32（CJR）
> 32G 2R8 （价格*2）

Follow-up answers, from the question dialog:

> Chip # for Samsung / SK Hynix: 3-letter die code.
> Kingston and Other-brand RAM: Yes, short code from chip #.
> Prod chip # write: Report only, no write.

## Context

A read-only audit on 2026-11-02 checked all 2,206 DDR4 order lines in prod against the reference above. Its report and per-line CSV are at
`http://10.10.100.225:8800/ddr4-chip-audit.html` and `…/ddr4-chip-audit.csv`. The audit found:

- 1,200 Samsung/Hynix lines with no chip #;
- 238 chip # values in long or prefixed spellings;
- 151 placeholders (`NA`, `OTHER`, `SHELL`, `1`…);
- 45 lines where the chip #, part # and size disagree.

The owner chose to keep that as a report and fix the data by hand.

The code change is for the short code. Since v1.347.0, `ramShortCode()` reads only Samsung and SK Hynix part numbers and the Micron brand's chip. 146 DDR4 lots from third-party module makers (Kingston, Other, ADATA) carry a readable Samsung, Hynix or Micron die in Chip #, for example `MICRON-0ZE75D9WFL`, `SK-H5ANAG8NCJRXNC240VS`, `8DE75D9VPP` or `CB1`. They show *Not recorded* anyway, and they fall out of the vendor bid sheet's short-code grouping.

## Acceptance criteria

- [x] For a brand other than Samsung, SK Hynix or Micron, `ramShortCode()` returns the die read from Chip #:
  - a Micron FBGA code at the end (`8DE75D9VPP`, `MICRON-0ZE75D9WFL`, `4GF75 D8CJV`);
  - a Hynix `H5AN` marking with a full three-letter die (`H5AN8G8NAFR-UHC` → AFR, `SK-H5ANAG8NCJRXNC240VS` → CJR);
  - a bare code, optionally behind a maker word (`CB1`, `SAMSUNG CB1`, `SK CJR`, `SK-CJR`).
- [x] Placeholders and Samsung `K4A…` markings stay *Not recorded*: `NA`, `OTHER`, `SHELL`, `1`, `KINGSTON`, `K4A8G085WC-BCTD`.
- [x] Samsung, SK Hynix and Micron brands behave exactly as before.
- [x] Inventory, Quick View, the sell-order builder, exports and the vendor bid sheet show the new codes through `ramShortCode()`. Two Kingston lots with the same spec and die share one bid row.

## Out of scope

- Rewriting any `chip_number` in prod. The owner chose report only.
- Truncated Hynix markings such as `H5ANAG8NCJ`, which lack the package letter. Adding the R would be a guess.
- Samsung or Hynix brand lines with an unreadable part #. They keep the part # rule.
- Samsung `K4A` markings: they give the die revision, not BB1 versus CB1.

## Notes

- Die densities were checked with a deep-research run (102 agents, 3-vote verification). It confirmed VPP and WFL (8Gb x8), CJR at both 8Gb and 16Gb, AJR (16Gb x8), and DJR and JJR (8Gb). No reference row was proven wrong. ZFW is 16Gb x16, not an x8 code.
