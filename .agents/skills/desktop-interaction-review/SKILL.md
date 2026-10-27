---
name: desktop-interaction-review
description: Reviewing a desktop UI for the things a screenshot does not show — keyboard reachability and focus order, contrast and colour-as-only-signal, state that must stay consistent between the chart and the screener, and interaction that must not re-render the chart. Use this when adding or changing any panel, dialog, control, table or chart interaction, when a change touches theme or colour, when two surfaces show the same fact, and before saying a UI change is done. Reach for it even for a "small visual tweak" — the recurring defects in this app are consistency and re-render defects, and both look fine in a still image.
---

# Desktop interaction and accessibility review

This app is a dense, keyboard-heavy, real-time desktop tool. The defects that
matter here are not "the button is ugly". They are: you cannot reach the control
without a mouse, two panels disagree about the same symbol, and touching a
setting re-renders the chart.

Styling rules — tokens, no hardcoded hex/px/rgba, light theme — live in
`docs/ui-canon.md` and its §99 checklist, with `npm run check:ui-canon` and
`npm run check:light-theme` as the sensors. This skill is the *interaction* lens
that those do not cover.

## 1. Keyboard reachability

An interactive application is used with hands on the keyboard. Every interactive element
must be reachable and operable without a mouse.

- **Tab order follows visual order.** A panel that renders out of DOM order and
  is positioned with CSS will tab in the wrong order; that is a real defect, not
  a nicety.
- **Focus is always visible.** Removing the outline without replacing it with a
  token-based focus ring makes keyboard use impossible in a dense grid.
- **Escape closes, Enter confirms**, consistently across every dialog and popover.
  One dialog that does it differently is worse than none doing it.
- **Focus is trapped inside a modal** and **restored to the trigger** on close.
  A modal that drops focus to `body` sends the next Tab to the top of the app.
- **A custom control is not a control** until it has a role, a name, keyboard
  handlers and a disabled state. A `div` with an `onClick` is invisible to the
  keyboard and to every assistive technology.
- **Shortcuts must not fire while typing.** A single-key shortcut that triggers
  inside a symbol search box is how an order gets placed by accident.

## 2. Colour and contrast

- **Colour is never the only signal.** Long/short, up/down, connected/stale,
  alert severity — each needs a shape, an icon, a label or a position in addition
  to the hue. Red/green is exactly the pair a large minority of users cannot
  separate, and this app leans on it everywhere.
- Contrast has to hold **in both themes**. A token that passes in dark and fails
  in light is a half-done change; the light-theme test exists because that
  happened.
- Text over a chart, a heatmap cell or a gradient needs a contrast guarantee that
  does not depend on the data underneath it.
- Never encode meaning in a raw hex. It breaks theming and it breaks the sensor.

## 3. State consistency across surfaces

This is the recurring class in a multi-panel terminal, and it is the one users
report as "the app is lying to me".

Whenever two surfaces show the same fact, name the single source of truth and
check every path that can change it:

- symbol / timeframe selected in the chart vs the screener vs the header
- indicator enabled/disabled vs what is drawn
- position and order state on the chart vs the positions panel
- connection or data-staleness indicator vs what the panel is actually showing
- an alert's state in the list vs its state in the detail view

The failure is almost never the initial render; it is a path that updates one
side. Enumerate the paths — user action, websocket push, backfill completion,
reconnect, tab switch, window restore — and check each.

**Stale is a state and must be shown.** A panel that keeps displaying the last
value with no indication that the feed stopped is the worst outcome in a live-data
UI, because the number still looks live.

## 4. Interaction must not re-render the chart

Project canon: ChartPane and its subcharts are driven through refs and imperative
calls, never through React state. This is a hard rule and it is what keeps the
chart from flickering.

When reviewing an interaction that touches the chart:

- does it set React state that ChartPane's subtree reads? Then it re-renders.
- does a new object/array/function identity get passed down each render?
- is a subscription re-created on every render because its deps are unstable?
- does a resize or a layout change cause a full remount rather than a resize call?

The check is not "it looked fine". It is: interact, and confirm no re-render of
the chart subtree — the flicker is sometimes only visible under load, and the
render count is not.

## 5. Feedback, latency and errors

- Every action gets feedback within ~100 ms, even if the result takes longer.
  A dense grid with no pending state reads as broken.
- A destructive or outward-facing action (cancel order, delete alert, place
  trade) needs confirmation, and the confirmation must name **what** it will do,
  not just ask "are you sure".
- Errors appear where the user is looking, in words about the user's action —
  not a toast in a corner with a stack trace.
- Long operations are cancellable, or say why they are not.

## 6. Density, resizing and restore

- The app is used on multiple monitors and at high density. Check a narrow pane
  and a very wide one; a table that only works at one width is not done.
- Window restore must bring back panel sizes and the selected symbol/timeframe
  coherently — a restore that brings back the layout but resets the symbol is the
  consistency defect in section 3 wearing a different hat.

## Review checklist

- [ ] every new control is tab-reachable, in visual order, with a visible focus ring
- [ ] Escape/Enter behave as everywhere else; modal traps and restores focus
- [ ] custom controls have role, name, keyboard handlers, disabled state
- [ ] no single-key shortcut fires while a text field has focus
- [ ] no meaning carried by colour alone; contrast checked in BOTH themes
- [ ] no hardcoded hex/px/rgba (`npm run check:ui-canon`, `npm run check:light-theme`)
- [ ] every surface showing a shared fact updates on every path that changes it
- [ ] stale/disconnected is shown, not silently kept as the last value
- [ ] the interaction does not re-render the chart subtree
- [ ] pending, error and confirmation states exist and name the action
- [ ] narrow and wide layouts checked; restore is coherent

A visual claim is proven by a capture the lead or a seat reads (the contract's
Screenshots rule) — this checklist tells you what to look at in it, and what a
screenshot alone cannot settle.
