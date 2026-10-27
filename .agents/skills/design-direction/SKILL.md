---
name: design-direction
description: Pick a visual direction that is not generic before any layout — inventory the real objects, write two or three mood directions, run the competitor-substitution test, and vary hierarchy, layout, density, interaction and expression on inherited tokens. Use this before a design or redesign of an application screen, data view or web page, and whenever the user says design, redesign, дизайн or редизайн. Reach for it when a first drawing looks like a default component library, even if the project's design rules are already satisfied.
---

# Design direction before the first layout

A drawing any other product's logo could sit on is not a direction. The shapes
that keep returning are a purple gradient, a centred hero over three equal
cards, Inter as the only face, glass as the default surface, emoji as icons,
and decoration that encodes nothing. Canon-clean code still looks like that.
This pass runs before layout. It does not implement the screen.

The adopted project's design rules and theme tokens win every conflict,
including against this skill and against impeccable. A dense data screen and a
marketing page do not share a look: same method, different result. A
one-control fix is not a direction; send it to the design rules and
`visual-critique`.

## 1. Read our identity first

Read, and do not draw yet.

1. The adopted project's design rules and its design-token files. Inherit the
   tokens. Do not invent a hex, a rgba, or a one-off size.
2. Any visual-language guidance the project keeps for data views. A chosen
   anatomy is not reopened unless the brief says it is what is being redesigned.
3. `.agents/skills/impeccable/SKILL.md` so the direction has a point of view
   and does not sand the new look back into the old one. Do not copy its
   command list or its sentences. It loses to the project's design rules.

## 2. Subject inventory, before any layout

List the real objects the screen shows, before any region exists. One line
each: what it is, what the operator does with it, what must stay visible
without a click. Only what this screen holds. If it is not on the list, it
does not get a region — no hero, no card grid, no chrome, no decoration. An
empty list means you do not know the screen. Stop and read the data. Do not
invent objects to fill space.

## 3. Two or three directions

Each direction is four or five mood words, one sentence of why this screen
needs that mood, and its references. Two that differ only by accent colour
are one. They must differ on at least two axes from §6.

Keep two reference lists apart. **Mood** — a material, a room, a printed page,
a photograph — says how it should feel. **Feature** — a column, a row, a
control another product already solved — says what must work, and is not a
mood. Mixing them is how "calm, dense, precise" becomes "copy the competitor".
That split is the point of a mood board (NN/G,
https://www.nngroup.com/articles/mood-boards/). A feature reference may keep
a column that works. It may not keep the other product's face.

## 4. Competitor-substitution test

Put a competitor's logo on the result and change nothing else — type, layout,
colour, density. If the logo fits, the result is generic. Name the competitor,
and redo it. A pass that only recolours the logo is a fail.

## 5. Anti-patterns — reject and redo

- A purple gradient used as the identity.
- A centred hero plus three equal cards.
- Inter, or the runtime default, as the only face, with no reason.
- Glassmorphism as the default surface.
- Emoji as icons.
- Decoration with no meaning, and decoration with no data meaning. A mark
  that encodes no value, state, or wayfinding fact comes out.
- Motion on a frequent keyboard action. A hotkey, or anything done a hundred
  times a day, gets zero animation. Data surfaces stay silent. A direction that needs that motion is rejected.
- The default component-library look: equal cards, one accent, no point of view.

## 6. Variants on fixed fixtures and inherited tokens

Same real fixture, same tokens, every variant. Not lorem, and not a zero
standing in for a missing value. Vary one axis at a time.

1. **Hierarchy** — what the eye hits first. It must be what the screen is for.
2. **Layout** — where the listed objects sit. Not a new object.
3. **Density** — how much is in view. Use the project's global
   density setting when it has one, not a local scale.
4. **Interaction** — what a click, a key, or a hover does. No motion on the
   actions §5 already vetoes.
5. **Expression** — material, type, and the one place identity shows. Still
   inside the token set.

A variant that needs a new hex, a new font file, or a token the theme lacks
is rejected.

## 7. Critique loop

Capture before and after. Read the images yourself, with
`.agents/skills/visual-critique/SKILL.md`. Not from JSX, and not from a
description of the picture. Capture the
project's documented runtime, never a substitute for it, at the widths the
change touches, light and dark if it has both.

Then run the project's design checks when it has them; the captures prove the
result. A failure rejects the direction.
A direction that works in only one theme is not chosen.

## 8. Output

Stop when these four are written. Do not implement in this pass unless the
brief already asked for the edit.

- Directions: mood words, rationale, the two reference lists kept apart.
- The chosen one, why the others lost, and the substitution result.
- Before and after captures, read, each defect named on the image.
- The design check results, command and exit, not a recollection.
