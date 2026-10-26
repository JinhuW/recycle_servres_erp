# 2026-10-26 — candidate 2: bulk Samsung, SK Hynix and Micron RAM only

The owner narrowed the target (RS-404): "We are only target bulk rams
(Samsung, SK, Micron) brand." SSDs are out. The live prompt was also sending
far more noise than leads. This entry rebuilds the prompt around what the
inventory buys, and measures it offline before it replaces live.

## Why the live prompt was noisy

- **Version 66** (`gpt-4o-mini`) is `eval_prompt` with the "Reddit Buyer"
  rule appended. The baseline found the two disagree, and they still do. SSDs
  in any quantity qualify, so single 990 Pros and MX500s alert.
- **Of the 102 alerts Oct 19–26, about 30 were bulk RAM.** The rest were SSDs
  (mostly 1–6 of them), HDD lots, whole servers and desktops, firewalls, and one
  `[W]` buyer. Some alerts went out with an empty summary, because the rule
  says "if the post does not qualify, return only `NO_ALERT`".
- **Reactions can't decide this.** No alert got a positive reaction in those 8
  days, so the candidate-1 trial (version 68) never reached a verdict.

## What the inventory buys

These figures cover every RAM PO line, read from the ERP dev database, a
scrubbed copy of prod.

| | |
| --- | --- |
| Samsung / SK Hynix / Micron share of RAM spend | 92% ($443k / $319k / $156k); Kingston 3.6% |
| By class | server RDIMM $424k, LRDIMM $245k, laptop SODIMM $126k, desktop UDIMM $35k |
| Spend in POs of 50+ modules | 87%; POs of 1–6 modules total $3k |
| DDR3 | about $7 a module, under 1% of spend |
| Reddit-sourced POs | 9, all DDR4/DDR5 modules from the three makers, 7 to 100+ modules each |

That sets the spec:

- **The three makers only.** Server memory with no maker named also counts,
  and so does memory under a server OEM's label (HPE, Dell, Lenovo…), because
  the three build almost all of it.
- **Laptop and desktop modules count** when the maker is named. Owner
  decision: the inventory buys DDR5 16GB SODIMMs in quantity.
- **A post qualifies with at least 7 DDR4 or DDR5 modules of 16GB or more**
  (total A), **or at least 20 target modules of any size** (total B).
  - A keeps the old 7-unit bar for modules worth $35–800 each.
  - B lets in large lots of 8GB modules or DDR3 server memory, which the
    inventory does buy, but keeps 7 × 8GB (about $90) out.
  - Modules under 8GB, and DDR3 that isn't server memory, never count.

## Method

- **Posts.** From prod, every post judged in the 14 days to 2026-10-26 that
  mentions memory (`RAM|DIMM|DDR|ECC|memory|PC[345]-|Hynix|Micron|Samsung|Crucial`),
  plus every post live or candidate 1 flagged. That is **1,503 posts**, with
  229 live alerts and 42 candidate-1 flags.
- **Recall set.** 16 large-lot posts from Sep 15 – Oct 22. One is the post
  behind PO-1454 (86 × Samsung/SK Hynix DDR4, $4,500); one is a `[PC]` price
  check that must be rejected.
