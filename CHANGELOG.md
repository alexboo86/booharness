# Changelog

[Русский](CHANGELOG.ru.md)

Each publication of BooHarness to this repository adds an entry here, newest first.

## 0.2.0 — 2026-10-29

- The new motion role makes video and motion assets with Higgsfield and ffmpeg-full. It runs on this Mac only and writes only landing media and motion drafts. The kit ships its Higgsfield credit-boundary wrapper and test.
- Remote seats seed their code index from the host clone's existing index instead of rebuilding it from scratch.
- Local Node launches survive a Homebrew upgrade instead of keeping a removed Cellar path.
- The update-tools memory report is recorded per machine, so one machine's report does not replace another's. When the stored report was already replaced, the updater follows it to the live entry and writes again; before this, the Windows daily run failed every time. A provider CLI that a machine never had shows as absent, not missing.
- The lesson gate reuses an unchanged lesson's score instead of scoring it again.
- Reviewer placement inherits both author and coauthor files.
- The 5% budget floor no longer steps aside a calibrated family at or behind pace. The per-turn veto still applies.

## 0.1.0 — 2026-10-29

First versioned release. The package version is this number. Publishing a changed kit refuses a version whose tag already exists. A push tags that version and opens a release whose notes are this entry, with a link to the Russian changelog.

The public repository now ships a code of conduct (Contributor Covenant 2.1), a contributing guide, a security policy, issue forms and a pull request template. The tree is a generated build and is replaced on each publication, so a pull request is a proposal: the maintainer ports an accepted change into the source and closes the proposal with a link to the release. Security and conduct reports go privately through the Security tab, **Report a vulnerability**. The supported version is the latest release.

Since the previous publication:

- Placement keeps a reserve on the machine that already runs the leads. A request for that machine includes a reason.
- Closing a seat stops processes in its worktree. An aged resume finishes a gitless leftover without losing bytes.
- A remote reviewer's close note names when the remote close began. A reviewer that cites the same lines as a sibling is flagged.
- A glm coder at maximum effort gets a 60-minute turn. An oversized report is graded with every text cut.
- Fetching a host fast-forwards that clone's own master. A worktree sweep keeps a checkout that still has unlanded edits.
- Scout and researcher reports have no support round, and may carry an inventory table outside grading.
- Seat lesson proposals are not applied automatically, and a check a seat already claimed is not run again. A reviewer runs a test only to prove its own finding.
- A new local seat's code index starts from a copy of the nearest existing index instead of a full build.
- The board reads the Bright Data balance every minute instead of every ten. After a Jev balance entry, today's spend and the daily rate still count the spend before the entry.
- On Linux, `node ops/update-tools.mjs --install-schedule` adds one daily line to the user crontab and keeps the other lines. The tool report recovers when its memory entry already exists.
- README and INSTALL describe the current placement, review, reports and commit gate.

## 2026-10-27, fifth publication

Three fixes from a user report.

- orch seats no longer fail at start with `CLAUDE.md: missing product bullet **Modules (task 2409):**`. The kit's CLAUDE.md template now has the Modules bullet that the seat contract reads, and the kit build fails when orch cannot read the seat contract or the code-intel rules from the CLAUDE.md it ships.
- Claude worker seats start without Claude Code mods. Before, a mod from `CLAUDE_CODE_PLUGIN_DIRS` (the handover mod) put its MCP server into the worker, and the MCP init check stopped the seat with `Claude worker MCP init mismatch`.
- The collision-guard mod ships its `tsconfig.json`, so the mod runtime no longer leaves an untracked file in the checkout.

## 2026-10-27, fourth publication

- orch board: each seat card has a `lessons` badge with the count of lessons delivered to the seat: `N full` (whole text in the brief) and `N on demand` (title only; the seat reads the lesson when it needs it).
- Review protocol: the reviewer also checks the change against the requirement (`requirement gap:`) and against needless scope (`overbuilt:`). A REQUEST_CHANGES verdict names who fixes each blocker: the coder, the lead (a brief or plan gap) or the operator (a requirement change).
- Preparation for a complexity-growth commit gate: install-harness has a new `py-tools` step (`--only py-tools`), and `main.ts check-on <host>` runs that installer on the host after npm. The allowlist names crapper and dryer. The gate and its Python tools (`ops/py-tools`) are not in this kit, so a kit install reports the step as `skipped`.

## 2026-10-27, third publication

- README: the role table lists all twelve seat roles; Tester, Designer, Copywriter, Legal and Security were missing. A note says the kit ships no legal-compliance or product-voice skill.
- This changelog. Publication now refuses a kit change without an entry here.

## 2026-10-27, second publication

- Documentation that cites a file the kit does not ship marks it `not in this kit`; citations of installer overlay sources point at the shipped path.
- Skills and documents no longer send the reader to a UI rules document the kit does not ship.
- INSTALL.md: the family table names kimi k3.1-pro and matches the shipped role matrix.
- orch: glm scouts run glm-5.3-flash at high effort.
- orch: seats on a remote host create files with umask 022, not the host's ssh umask.
- Hook-topology check: the probe clears the marks of the sessions it really uses.

## 2026-10-27, first public release

- orch seat orchestration across eight model families, with the lead chat and the board; memoryctl memory with one writer; the skill set; hooks; agent-led installation through INSTALL-PROMPT.md.
