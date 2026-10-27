---
name: visual-critique
description: Judge a UI surface by its PIXELS, not by its code — take a real screenshot of the running target application and run a fixed pass over it (what the eye lands on first, alignment edges, spacing rhythm, type and colour budget, dead space, repeated facts, placeholder and locale honesty) before any UI change is shown to the operator or called done. Use this whenever you change or review a panel, table, toolbar, chart overlay or tab body; whenever a Paseo seat is handed screenshots; and whenever the operator says a screen looks wrong, unprofessional, cluttered or "a hack job". Use the adopted project's design rules; a framework is not a visual-quality guarantee.
---

# Visual critique by pixels

Use the adopted project's design rules when present. Inspect the actual rendered result when pixels are necessary evidence; source code or a mockup is not a substitute.

## 1. Get the pixels — the running app, real data

Use the target project's documented runtime and representative non-secret data. A web project may use its browser runtime; a native project must use its required native runtime. Do not substitute one for the other.

- The screenshotter role and the lead capture ban were removed on 2026-10-21
  (operator decision #19248, overturning #13911/#13933; orch-team §Screenshots).
  A lead or a seat captures the screen or a window and reads the image itself,
  only when a picture is necessary; a log, test, DOM or accessibility read that
  proves the point comes first. For a pixel critique, use a passive
  `peekaboo window list --pid|--app --json`, then one
  `peekaboo see --window-id <id> --tree --json --path <png>`. No foreground click.
- Ask for every state the change touches: default, filtered, selected row,
  empty, loading, error, a narrow pane and a wide one.

## 2. The pass — in this order, on the image

Write each defect as: where on the screenshot · what the eye sees · which rule.

1. **First glance.** Squint (or downscale to ~400 px wide). Name the three things
   the eye lands on first. They must be what the screen is FOR (for a screener:
   the ranking and the outliers; for a calendar: the next release and the
   surprise; for news: the newest important item). A decorative element, an
   empty card or a huge bar winning the first glance is a defect.
2. **Edges.** Count the distinct left edges of text in the panel. Every column,
   label and group header sits on a shared vertical; numbers are right-aligned
   on their decimal; a group header starts at its group's left edge. A centred
   group header over columns of unequal width is a defect.
3. **Rhythm.** Gaps and row heights are multiples of 4 px and repeat. Measure
   three gaps that should be equal; unequal is a defect. Row heights in one
   table are equal.
4. **Type budget.** In one panel at most three sizes and two weights. Uppercase
   micro text is for section labels only. A header that wraps to two lines is a
   defect unless every header wraps.
5. **Colour budget.** List every hue used as a signal and write what each MEANS.
   A coloured number whose meaning is not written in a legend or tooltip is a
   defect; a legend that contradicts the marks is a defect; green/red must never
   be the only carrier of a meaning (add sign, arrow or word).
6. **Space.** A region with no content wider than a third of the panel, a column
   three times wider than its widest value, or text wrapping beside empty space
   is a defect — the width belongs to the column that needs it.
7. **Repetition.** The same fact twice on one screen (a KPI card and a bar that
   say the same number), or the same value in every row of a column (a date,
   "live"), is a defect: move it to the header or drop it.
8. **Honesty.** One placeholder for a missing value (`—`); `0` only for a real
   zero; stale data looks stale; every number carries its unit and window; a
   count that cannot be computed yet is not `0`.
9. **Locale.** Follow the adopted project's locale, date/time, numeric and unit conventions; do not impose another project's language or design document.
10. **States.** The empty, loading and error states of this surface exist and
    look designed, not like a crash.

## 3. Report and stop

- Put the numbered defects first, each with its screenshot crop or coordinates;
  then what already reads well (so a fix does not destroy it).
- Compare against the approved prototype or reference when one exists, side by
  side at the same width; a difference is either a defect or a stated decision.
- A visual claim is not done until the operator has seen the screenshot
  (project contract, operator contract rule 3).