- **Runs.** Each post went through the shipped `evaluatePost` and
  `buildUserMessage`, so the request was exactly what the fleet sends, at
  temperature 0 with the reasoning-first schema. Two models were run:
  `openai/gpt-4o-mini` (live) and `openai/gpt-6-luna-pro` (candidate 1's).
- **Labels.** Every post either model flagged, and every RAM-titled post that
  live or candidate 1 flagged and candidate 2 rejected, was read by hand
  against the spec above.

## Result

| Configuration | Alerts / 14 days | Per day | Meet the spec | Precision |
| --- | --- | --- | --- | --- |
| Live, version 66 (`gpt-4o-mini`) | 229 | 16.4 | ~30 of the 102 read (Oct 19–26) | ~30% |
| Candidate 2 draft, `gpt-4o-mini` | 49 | 3.5 | 41 | 84% |
| Candidate 2 draft, `gpt-6-luna-pro` | 54 | 3.9 | 53 | 98% |
| **Candidate 2 final, `gpt-6-luna-pro`** | **54** | **3.9** | **54** | **100%** |

- **`gpt-4o-mini` can't follow the reject list.**
  - It flagged four `[PC]` price checks, one advice question, one
    "[H] PayPal [W] … RDIMMs" buyer, and one 6 × 8GB lot it miscounted as A.
  - It also missed real lots luna found, such as 8 × Samsung 16GB RDIMM,
    12 × Samsung 32GB LRDIMM, and 12 + 12 Samsung/Crucial in a mixed post.
  - Luna rejected all seven of mini's false alerts, and gave the right reason
    in every one.
- **Two wording fixes took the draft to the final text.**
  - A pile of DDR3 2–4GB UDIMMs had reached B ≥ 20. It is now out: modules
    under 8GB and non-server DDR3 never count.
  - "16x64GB DDr4" with no maker named was rejected. It now counts, because a
    64GB+ DDR4/DDR5 module is server memory.
  - Nothing else changed between the two runs.
- **Recall.**
  - The final prompt flags 15 of the 16 recall posts, including PO-1454's.
    The one it rejects is the `[PC]`, which is correct.
  - Of live's 229 alerts, it keeps 49. In the 180 it drops, I found no lot
    that meets the spec.
  - It adds 5 lots live missed: 48 × Hynix 16GB DDR3 RDIMM, 28 × DDR4 8–16GB
    server DIMMs, 8 × Samsung 32GB RDIMM, 8 × SK Hynix 16GB, and 9 × SK Hynix
    32GB LRDIMM.
- **It flags no drive-only post**, no whole machine, and no `[W]` or `[PC]`
  post. None of its 54 summaries is empty or starts with `ALERT`.
- **What remains is volume, not noise.**
  - Three alerts meet the spec but are low value: 20 × DDR3 8GB ECC,
    23 laptop SODIMMs (mostly 8GB), and 28 × DDR4 8GB server DIMMs.
  - Five listings were cross-posted, so they alert twice. That is the
    known dedup gap, out of scope here.

## Decision

Promote candidate 2 on `openai/gpt-6-luna-pro`. Promoting:

- sets `eval_prompt` and `llm_model`;
- clears the candidate;
- disables the "Reddit Buyer" rule, because the prompt is judged as written.

Version 66 stays in `prompt_versions`. The rollback is the old text, the old
model and rule 1 re-enabled.

## Reproducing

The scripts are not in the repo, because they call paid APIs. To re-run:

1. Export the posts with the keyword filter above, plus `is_target` and the
   candidate-1 verdict (`candidate_verdicts`, `prompt_version_id = 68`).
2. For each post, call `evaluatePost` from `src/llm.ts` with the prompt below,
   on each model.
3. Read every flagged post and every disagreement against the spec.

The whole run is about 3,100 calls and costs under $3.

## Candidate 2 (final text)

```text
You are a purchasing agent for Recycle Servers LLC, a buyer of used computer memory. Decide whether a Reddit post is an active for-sale listing of a bulk quantity of RAM modules made by Samsung, SK Hynix or Micron. We buy nothing else.

Target modules — count only these:
- Made by Samsung, SK Hynix (Hynix) or Micron (including Micron's Crucial brand, except Crucial Pro and Ballistix kits). The maker may be given by name or by part number: Samsung M393/M386/M391/M321/M378/M471/M425; SK Hynix HMA/HMAA/HMT/HMCG/HMCT; Micron MTA/MTC.
- DDR4 or DDR5 RDIMM, LRDIMM, ECC UDIMM, plain UDIMM, SO-DIMM or CAMM, and DDR3 RDIMM or LRDIMM. DDR3 UDIMMs and SO-DIMMs never count, and neither does any module smaller than 8GB.
- Server memory (ECC, registered, RDIMM, LRDIMM, PC4-xxxxR/L, or pulled from a server) also counts when no maker is named, or when it carries a server OEM's label (HPE, Dell, Lenovo, IBM, Cisco, Supermicro), because those are built by the three makers. A DDR4 or DDR5 module of 64GB or more is server memory even when the post does not say so. Laptop and desktop modules count only when the maker is named or given by part number.

Never count these (they neither qualify nor disqualify a post):
- Memory from any other maker: Kingston (including Fury and HyperX), Corsair, G.Skill, TeamGroup, Patriot, ADATA/XPG, PNY, OWC, Timetec, Nemix, A-Tech, Nanya, Smart Modular, Netlist and similar, and any gaming, RGB, heatsink, XMP or EXPO kit, whoever made it.
- Every SSD, HDD and other drive, CPUs, GPUs, motherboards, NICs, switches, firewalls, cases, PSUs, laptops, phones and peripherals.
- Memory still installed in a server, PC or laptop that is sold as a whole machine. It counts only when the post offers the modules separately (a part-out or "RAM sold separately") and states their type and quantity.

Reject the post, whatever it contains, when:
- the author is buying, not selling: on swap subreddits [H] is what they have and [W] what they want, so "[H] PayPal [W] RAM" and "[W] 32GB RDIMM" are buyers;
- the author only wants to trade;
- it asks for advice, help, identification or a price check ([PC]);
- it is a discussion, build log, review, news or meme;
- every target module is marked sold, pending or no longer available.

Count before you decide:
1. List each target module line still available, with its maker, generation, type, capacity and quantity. Count physical modules: a 4x32GB kit is 4, and "768GB (12x64GB)" is 12. Leave out sold lines and everything in the never-count list.
2. Work out two totals:
   A = target DDR4 or DDR5 modules of 16GB or larger;
   B = all target modules, of any generation or capacity.
3. is_target is true only for an active for-sale listing where A is 7 or more, or B is 20 or more. With no exact quantity, treat it as bulk only when the post plainly describes a bulk, wholesale, pallet, liquidation or large lot of target memory. Anything smaller is false, however good the price.

Fields:
- reasoning: the target lines you counted, A, B and the verdict, in one or two sentences.
- summary: for a target, one or two sentences a buyer can act on: maker, generation, type, capacity, speed and quantity per line, condition, asking price, location and shipping, only as stated. Never start it with a label such as ALERT. For anything else, one short sentence on why it was rejected.
- price: the asking price exactly as written, or null.
```
