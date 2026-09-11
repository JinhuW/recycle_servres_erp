# A 1px dotted border that paints on every tape row but one

**2026-09-09.** Making the cost tape's editable "Other fees" row wrap under
1100px (`.tape-row { flex-wrap: wrap }`, inputs on a second line) left that
row's dot leader invisible while every other row's leader painted as before.
Layout was fine: `getBoundingClientRect()` gave the `.tape-lead` a 579×1 box
on the label line, `elementFromPoint` returned it, `visibility`/`opacity`
were normal, nothing overlapped it. It just didn't paint.

Half an hour of in-page experiments on the same element, in Chromium
(Playwright headless, DPR 1):

| Style forced on the fee row's `.tape-lead`          | Painted? |
| --- | --- |
| `border-bottom: 1px dotted red`                       | no  |
| `border-bottom: 1px dashed red`                       | yes |
| `border-bottom: 1px solid red`                        | yes |
| `height: 1px; background: red`                        | yes |
| `height: 1px; background: <2px-period radial dots>`   | no  |
| `height: 1px; background: <2px-period linear stripes>`| no  |
| `align-self: center; transform: none` (dotted)        | no  |
| `margin-left: .5px` / `max-width: 501px` (match the row that works) | no |
| Row switched from wrapped flex to a 2-column grid     | no  |

So any 2px-period pattern vanishes on this element and only this element,
whatever the position, width, alignment or container type — while "Goods
total" two rows up, with identical CSS, paints its dots. The one thing that
differs is that the row holds two `<input>`s. No cause was found and the fix
didn't need one.

## What to do instead

Don't fight it. A leader exists to join a label to its figure *on the same
line*; once the inputs sit on the line below there is nothing to join, so the
wrapped row simply drops its leader:

```css
.tape-row:has(.tape-edit .input) > .tape-lead { display: none; }
```

The read-only tape (`.tape-edit` without an `.input`) keeps its leader and
its printed figure on the label line.

## If you meet it again

- A `dashed` border and a solid background both paint; `dotted` and any
  2px-period gradient do not. That is the signature.
- Check whether the box's row contains form controls before blaming
  flex-wrap, sub-pixel offsets or the `-webkit-mask` on `.tape` — all three
  were ruled out here.
- Verify in a real Chrome at DPR 2 before assuming production users see it;
  this was only ever observed in headless Playwright. Even so, the
  "no figure, no leader" rule holds on its own merits.
