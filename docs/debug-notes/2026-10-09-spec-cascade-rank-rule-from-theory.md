# The spec cascade hid 2Rx4 on desktop memory: a rule written from theory

**Symptom.** On a PO line with Type = Desktop and Class = UDIMM, the Rank
select offered only 1Rx8, 1Rx16, 1Rx32, 2Rx8, 2Rx16 and 2Rx32. A purchaser
holding a 2Rx4 desktop module couldn't record it:

- the select hid the rank;
- a label scan that read the rank had it cleared;
- the API refused it with "2Rx4 is a server rank and doesn't fit UDIMM".

## Root cause

RS-210 (v1.233.0) added `rankIsServerOnly()` to `shared/specCascade.ts`.
Its comment gave the reason: "An unbuffered bus can't drive x4 chips or more
than two ranks". That is a statement about JEDEC's current raw cards, not
about what was sold. The rule marked every x4 rank, every rank count of four
or more, dual-die and 3DS as server-only. It then applied that one list to
UDIMM, SODIMM, CAMM, Desktop and Laptop alike.

Neither of the two sources the rule was checked against could catch this:

- **The theory** says x4 needs a register, but DDR3 "AMD only" high-density
  desktop modules were sold as 2Rx4 (8 GB and 16 GB, PC3-10600/12800). DDR5
  also has 4-rank unbuffered modules: CUDIMM 4Rx8, now named CQDIMM.
- **The prod rows** were read as "conflicts to tolerate", not as evidence,
  which was right, because they can't be trusted either way. Many are
  label-scan misreads:
  - Kingston `KCP432SS8/16`'s label reads "16GB 1Rx8 2G x 64-Bit", and the
    "x 64" invites an x4 read.
  - Samsung `M393…` and Micron `MTA18ASF…PZ` RDIMMs were filed as UDIMM /
    Desktop.

  So prod's "Laptop + 2Rx4" lines don't prove that laptop 2Rx4 exists, and
  its "Desktop + 2Rx4" lines don't prove that desktop 2Rx4 exists.

## Fix (v1.237.0, RS-217)

Rank now asks one question: which module does it need? The answer comes from
the public record for DDR3–DDR5.

| Rank | Needs | Evidence |
|---|---|---|
| 1–2 ranks of x8 / x16 / x32 | any module | common |
| 1Rx4, 2Rx4; 4Rx8, 4Rx16 | full-size DIMM (UDIMM / Desktop) | DDR3 "AMD only" 2Rx4 UDIMMs; DDR5 CQDIMM 4Rx8 |
| 4Rx4, 8R, dual-die `D`, 3DS `S` | registered / load-reduced | only RDIMM/LRDIMM part numbers, e.g. Samsung M386A8K40BM1 4DRx4, Hynix HMABAGL7M4R4N 2S4Rx4 |

SODIMM, CAMM and Laptop take only the first row. No x4 or quad-rank
SODIMM/CAMM was found in any generation, and JEDEC's DDR4/DDR5 SODIMM raw
cards are x8/x16 only. A line is judged by the stricter of its Class and its
Type.

## Don't repeat it

- **A cascade rule may refuse a pairing only when the public record shows no
  part with it.** Cite a part number, or a JEDEC raw-card table, for each
  generation the rule covers. "The bus can't do it" is a hypothesis.
- **Combinations that are rare or simply not found stay allowed.** Examples
  are x16 RDIMM, x32 ranks and DDR5 LRDIMM. Refusing them blocks a purchaser
  holding the part, and a wrong allow costs one fixable spec.
- **Prod rows are scanner output, not ground truth.** Use them to size a
  change ("how many saved lines would this rule now refuse?"), never to decide
  whether a pairing exists.
- **Loosening a rule removes the only automatic catch it gave for a misread.**
  Here that is an RDIMM filed as UDIMM with 2Rx4. Say so in the ticket, and
  catch misreads with a part-number check instead of an over-tight rule.
