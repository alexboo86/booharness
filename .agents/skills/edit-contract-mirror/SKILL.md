---
name: edit-contract-mirror
description: Use when editing the project contract — any change to CLAUDE.md or AGENTS.md (a PRIME directive, a rule, a routing-kernel line, a Rule map row). Keeps the two byte-identical and commits safely.
lead_only: true
---

# Edit Contract (CLAUDE.md + AGENTS.md byte-mirror)

## When to use
Any edit to the root contract: adding/changing a rule, a PRIME invariant, a routing-kernel line, or a
Rule map row. CLAUDE.md (Claude Code) and AGENTS.md (Codex/GPT) MUST stay byte-identical mirrors.

NOT for: editing docs/agent/* refs alone (those are single files, no mirror), or non-contract code.

## Steps
1. Apply the SAME edit to BOTH files with the identical old_string→new_string. (Read AGENTS.md first if you
   haven't this session — the Edit tool requires a prior read.)
2. **Verify byte-identical (hard gate):** `diff CLAUDE.md AGENTS.md` → must print NOTHING. If it differs,
   fix until empty before committing.
3. Stage explicit pathspec only: `git add -- CLAUDE.md AGENTS.md` (+ any `docs/agent/<ref>.md` you touched).
4. Commit explicit pathspec: `git commit -m "docs(contract): <what>" -- CLAUDE.md AGENTS.md [refs]`
   (bare commit / `git add -A|.|-u` is blocked by git-commit-guard — always pathspec).
5. Push — ONLY after the operator says so (PRIME 17), and never as part of the edit:
   `npm run check:push -- --ack <sha>`, then `PUSH_ACK=<sha> git push origin master`.
   Inspect every push URL with `git remote -v`; remote names do not establish trust.
   Every destination requires explicit operator approval and publication acknowledgement.
6. Keep the always-on PRIME block tiny (~10-12 hard invariants); push detail into `docs/agent/*` and link it
   from the Rule map table, so the contract doesn't bloat (lost-in-the-middle kills recall).

## Verification
- `diff CLAUDE.md AGENTS.md` is empty.
- `git diff --cached --name-only` lists ONLY your intended files (no foreign hunks).
- push reaches only the operator-approved destinations; inspect every push URL.
- Editing a Code intel / Blast radius / RTK line? The orch daemon parses those lines out of
  CLAUDE.md (`codeIntelRules()` / `seatContract()` in `ops/orchestrator/src/context.ts`) and
  fails closed on drift — run both against the edited checkout before committing:
  `node --input-type=module -e "const {seatContract, codeIntelRules} = await import('./ops/orchestrator/src/context.ts'); seatContract(); codeIntelRules(); console.log('contract anchors OK')"`

## Failure modes
- Edited one file, forgot the other → silent contract divergence. The `diff` gate catches it — never skip it.
- "Close enough" non-identical wording → diff non-empty; make them identical.
- Bare commit / mass `git add` in the shared tree → sweeps another session's staged files. Always pathspec.
- Growing the PRIME/always-on block → bloats context, buries core facts. Keep lean, detail goes to refs.
