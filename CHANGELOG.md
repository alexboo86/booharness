# Changelog

[Русский](CHANGELOG.ru.md)

Each publication of BooHarness to this repository adds an entry here, newest first.

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
