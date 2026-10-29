---
name: motion-media
description: 'Motion seat default for landing videos: approve the storyboard and credit ceiling, capture real terminal behaviour, render offscreen, edit locally, and inspect a contact sheet before delivery.'
---

# Motion media

This is the `motion` video editor's default workflow (operator decisions #21078,
#21079 and #21082). The project contract and this workflow outrank external
skills. Route mechanical editing to [ffmpeg-skill](../ffmpeg-skill/SKILL.md);
it does not choose the scenario, authorise spending, or approve delivery.
Role-default registration is owned by the skill router, not this document.

## Approve before producing

1. Write a storyboard and shot list first: purpose, audience, duration, aspect,
   frame rate, each shot's source and timing, transitions, on-screen text,
   subtitles, sound, and delivery format. Identify real product captures versus
   generated background material; record the inputs and their rights.
2. Send the scenario and a total generation-credit ceiling to the lead. Wait
   for the lead's explicit approval of both before generation or production.
   Missing approval means stop, not a default budget. A changed scenario or an
   estimate beyond the remaining ceiling goes back to the lead.
3. Use Higgsfield only through `node ops/media/hf.mjs` or the `higgsfield` shim
   that delegates to that wrapper. Run `generate cost` for the exact proposed
   request before `generate create`; record the estimate and cumulative spend
   against the approved ceiling. Never call a raw vendor CLI, HTTP API or MCP
   to bypass the wrapper. If the wrapper is absent or refuses, report that
   blocker; do not substitute another route. Never expose credentials.

## Real inputs, offline rendering

- Product/terminal footage must be real captures of the Tauri desktop terminal.
  Never invent UI, prices, trades, balances or product behaviour with generated
  footage. Browser/Vite preview is not a terminal runtime. Redact private data
  without fabricating replacement values; preserve the original inputs.
- Browser-based motion compositions render **offscreen to a deterministic frame
  sequence**, with explicit resolution, frame rate and timestamps, then encode
  locally. Do not open a window on the operator's screen. Browser composition
  is not permission to simulate terminal UI.
- Stage every approved asset, font, audio file and model locally before rendering.
  **No network fetch at render time**: no remote media URLs, remote playlists,
  web fonts, CDN imports, runtime installs or first-use ASR model downloads.
  Inspect playlists and referenced assets too. If an offline dependency is
  missing, stop and report it. Upstream install hints are not authorisation.
- Every output, including frame sequences, project files, intermediate media,
  logs, subtitle files and contact sheets, belongs only under
  `web/apps/landing/public/media/**` (approved delivery assets) or
  `web/apps/landing/_drafts/motion/**` (working material). Set explicit output
  and temporary paths there; reject paths or symlinks escaping those roots.
  Do not overwrite originals or another job's files. Do not publish or delete
  assets without approval.

## Code-animation briefs

For a composition written as code (Canvas, SVG, GSAP, Three.js, shaders), study
the examples in [awesome-opus5-5-videos](https://github.com/yihui-dev/awesome-opus5-5-videos)
(`data/videos.json`: `category`, `tech_tags`, `prompt`). Take their brief shape
into the storyboard: exact duration, size, frame rate, a hook in the first
second, loop or end card, music, and a deliverables list. Link a prompt; do not
copy prompt texts into this repository. Their "find assets on the internet" and
mock product screens do not apply here: assets are staged and approved first,
product UI is a real capture, and libraries are installed locally, never a CDN.

## Edit and caption locally

Use [ffmpeg-skill](../ffmpeg-skill/SKILL.md) for probe, dry-run planning, cuts,
joins, overlays, captions, audio, encoding and contact sheets. Read its
[provenance](../ffmpeg-skill/PROVENANCE.md) before running bundled scripts.
Use the local Python scripts, never the upstream npm installer or updater.

Text and subtitles require the keg-only Homebrew full build:
`/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg`. Prefix `PATH` for every ffmpeg-skill
script so both FFmpeg and ffprobe resolve to that build:

```bash
PATH="/opt/homebrew/opt/ffmpeg-full/bin:$PATH" python3 .agents/skills/ffmpeg-skill/scripts/probe.py web/apps/landing/_drafts/motion/input.mp4
```

Check that build is present and has the required text/subtitle filters before
encoding; missing filters are a blocker, not permission to use a reduced build.
Use supplied or approved timed text; never invent dialogue. Keep captions within
safe areas and check readability at the final delivery size.

Overlay colours come from the adopted project's design tokens, including
`--text`, `--text-dim`, `--accent` and `--surface`; no invented hardcoded palette.
Resolve the approved theme's computed token values locally into the FFmpeg/ASS
colour format and retain the token-to-value mapping with the draft. The project's
UI rules and checklist govern overlays; do not recolour captured UI.

## Inspect before reporting

Probe the encoded output for duration, dimensions, frame rate, codecs and audio;
compare against the approved shot list. Use ffmpeg-skill's `look.py` to create a
contact sheet covering the beginning, transitions, captions and end, with an
explicit path inside the draft root. **Read that sheet yourself** before reporting;
a successful encode or an unread sheet is not visual verification. Inspect text,
crops, authenticity, colours and transitions; listen to audio/subtitle sync where
present. Fix failures and inspect a fresh sheet. Without image-reading capability,
report the visual check as unverified and ask the lead for a capable seat.

Report the approved scenario, estimated/actual credits, output paths and probe
facts, contact-sheet path and what you saw, remaining warnings and any unverified
checks. Delivery is not a new authorisation to generate, spend or publish.
