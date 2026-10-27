#!/usr/bin/env node
// Pins the hook topology decided 2026-07-31 (harness deep-research run
// 019fba5e-201d-7c80-bb0b-c8de004c1186, operator-approved):
//
//   1. The code-index UserPromptSubmit prompt-hook is RETIRED — the delegate
//      script is gone and no settings file may wire `prompt-hook` again.
//   2. install-harness.mjs REMOVES that wiring instead of installing it.
//   3. RTK guards are WARN-ONLY: no `permissionDecision: "deny"` in
//      codex-rtk-hook.mjs, which serves the runtimes that apply a rewrite
//      (codex; grok since 2026-09-14, when its `updatedInput` support was
//      measured against its own hooks documentation).
//   4. CLAUDE.md and AGENTS.md stay byte-identical mirrors.
//   4a. The TOML runtimes (codex, kimi) carry the session digest hook and
//      `domain-lessons-hook.mjs` whenever their config exists (2026-08-11):
//      the sensor read only JSON settings until then, so a member with no
//      lessons hook at all still produced an all-green report. Since ЗАДАЧА 410
//      the installer APPENDS the sections for kimi and renders a pending block
//      for codex (whose hook trust is interactive), so a red line here names
//      which side of that split the runtime is on.
//   5. The Bash rewriter for claude is the NATIVE `rtk hook claude` (2026-08-06):
//      our own rewriter was deleted after rtk 0.44.1/0.44.2 matched it on every
//      measured command shape, and until this check existed nothing in the tree
//      could tell whether the replacement was installed: a reviewer named that gap.
//
// A failure here means someone reverted an operator decision — fix the
// revert, not this sensor. Exit 1 with every violation listed.

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homeReader } from './home-read-lib.mjs';
import { checkLeadChatWiring } from './lib/check-lead-chat-wiring.mjs';
import { checkKimiHookWiring } from './lib/check-kimi-hook-wiring.mjs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readHarnessConfig } from './lib/harness-config.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.USERPROFILE || process.env.HOME || '';
const harnessConfig = readHarnessConfig({ repoRoot: REPO });
const kimiConfigPath = join(HOME, '.kimi-code', 'config.toml');
const kimiConfigured = existsSync(kimiConfigPath);
// A leftover directory alone does not enable a family. An existing config
// still needs checking even when that family is disabled in the harness.
const checkKimi = harnessConfig.families?.enabled?.includes('kimi') === true || kimiConfigured;

const failures = [];
const ok = [];
const check = (cond, label) => (cond ? ok.push(label) : failures.push(label));

const read = (p) => readFileSync(p, 'utf8');

/// Every check that reads a LIVE MACHINE home, and cannot from where it runs.
///
/// Not a failure and not silence. A Paseo member seat is sandboxed away from the
/// operator's home on purpose, so `~/.claude/settings.json` and its siblings
/// answer EPERM there - and an uncaught EPERM killed this whole sensor mid-run.
/// Measured 2026-08-18 in round `harness-fixes-review-r1`: FOUR of five seats
/// tried to run this script, hit the throw, and wrote the entire live-home
/// audit into their reports as `unverified` by hand. The tool now says it
/// itself, once per check, and the run still ends green when nothing is
/// actually broken - a check nobody could take is not a defect, and calling it
/// one trains every seat to ignore a red line.
///
/// The rule moved to `home-read-lib.mjs` on 2026-08-18, because two more sensors
/// carried the same wall in the other wrong shape: `audit-rule-sensors.mjs` threw
/// EPERM through an `existsSync` guard, and `check-mcp-delivery.mjs` read an
/// unopenable secrets file as an EMPTY one and called the round green. Three
/// copies of one guard is how the third one gets written wrong.
const skipped = [];
const readHome = homeReader(skipped);

/**
 * The TOML runtimes used to be read by `svod hooks-topology`, a strict TOML
 * parser that lived beside the multi-model orchestrator.
 *
 * Three rounds of `harness-delivery-audit` had confirmed the same defect class
 * in three shapes against the hand-rolled line scanner that lived here before
 * that: a `#` comment naming a script turned the sensor green (r2), an escaped
 * `#` inside a basic string truncated the line and reported a wired hook as
 * missing (r3), and a `"""` multiline value put the script name on a line
 * carrying no `command =` so three wired hooks read as none (r4).
 *
 * Svod was removed 2026-09-14 (replaced by Paseo), and with it went the only
 * strict TOML reader this file had. There is no TOML-parsing dependency in
 * this repository to fall back to, and hand-rolling one back into this file is
 * exactly the defect class the svod parser was brought in to retire — so this
 * check now SKIPS rather than silently trusting a line scanner again.
 *
 * debt: strict TOML hook-topology verification has no instrument since the
 * Svod removal; a real TOML parser (own crate or an npm dependency) is needed
 * before this can go back to failing loudly on a drifted kimi config.toml.
 */
function svodHookTopology(_runtime, _configPath) {
  return {
    skip:
      'strict TOML hook-topology verification was retired with Svod (2026-09-14, replaced by ' +
      'Paseo) and has no replacement parser yet — this file cannot tell a wired hook from a ' +
      'missing one in TOML here',
  };
}

// 1. The retired prompt-hook delegate must stay gone, and nothing may wire it.
check(
  !existsSync(join(REPO, 'ops', 'bootstrap', 'code-index-prompt-guard.mjs')),
  'ops/bootstrap/code-index-prompt-guard.mjs must NOT exist (retired 2026-07-31)',
);
const settingsFiles = [
  join(REPO, '.claude', 'settings.json'),
  join(REPO, '.claude', 'settings.local.json'),
  join(HOME, '.claude', 'settings.json'),
  join(HOME, '.glm-worker-config', 'settings.json'),
  join(HOME, '.glm-lead-config', 'settings.json'),
].filter((p) => existsSync(p));
for (const p of settingsFiles) {
  const blob = readHome(p, 'prompt-hook wiring status');
  if (blob === null) continue;
  check(
    !blob.includes('code-index-prompt-guard') && !/\bprompt-hook\b/.test(blob),
    `${p} — prompt-hook wiring status`,
  );
}

// 1a. The claude Bash rewriter is the native one, and it is INSTALLED.
//
// The repo's own rewriter was deleted 2026-08-06 after rtk 0.44.1/0.44.2
// matched it on every measured shape, including the compounds it had been
// written for. Deleting a rewriter without checking that its replacement is
// wired leaves a machine with NO rewriter and a document claiming otherwise -
// the exact gap a reviewer named in the run that judged the deletion. Checked
// only where a claude user layer actually exists: a machine without one is not
// a violation.
// Every home the shared Claude adapter can be pointed at, not just the
// operator's: a GLM member runs the same CLI against `~/.glm-worker-config`,
// so a rewriter wired in one home and missing in another is a member reading
// raw output while the machine looks configured. A reviewer named exactly this
// blind spot in the first version of the check.
for (const home of [
  join(HOME, '.claude'),
  join(HOME, '.glm-worker-config'),
  join(HOME, '.glm-lead-config'),
]) {
  const settingsPath = join(home, 'settings.json');
  if (!existsSync(settingsPath)) continue;
  const settingsText = readHome(settingsPath, 'native rtk hook + code-intel wiring');
  if (settingsText === null) continue;
  const settings = JSON.parse(settingsText);
  const bashHooks = (settings.hooks?.PreToolUse ?? [])
    .filter((group) => String(group.matcher ?? '').split('|').includes('Bash'))
    .flatMap((group) => group.hooks ?? [])
    .map((hook) => String(hook.command ?? ''));
  check(
    bashHooks.some((command) => command.trim().startsWith('rtk hook')),
    `${settingsPath} — native \`rtk hook claude\` must be wired on PreToolUse(Bash) (rtk init -g --hook-only --auto-patch)`,
  );
  check(
    !bashHooks.some((command) => command.includes('claude-rtk-hook')),
    `${settingsPath} — the deleted in-repo rewriter must not be wired any more`,
  );

  // The lessons hook is the OTHER delivery this settings file owes, and until
  // 2026-08-11 nothing checked it anywhere. Measured that day by the glm seat
  // of harness-delivery-audit-r1: `domain-lessons-hook.mjs` was wired into ZERO
  // runtimes while the contract, the domain skills and install-session-hooks
  // all named it as the route by which lessons reach an editing agent. The
  // installer now wires it; this is what keeps it wired.
  // The MATCHER decides whether the hook ever fires, so checking only that the
  // command exists somewhere under PreToolUse accepts a hook wired to Bash -
  // which never sees an edit and delivers nothing. Measured 2026-08-11 by the
  // codex seat of harness-delivery-audit-r2: a settings file with the lessons
  // command inside the Bash group made this sensor exit 0.
  const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'];
  const lessonsOnEdits = (settings.hooks?.PreToolUse ?? []).some((group) => {
    const tools = String(group.matcher ?? '').split('|').map((tool) => tool.trim());
    if (!EDIT_TOOLS.some((tool) => tools.includes(tool))) return false;
    return (group.hooks ?? []).some((hook) =>
      String(hook.command ?? '').includes('domain-lessons-hook.mjs'),
    );
  });
  check(
    lessonsOnEdits,
    `${settingsPath} — domain-lessons-hook.mjs must be wired on PreToolUse for an EDIT tool ` +
      `(${EDIT_TOOLS.join('|')}); a group matching anything else never sees a file being written`,
  );

  // The code-intel ORDER hook, which nothing owned until 2026-08-11.
  //
  // It was hand-wired: no installer wrote it and no sensor missed it. When the
  // operator's home directory was destroyed that morning, the installer rebuilt
  // session-start, rtk and domain-lessons, and this one simply did not come
  // back. The symptom the operator saw was that Svod MEMBERS kept calling
  // the snapshot — their launch wires it in code — while every LEAD had quietly
  // reverted to grep, which is the exact regression the hook was measured to fix
  // (five live sessions, 2026-07-28: 26-41 edits and 7-38 greps each, zero index
  // calls, with the trigger map in their context the whole time).
  //
  // Checked on a READ tool for the same reason the lessons check reads its
  // matcher: wired anywhere else it never sees the read it exists to order.
  const READ_TOOLS = ['Bash', 'Read', 'Grep', 'Glob'];
  const orderOnReads = (settings.hooks?.PreToolUse ?? []).some((group) => {
    const tools = String(group.matcher ?? '').split('|').map((tool) => tool.trim());
    if (!READ_TOOLS.some((tool) => tools.includes(tool))) return false;
    return (group.hooks ?? []).some((hook) =>
      String(hook.command ?? '').includes('code-intel-order-hook.mjs'),
    );
  });
  // Both directions, because the hook is a LEAD discipline and a MEMBER must not
  // carry it. `~/.glm-worker-config` is a Paseo member's home: it reads a snapshot
  // worktree against the RUN's index mirror, so an order rule written for the
  // operator's session becomes a refusal the member fights. Measured within the
  // hour of the hook returning, from a live glm writer's transcript: "the hook
  // blocks `.ts` reads (routing to the index), which is stale here". Members get
  // code intelligence from the launch, not from a hook.
  // The same group must ALSO carry the search MCP tool, and this is the half
  // that was missing. The hook clears the session on any search call, and an MCP
  // call is the only way a Claude-family lead searches — a matcher that does not
  // deliver that call never writes the mark, so a lead that searched first is
  // still refused (the refusal then promised "after one search this session,
  // direct reads are free"; its wording changed 2026-09-24, the mechanism not).
  // Measured 2026-08-12 in two live sessions: a lead ran a search through the
  // MCP, read the answer, and the next Read of the same `.ts` file was denied
  // again with the identical text.
  //
  // The NAME the matcher must carry moves with the tool. It was the retired
  // indexed one until 2026-08-13; a sensor left pinning a dead name would demand
  // a matcher that clears nothing.
  const orderClearsOnIndexCalls = (settings.hooks?.PreToolUse ?? []).some((group) => {
    const matcher = String(group.matcher ?? '');
    if (!/codegraph|ast[_-]?grep/i.test(matcher)) return false;
    return (group.hooks ?? []).some((hook) =>
      String(hook.command ?? '').includes('code-intel-order-hook.mjs'),
    );
  });
  const isMemberHome = home.endsWith('.glm-worker-config');
  if (!isMemberHome) {
    check(
      orderClearsOnIndexCalls,
      `${settingsPath} — the code-intel-order-hook.mjs matcher must also carry the search ` +
        'MCP tool (mcp__codegraph__.*); without it the hook never sees the call that clears ' +
        'the session and denies every source read for the whole session',
    );
  }
  check(
    orderOnReads !== isMemberHome,
    isMemberHome
      ? `${settingsPath} — code-intel-order-hook.mjs must NOT be wired in a MEMBER home; ` +
        'a member reads a snapshot against the run mirror and the order rule only fights it'
      : `${settingsPath} — code-intel-order-hook.mjs must be wired on PreToolUse for a READ tool ` +
        `(${READ_TOOLS.join('|')}); install with ops/bootstrap/install-harness.mjs`,
  );

  // Built-in Agent/Task inherits the parent's Claude model. Same homes as
  // code-intel-order: leads must carry matcher Agent|Task, members must not.
  const SUBAGENT_TOOLS = ['Agent', 'Task'];
  const subagentWired = (settings.hooks?.PreToolUse ?? []).some((group) => {
    const tools = String(group.matcher ?? '').split('|').map((tool) => tool.trim());
    if (!SUBAGENT_TOOLS.every((tool) => tools.includes(tool))) return false;
    return (group.hooks ?? []).some((hook) =>
      String(hook.command ?? '').includes('subagent-route-hook.mjs'),
    );
  });
  const subagentPresent = (settings.hooks?.PreToolUse ?? []).some((group) =>
    (group.hooks ?? []).some((hook) =>
      String(hook.command ?? '').includes('subagent-route-hook.mjs'),
    ),
  );
  check(
    isMemberHome ? !subagentPresent : subagentWired,
    isMemberHome
      ? `${settingsPath} — subagent-route-hook.mjs must NOT be wired in a MEMBER home`
      : `${settingsPath} — subagent-route-hook.mjs must be wired on PreToolUse with matcher Agent|Task; ` +
        'install with ops/bootstrap/install-harness.mjs',
  );
}

// 1b. The TOML runtimes carry their hooks too, and this sensor SEES them.
//
// Until 2026-08-11 every check above read a JSON settings file, so codex and
// kimi - whose hooks live in `config.toml` - were outside the sensor entirely.
// Measured that day by the codex seat of harness-delivery-audit-r1: after the
// home directory was destroyed and rebuilt, `check-hook-topology` reported 20
// green while `~/.codex/config.toml` carried no `domain-lessons-hook.mjs` at
// all. install-harness.mjs KNEW - it classifies that absence as
// `missing_hand_install_required` - but nothing failed, so the lead read a
// clean sensor and a member ran with no automatic per-file domain lessons.
//
// What a red line means here split in two at ЗАДАЧА 410, and the two are
// reported differently below:
//
//   kimi  - the installer APPENDS the missing sections itself (kimi runs what
//           config.toml wires), so a red line means the installer has not been
//           run: `not installed`.
//   codex - persists hook trust by hash of the hook definition and runs an
//           untrusted hook NEVER (docs/agent/harness-allowlist.md), so no
//           script can make the hooks live. The installer renders the exact
//           block to ~/.codex/codex-hooks.pending.toml; a red line WITH that
//           block rendered is `awaiting operator` (merge + `/hooks` trust), a
//           red line WITHOUT it is `not installed` (run the installer).
//
// Both stay red: the hooks genuinely deliver nothing until the wiring exists
// AND, for codex, the trust does. Forgiving the second state would be the
// false green this sensor exists to stop.
//
// A runtime that is not installed on this machine has no config and is not a
// violation - the same rule the claude-layer checks above follow.
// Codex is NOT in this loop any more, and that is the whole correction.
//
// It reads its hooks from `~/.codex/hooks.json` — official documentation, read
// 2026-08-16 — and this sensor kept asking `~/.codex/config.toml`, the file the
// installer stopped writing. A reviewer named it in round `mac-migration-r3`:
// the audit would go GREEN on a machine whose codex hooks are not installed at
// all. Its own check is below, over the file codex actually executes.
for (const [runtime, configPath] of [
  ['kimi', join(HOME, '.kimi-code', 'config.toml')],
]) {
  if (!existsSync(configPath)) continue;
  const { skip } = svodHookTopology(runtime, configPath);
  skipped.push(`${configPath} — ${runtime}: ${skip}`);
}

// 1c. Codex hooks live in the file codex EXECUTES, and that is hooks.json.
//
// Official documentation (learn.chatgpt.com/docs/hooks, read 2026-08-16): codex
// discovers hooks beside its active config layers as `hooks.json` OR as inline
// `[hooks]` tables, and it asks for ONE representation per layer — two in one
// layer are merged with a startup warning. The installer writes the JSON, so the
// TOML is what must NOT be there.
//
// Trust is the other half and cannot be checked from here: codex records trust
// against each hook definition HASH, so a newly written or REPOINTED hook is
// skipped until an operator accepts it in `/hooks`. This sensor answers whether
// the definitions are present; only a codex session can answer whether they run.
// Absence is an ANSWER here, not a reason to say nothing.
//
// The whole section below used to sit inside `if (existsSync(codexHooksPath))`,
// so the one machine state this check exists for - codex configured, its hooks
// never installed - produced ZERO codex lines and a green audit. The TOML-era
// audit did report it, and moving to the file codex executes dropped the
// signal on the way. Five independent seats named it in round
// `mac-migration-r4`.
//
// The gate is the RUNTIME's presence, not the hooks file's: a machine with no
// `~/.codex` at all is a machine without codex, and demanding hooks there would
// be a red line nobody can clear.
const codexHome = join(HOME, ".codex");
const codexHooksPath = join(codexHome, "hooks.json");
const codexConfigPath = join(codexHome, "config.toml");
if (existsSync(codexHome)) {
  check(
    existsSync(codexHooksPath),
    `${codexHooksPath} — codex/hooks-file${existsSync(codexHooksPath) ? "" : ": absent — codex is configured on this machine but its hooks are not installed; run node ops/bootstrap/install-harness.mjs, then accept them in /hooks inside a codex session"}`,
  );
}
if (existsSync(codexHooksPath)) {
  let codexDoc = null;
  let readable = true;
  // Unreadable and UNPARSEABLE are two different answers and always were.
  // A file the operator must fix is a failure; a file this seat may not
  // open is a skip, exactly like every other live-home read in this file.
  // Leaving codex as the ONE runtime still reported red for a permission
  // it cannot have was the inconsistency five seats of round
  // `harness-fixes-review` named, two lines from its own sibling.
  const codexText = readHome(codexHooksPath, 'codex/hooks-json');
  if (codexText === null) {
      readable = false;
  } else {
      try {
        codexDoc = JSON.parse(codexText);
      } catch (error) {
        check(false, `${codexHooksPath} — codex/hooks-json-parse: ${error.message}`);
      }
  }
  // `if (codexDoc)` skipped every wiring check for any FALSY parse - `null`,
  // `false`, `0`, `""` are all valid JSON documents and all report green.
  // Same class as the gate above: a check that goes silent on the state it
  // exists to catch. Measured by two seats of round `mac-migration-r5`.
  if (readable && (typeof codexDoc !== 'object' || codexDoc === null || Array.isArray(codexDoc))) {
    check(
      false,
      `${codexHooksPath} — codex/hooks-json-shape: the file parses but is ${Array.isArray(codexDoc) ? 'an array' : JSON.stringify(codexDoc)}, not an object carrying "hooks"`,
    );
  } else if (codexDoc) {
    const commands = Object.values(codexDoc.hooks ?? {})
      .flat()
      .flatMap((group) => group.hooks ?? [])
      .map((hook) => String(hook.command ?? ""));
    for (const [id, needle] of [
      ["session-digest", "session-start.mjs"],
      ["domain-lessons", "domain-lessons-hook.mjs"],
      ["rtk-routing", "codex-rtk-hook.mjs"],
      ["code-intel-order", "code-intel-order-hook.mjs"],
    ]) {
      check(
        commands.some((command) => command.includes(needle)),
        `${codexHooksPath} — codex/${id}${commands.some((c) => c.includes(needle)) ? "" : ": not wired — run node ops/bootstrap/install-harness.mjs, then accept the hooks in /hooks inside a codex session"}`,
      );
  }
  }
}
// Outside the hooks.json gate on purpose. Two representations in one layer is
// what the documentation asks callers to avoid, and it is also how every hook
// here came to load TWICE - but the state worth catching most is the OTHER one:
// wiring that exists only as `[[hooks.*]]` in a config codex no longer executes,
// with no hooks.json beside it. Gated on that file's existence, this line went
// silent in exactly that case.
if (existsSync(codexConfigPath)) {
  const codexConfigText = readHome(codexConfigPath, 'codex/one-representation-per-layer');
  const tomlHooks = codexConfigText !== null && /\[\[hooks\./.test(codexConfigText);
  const detail = tomlHooks
    ? existsSync(codexHooksPath)
      ? ": config.toml still carries [[hooks.*]] beside hooks.json; codex merges both representations in one layer and warns at startup"
      : ": config.toml carries [[hooks.*]] and there is no hooks.json; this wiring sits in a file codex does not execute"
    : "";
  check(!tomlHooks, `${codexConfigPath} — codex/one-representation-per-layer${detail}`);
}

// 1d. grok executes hooks from its OWN home, and until task 589 this sensor
// said nothing about them at all.
//
// grok reads `$GROK_HOME/hooks/*.json` in the same three-level shape claude
// uses. It ALSO used to read `~/.claude/settings.json` through a compatibility
// cell, and the installer leaned on that: domain-lessons and code-intel-order
// were left out of grok's own file on purpose, to avoid loading each twice.
// That cell is now off by design — `[compat.claude] hooks = false`, part of the
// sealed grok home that keeps a member away from the subject's skill layer — so
// the omission became a gap. Measured 2026-08-18 with `grok inspect --json`:
// the three claude-sourced hooks answered `disabled: true`, leaving a grok LEAD
// with session-start and rtk routing and nothing else.
//
// The MODE ARGUMENT is checked, not just the script name: the hooks that can
// REFUSE decide their output shape from it, and `code-intel-order-hook.mjs`
// spelled `claude` inside grok's own file emits claude's JSON, which grok does
// not read as a denial. That is a hook that looks installed and blocks nothing.
//
// Gated on the runtime's presence, like codex above: a machine without
// `~/.grok` is a machine without grok, not a violation.
const grokHome = process.env.GROK_HOME || join(HOME, '.grok');
const grokHooksPath = join(grokHome, 'hooks', `${harnessConfig.names.prefix}.json`);
if (existsSync(grokHome)) {
  check(
    existsSync(grokHooksPath),
    `${grokHooksPath} — grok/hooks-file${existsSync(grokHooksPath) ? '' : ': absent — grok is configured on this machine but its hooks are not installed; run node ops/bootstrap/install-harness.mjs'}`,
  );
}
if (existsSync(grokHooksPath)) {
  let grokDoc = null;
  try {
    grokDoc = JSON.parse(readHome(grokHooksPath, 'grok hook wiring') ?? 'null');
  } catch (error) {
    check(false, `${grokHooksPath} — grok/hooks-json-parse: ${error.message}`);
  }
  if (grokDoc && typeof grokDoc === 'object' && !Array.isArray(grokDoc)) {
    const commands = Object.values(grokDoc.hooks ?? {})
      .flat()
      .flatMap((group) => group.hooks ?? [])
      .map((hook) => String(hook.command ?? ''));
    for (const [id, needle] of [
      ['session-digest', 'session-start.mjs'],
      ['domain-lessons', 'domain-lessons-hook.mjs'],
      // First-deny / retry-allow is covered by the lessons-hook contract.
      ['lessons-deny', 'domain-lessons-hook.mjs" grok'],
      // The runtime argument is part of the needle: only the grok branch
      // answers in the shape grok reads as a refusal.
      ['code-intel-order', 'code-intel-order-hook.mjs" grok'],
      // The REWRITE hook, back since 2026-09-14 (task 1210). The WARN hook
      // left on 2026-08-19 because "grok applies no updatedInput" — wrong, as
      // it turned out: grok's own hooks documentation applies a PreToolUse
      // updatedInput, and the lead measured this exact script turning grok's
      // `{"toolName":"run_terminal_command","toolInput":{"command":"git
      // status"}}` into `updatedInput {"command":"rtk git status"}`. kimi still
      // cannot rewrite and gets nothing.
      ['rtk-routing', 'codex-rtk-hook.mjs'],
    ]) {
      const wired = commands.some((command) => command.includes(needle));
      const hint = id === 'code-intel-order' || id === 'lessons-deny'
        ? ' (the runtime argument decides the output shape; only the grok branch can refuse)'
        : '';
      check(
        wired,
        `${grokHooksPath} — grok/${id}${wired ? '' : `: not wired for grok — run node ops/bootstrap/install-harness.mjs${hint}`}`,
      );
  }
  }
}

// 2. The installer removes the wiring, it must not reinstall it.
const installer = read(join(REPO, 'ops', 'bootstrap', 'install-harness.mjs'));
check(
  installer.includes('removed_prompt_hook') && !installer.includes('$promptGuardCommand'),
  'install-harness.mjs must strip prompt-hook wiring (removed_prompt_hook), not install it',
);

// 3. RTK guards are warn-only. Two layers: a regex tripwire against an
// accidental revert (tolerant to whitespace around the colon), and a
// BEHAVIORAL probe — feed each guard a heavy command and read what it
// actually answers: exit must be 0 and stdout must not carry a deny, however
// spelled (codex P1, review 019fba82).
const DENY_DECISION = /\b(?:permissionDecision|decision)\s*:\s*['"]deny['"]/;
// The kimi/grok warn hook is REMOVED (2026-08-19), so its tripwires went with
// it. What is pinned instead is that it does not come back: the installer must
// not wire a guard for a runtime that cannot apply a rewrite, because such a
// hook can only comment - and the comment was measured at seven lines in
// nineteen days while one kimi seat ran 78 shell calls against 1 rtk with the
// hook installed and warning throughout.
//
// WIRES it, not NAMES it. The first spelling of this check forbade the string
// outright, and the installer is obliged to carry that exact string in
// `KIMI_RETIRED_HOOKS` — the list it uses to REMOVE the block from an operator's
// `config.toml`, which it can only append to. So the sensor forbade the very code
// that satisfies it, and `npm run check:harness-audit` was red on a clean tree from
// the moment the hook was removed. Measured 2026-08-19 in two worktrees at
// 099c433f9 independently. A permanently red gate is worse than no gate: it
// teaches everyone to walk past the whole audit.
const installerText = read(join(REPO, 'ops', 'bootstrap', 'install-harness.mjs'));
const wiresRetiredGuard = installerText
  .split('\n')
  .filter((line) => line.includes('rtk-guard-hook.mjs'))
  .filter((line) => !line.includes('KIMI_RETIRED_HOOKS'));
check(
  wiresRetiredGuard.length === 0,
  `install-harness.mjs wires rtk-guard-hook.mjs again — a hook that cannot rewrite can only comment, and the comment was measured as worthless; it may be named ONLY in the retirement list${wiresRetiredGuard.length ? `: ${wiresRetiredGuard.join(' | ')}` : ''}`,
);
// The shared RTK script now intentionally denies in kimi mode. The behavioral
// probes below pin codex/grok separately, rather than banning deny in its source.
if (checkKimi) {
  checkKimiHookWiring({ configPath: kimiConfigPath, configured: kimiConfigured, check, readHome });
}

// The ordering hook joined them on 2026-08-21 (operator decision, task 728) and
// LEFT on 2026-09-18 (operator decision, overturning that one). The 2026-08-21
// measurement was real — a denied command is re-issued, so the rule cost a whole
// model turn on a session's first grep — but it measured a refusal pointing at
// tools that did not work: ripgrep was not installed on this machine at all, and
// grok's shell shredded `codegraph explore "<phrase>"`. Both were fixed on 2026-09-18,
// the refusal now names a command the seat can run, and the smoke records
// `grok rg PASS` where the same question used to be answered by reading whole
// files. So this pins the OPPOSITE of what it pinned before: the refusal must be
// there, and losing it silently is the regression.
const orderHook = read(join(REPO, 'ops', 'bootstrap', 'code-intel-order-hook.mjs'));
check(
  DENY_DECISION.test(orderHook),
  'code-intel-order-hook.mjs lost its deny decision (restored 2026-09-18, operator)',
);

// Behavioral probe: the guards run against a synthetic event in a sandboxed
// log file. A guard that reintroduces deny in ANY spelling fails here even
// when the regex above misses it.
const probeEnv = {
  ...process.env,
  RTK_GUARD_LOG: join(tmpdir(), `hook-topology-probe-${process.pid}.jsonl`),
};
const heavyEvent = JSON.stringify({ tool_input: { command: 'git status --porcelain' } });
// grok's event shape, from its own hooks documentation (task 1210): the hook
// must stay fail-open on `toolName`/`toolInput` exactly as on `tool_input`.
const grokShellEvent = JSON.stringify({
  hook_event_name: 'PreToolUse',
  toolName: 'run_terminal_command',
  toolInput: { command: 'git status --porcelain' },
});
// The ordering hook needs an event it actually judges: a lone source read, in a
// session it has never seen. Its own suite covers the grammar - what is probed
// here is only that the answer is not a refusal, however spelled.
const orderProbeSession = `hook-topology-probe-${process.pid}`;
for (const [script, mode, event, label] of [
  ['codex-rtk-hook.mjs', undefined, heavyEvent, 'codex-rtk-hook.mjs'],
  ['codex-rtk-hook.mjs', undefined, grokShellEvent, 'codex-rtk-hook.mjs (grok event shape)'],
]) {
  const args = [join(REPO, 'ops', 'bootstrap', script)];
  if (mode) args.push(mode);
  const probe = spawnSync(process.execPath, args, {
    input: event,
    encoding: 'utf8',
    env: probeEnv,
    timeout: 20000,
  });
  check(
    probe.status === 0 && !/deny/i.test(probe.stdout || ''),
    `${label} denies or crashes on a heavy command (status=${probe.status}, stdout=${(probe.stdout || '').slice(0, 120)})`,
  );
}

// The ordering hook is probed for the OPPOSITE: it must refuse a lone source
// read, in the exit shape its runtime honours, and the refusal must name a
// command that family can actually run. A refusal with no runnable replacement
// is what cost a model turn in August and got it switched off — the reason text
// is half the fix, not decoration.
for (const [mode, wantExit, mustName, label] of [
  ['claude', 0, /codegraph explore/, 'code-intel-order-hook.mjs (claude) refuses a lone source read'],
  ['grok', 2, /codegraph__codegraph_explore/, 'code-intel-order-hook.mjs (grok) refuses with exit 2 and the MCP form'],
]) {
  // Its OWN session id. The hook refuses once per session and then goes quiet —
  // that is what keeps the rule from costing a turn on every call — so two probes
  // sharing one id would have the second judge the MARK instead of the runtime,
  // and read as a silent pass. Same trap the hook's own suite records.
  const session = `${orderProbeSession}-${mode}`;
  // Pids are reused: a mark left by an earlier run with this pid would make the
  // hook go quiet and fail this probe (task 3151: 1532 leftover marks), so the
  // mark of THIS session goes before the probe and after it.
  const mark = join(tmpdir(), 'toolset-code-intel', session);
  rmSync(mark, { force: true });
  const event = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command: 'grep foo svod/src/main.rs' },
    session_id: session,
  });
  const probe = spawnSync(
    process.execPath,
    [join(REPO, 'ops', 'bootstrap', 'code-intel-order-hook.mjs'), mode],
    { input: event, encoding: 'utf8', env: probeEnv, timeout: 20000 },
  );
  rmSync(mark, { force: true });
  const body = probe.stdout || '';
  check(
    probe.status === wantExit && /"permissionDecision":"deny"/.test(body) && mustName.test(body),
    `${label} (status=${probe.status}, want ${wantExit}; stdout=${body.slice(0, 120)})`,
  );
}

if (checkKimi) {
  // `git diff`, not `git log`: git log always runs bare since task 2783 (rtk's log filter caps history silently).
  const kimiRtkProbe = spawnSync(process.execPath, [join(REPO, 'ops', 'bootstrap', 'codex-rtk-hook.mjs'), 'kimi'], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git diff' } }),
    encoding: 'utf8',
    env: probeEnv,
    timeout: 20000,
  });
  let kimiRtkOutput;
  try { kimiRtkOutput = JSON.parse(kimiRtkProbe.stdout || '{}').hookSpecificOutput; } catch { /* reported below */ }
  check(
    kimiRtkProbe.status === 0 && kimiRtkOutput?.permissionDecision === 'deny'
      && kimiRtkOutput.permissionDecisionReason === 'Context economy: heavy output must go through RTK. Re-run this command as:\nrtk git diff',
    'kimi/rtk-deny — a heavy command must return the RTK command in its deny reason',
  );
}

// 3b. What kimi ACCEPTED, not what we wrote.
//
// Every other check in this file reads OUR file and judges our own spelling.
// That is exactly how three kimi hooks stayed dead for a day: kimi 0.35 changed
// the `hooks` section from a table of events to a flat `array(HookDefSchema)`,
// dropped the whole section as invalid, and ran without a single hook — while
// this sensor and the harness audit reported all three as ok, because the
// lines they look for were in the file we wrote. Measured 2026-08-12:
// `kimi doctor` answered `hooks: Invalid input: expected array, received object`.
//
// `kimi doctor` is the runtime's own verdict on its own config, it costs no
// model call, and it is the only thing here that can catch the NEXT schema
// change. A kimi that is not installed is not a failure — the machine simply has
// no kimi to be wrong about.
if (checkKimi) {
  const kimiDoctor = spawnSync(
    process.platform === 'win32' ? 'cmd.exe' : 'kimi',
    process.platform === 'win32' ? ['/d', '/s', '/c', 'kimi', 'doctor'] : ['doctor'],
    { encoding: 'utf8', cwd: tmpdir(), timeout: 60000 },
  );
  const doctorOutput = `${kimiDoctor.stdout || ''}${kimiDoctor.stderr || ''}`;
  if (kimiDoctor.error || /unknown command|not recognized|command not found/i.test(doctorOutput)) {
    console.log('skip: kimi doctor — no kimi on this machine');
  } else {
    // The STATUS is half the verdict, and leaving it out made this probe green on
    // a doctor that never got as far as reading the config. Measured 2026-08-12 by
    // the codex seat of harness-delivery-review-r1: a kimi shim exiting 42 with
    // text matching no pattern below produced `ok: kimi REJECTED its own config`
    // and 12 green checks. A doctor that ran and answered exits 0 — measured the
    // same evening against kimi 0.35.0 on the migrated config.
    const doctorAccepted =
      kimiDoctor.status === 0 &&
      !/ERROR\s+config\.toml|Invalid configuration|Invalid input/i.test(doctorOutput);
    check(
      doctorAccepted,
      // The label reads the same green or red, so a green line does not say
      // "kimi REJECTED its own config" the way it did until 2026-08-13.
      `kimi doctor — the runtime's own verdict on its config (exit ${kimiDoctor.status})${
        doctorAccepted
          ? ''
          : `: our hooks are silently off — ${doctorOutput
              .split(/\r?\n/)
              .filter((line) => /Invalid|ERROR/i.test(line))
              .join(' | ')
              .slice(0, 300)}`
      }`,
    );
  }
}

// 3c. The lead screenshot ban is LIFTED (operator 2026-10-21, decision #19248,
// overturns #13911): the capture guard is deleted and a lead captures the
// screen and reads images itself when a picture is necessary. What is pinned is
// that the ban does not come back as wiring: install-harness.mjs must STRIP the
// entry an older install left behind (the session-budget shape) and never
// install one. "Names it, not wires it" (the rtk-guard lesson above): the
// sweep's ownership proof has to name the script it removes, so a line naming
// the script is a defect only where it wires it - `ensureHook` / `hookCommand`.
const captureWires = installerText
  .split('\n')
  .filter((line) => line.includes('lead-capture-hook.mjs'))
  .filter((line) => /ensureHook|hookCommand/.test(line));
check(
  captureWires.length === 0 &&
    !/ensureHook\([\s\S]{0,400}?'lead-capture-hook\.mjs'/.test(installerText) &&
    installerText.includes('removed_lead_capture') &&
    !existsSync(join(REPO, 'ops', 'bootstrap', 'lead-capture-hook.mjs')),
  'the lead screenshot ban is lifted (decision #19248): install-harness.mjs must strip the retired lead-capture-hook.mjs entry (removed_lead_capture), never wire it, and the hook file must stay gone',
);

await checkLeadChatWiring({ HOME, check, readHome });
// lead-context-hook.mjs shares the defect class (task 2043): the direct probe
// pins the reminder itself, the symlinked probe pins the main-module guard.
// The state dir is a temp one so the probe never writes the operator's real
// lead-reminders.json, and the two probes use separate state dirs because the
// hook reminds once per band per session.
const contextHook = join(REPO, 'ops', 'bootstrap', 'lead-context-hook.mjs');
const contextDir = join(realpathSync(tmpdir()), `lead-context-probe-${process.pid}`);
mkdirSync(contextDir, { recursive: true });
const contextLog = join(contextDir, 'lead.jsonl');
writeFileSync(contextLog, `${JSON.stringify({
  type: 'assistant',
  timestamp: '2026-09-22T20:00:00.000Z',
  sessionId: `lead-context-probe-${process.pid}`,
  cwd: contextDir,
  entrypoint: 'claude-desktop',
  message: { model: 'claude-opus-5-5', usage: { input_tokens: 1, cache_read_input_tokens: 404_899, cache_creation_input_tokens: 100, output_tokens: 7 } },
})}\n`);
const contextEnv = { ...process.env };
delete contextEnv.ORCH_SEAT_ID;
delete contextEnv.SEAT_POLICY_ROLE;
const contextProbe = (hookPath, stateDir) => spawnSync(process.execPath, [hookPath], {
  input: JSON.stringify({ session_id: `lead-context-probe-${process.pid}`, transcript_path: contextLog, hook_event_name: 'PostToolUse' }),
  encoding: 'utf8',
  env: { ...contextEnv, ORCH_STATE_DIR: stateDir },
  timeout: 20000,
});
const contextReminds = (probe) => probe.status === 0 && /"additionalContext"/.test(probe.stdout || '') && /handover limit/.test(probe.stdout || '');
check(
  contextReminds(contextProbe(contextHook, join(contextDir, 'state-direct'))),
  'lead-context-hook.mjs must remind a claude lead past the handover limit',
);
const contextLinkDir = join(realpathSync(tmpdir()), `lead-context-linkdir-${process.pid}`);
rmSync(contextLinkDir, { force: true });
symlinkSync(realpathSync(tmpdir()), contextLinkDir);
const contextLinkHook = join(contextLinkDir, `lead-context-link-${process.pid}.mjs`);
symlinkSync(contextHook, contextLinkHook);
check(
  contextReminds(contextProbe(contextLinkHook, join(contextDir, 'state-link'))),
  'lead-context-hook.mjs must remind a lead past the handover limit when invoked through a symlinked path (task 2043)',
);
rmSync(contextLinkHook, { force: true });
rmSync(contextLinkDir, { force: true });
rmSync(contextDir, { recursive: true, force: true });

// 3d. A native orch seat may not rewrite the shared stash stack (task 1999,
// decision #14007). The installer wires the hook into the claude runtime's
// settings.json only; a glm seat is covered by that same file exactly while
// glm.env (~/.local/state/orch/providers.json) names no other
// CLAUDE_CONFIG_DIR. Like 3c the pin is a run, not a grep: the probes below
// execute the hook itself, including through symlinks, malformed payloads and
// quoted spellings (review 2026-10-08). The live-wiring check at the end is red
// until the operator's next installer run lands the hook — expected right after
// this change, a defect after it — and when the hook IS wired, the wired command
// itself must name an existing script and is fired live.
const stashWires = installerText.split('\n').filter((line) => line.includes('seat-stash-hook.mjs'));
check(
  stashWires.length > 0 && stashWires.every((line) => !/\bcodex\b|\bkimi\b|\bgrok\b/.test(line)),
  'install-harness.mjs must wire seat-stash-hook.mjs for the claude runtime only, not codex, kimi or grok',
);
const stashName = installerText.indexOf('seat-stash-hook.mjs');
check(
  stashName >= 0 && /if \(target\.runtime === 'claude'\) \{\s*seatStash = ensureHook\(\s*settings\.hooks,\s*'PreToolUse',\s*'Bash',\s*'seat-stash-hook\.mjs'/.test(installerText),
  'seat-stash-hook.mjs must sit in the claude-only installer branch',
);
check(
  /ensureHook\(\s*settings\.hooks,\s*'PreToolUse',\s*'Bash',\s*'seat-stash-hook\.mjs'/.test(installerText),
  'seat-stash-hook.mjs must be wired as PreToolUse on Bash',
);
const stashHook = join(REPO, 'ops', 'bootstrap', 'seat-stash-hook.mjs');
const stashSeatEnv = { ...process.env, ORCH_SEAT_ID: 'probe', SEAT_POLICY_ROLE: 'coder' };
const stashLeadEnv = { ...process.env };
delete stashLeadEnv.ORCH_SEAT_ID;
delete stashLeadEnv.SEAT_POLICY_ROLE;
const stashProbe = (command, env, hookPath = stashHook) => spawnSync(process.execPath, [hookPath], {
  input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
  encoding: 'utf8',
  env,
  timeout: 20000,
});
const stashRawProbe = (raw, env, hookPath = stashHook) => spawnSync(process.execPath, [hookPath], {
  input: raw,
  encoding: 'utf8',
  env,
  timeout: 20000,
});
const stashDenied = (probe) => probe.status === 0 && /"permissionDecision":"deny"/.test(probe.stdout || '');
const stashSilent = (probe) => probe.status === 0 && !(probe.stdout || '').trim();
check(
  stashDenied(stashProbe('git stash', stashSeatEnv)),
  'seat-stash-hook.mjs must deny a seat bare git stash',
);
check(
  stashDenied(stashProbe("git stash pop # don't", stashSeatEnv)),
  'seat-stash-hook.mjs must deny `git stash pop # don\'t` — split retries with the comment removed (task 2051)',
);
check(
  stashDenied(stashProbe('rtk git stash pop', stashSeatEnv)),
  'seat-stash-hook.mjs must deny a seat rtk-wrapped git stash pop',
);
check(
  stashDenied(stashProbe('bash -c "git stash pop"', stashSeatEnv)),
  'seat-stash-hook.mjs must deny a seat stash pop wrapped in bash -c',
);
check(
  stashDenied(stashProbe('git -c core.editor=vim stash pop', stashSeatEnv)),
  'seat-stash-hook.mjs must deny a seat stash pop behind a git -c value (review 2026-10-04)',
);
check(
  stashDenied(stashProbe('git sta"sh" pop', stashSeatEnv)),
  'seat-stash-hook.mjs must deny a seat git sta"sh" pop — the guard, not a substring, decides (review 2026-10-08)',
);
check(
  stashDenied(stashProbe('git sta\\sh pop', stashSeatEnv)),
  'seat-stash-hook.mjs must deny a seat git sta\\sh pop — the guard, not a substring, decides (review 2026-10-08)',
);
check(
  stashDenied(stashRawProbe('{not json git stash pop', stashSeatEnv)),
  'seat-stash-hook.mjs must deny a seat Bash payload it cannot parse when its raw text names stash (review 2026-10-08)',
);
check(
  stashSilent(stashRawProbe('{not json', stashSeatEnv)),
  'seat-stash-hook.mjs must stay silent on an unparseable payload that does not name stash',
);
check(
  stashDenied(stashRawProbe('{"tool_name":"Bash","tool_input":"git stash pop"}', stashSeatEnv)),
  'seat-stash-hook.mjs must deny a seat whose tool_input is a plain string naming stash (review 2026-10-08)',
);
check(
  stashSilent(stashRawProbe('{"tool_name":"Read","tool_input":{"file_path":"docs/stash-notes.md"}}', stashSeatEnv)),
  'seat-stash-hook.mjs must not judge a payload naming another tool',
);
// Invoked through a symlinked file or directory the body must still run
// (review 2026-10-08): the hook's main-module guard compares real paths.
const stashLinkDir = join(realpathSync(tmpdir()), `seat-stash-linkdir-${process.pid}`);
rmSync(stashLinkDir, { force: true });
symlinkSync(realpathSync(tmpdir()), stashLinkDir);
const stashLinkHook = join(stashLinkDir, `seat-stash-link-${process.pid}.mjs`);
symlinkSync(stashHook, stashLinkHook);
check(
  stashDenied(stashProbe('git stash pop', stashSeatEnv, stashLinkHook)),
  'seat-stash-hook.mjs must deny a stash pop when invoked through a symlinked path (review 2026-10-08)',
);
rmSync(stashLinkHook, { force: true });
rmSync(stashLinkDir, { force: true });
check(
  stashSilent(stashProbe('git stash list', stashSeatEnv)),
  'seat-stash-hook.mjs must pass a seat git stash list',
);
check(
  stashSilent(stashProbe('git stash show', stashSeatEnv)),
  'seat-stash-hook.mjs must pass a seat git stash show',
);
check(
  stashSilent(stashProbe('git stash pop', stashLeadEnv)),
  'seat-stash-hook.mjs must never deny a lead',
);
check(
  stashSilent(stashProbe('npm run lint', stashSeatEnv)),
  'seat-stash-hook.mjs must pass a seat command that never mentions stash',
);
check(
  stashSilent(stashProbe('', stashSeatEnv)),
  'seat-stash-hook.mjs must stay silent on empty stdin',
);
// Fail closed, pinned by breaking the import on purpose in a temp copy: the
// real hook file is never touched. realpathSync because a symlinked tmpdir
// (macOS /tmp) would defeat the hook's main-module guard.
const stashFailClosedHook = join(realpathSync(tmpdir()), `seat-stash-failclosed-${process.pid}.mjs`);
writeFileSync(stashFailClosedHook, read(stashHook).replace('../orchestrator/src/seat-guard.ts', '/nonexistent-seat-guard.ts'));
check(
  stashDenied(spawnSync(process.execPath, [stashFailClosedHook], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git stash' } }),
    encoding: 'utf8',
    env: stashSeatEnv,
    timeout: 20000,
  })),
  'seat-stash-hook.mjs must deny a seat git stash even when the seat-guard import breaks (fail closed)',
);
check(
  stashDenied(spawnSync(process.execPath, [stashFailClosedHook], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git sta"sh" pop' } }),
    encoding: 'utf8',
    env: stashSeatEnv,
    timeout: 20000,
  })),
  'seat-stash-hook.mjs must deny a quoted stash spelling even when the seat-guard import breaks (review 2026-10-08)',
);
check(
  stashSilent(spawnSync(process.execPath, [stashFailClosedHook], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'npm run lint' } }),
    encoding: 'utf8',
    env: stashSeatEnv,
    timeout: 20000,
  })),
  'a broken seat-guard import must not touch commands without stash after quote and backslash removal',
);
rmSync(stashFailClosedHook, { force: true });
// The coverage claim itself: glm seats read ~/.claude/settings.json only
// while glm.env names no other CLAUDE_CONFIG_DIR.
const orchProvidersPath = join(HOME, '.local', 'state', 'orch', 'providers.json');
if (existsSync(orchProvidersPath)) {
  const providersText = readHome(orchProvidersPath, 'glm seat CLAUDE_CONFIG_DIR coverage');
  if (providersText !== null) {
    let glmEnv = {};
    try { glmEnv = JSON.parse(providersText)?.glm?.env ?? {}; } catch { glmEnv = {} }
    const configDir = typeof glmEnv.CLAUDE_CONFIG_DIR === 'string'
      ? glmEnv.CLAUDE_CONFIG_DIR.replace(/^~(?=[\\/]|$)/, HOME)
      : undefined;
    check(
      configDir === undefined || configDir === join(HOME, '.claude'),
      `${orchProvidersPath} — glm.env names CLAUDE_CONFIG_DIR=${String(glmEnv.CLAUDE_CONFIG_DIR)}; seat-stash-hook.mjs is wired into ~/.claude/settings.json only, so a glm seat with another config dir escapes the stash guard`,
    );
  }
}
// The live wiring. Gated on the claude HOME being present on this machine,
// not on settings.json: a claude home whose settings carry no stash hook is
// the red line (lesson #10952). When wired, the wired command's script must
// exist — a hook pointing at a dead path is not wired — and the wired command
// itself is fired live below.
// The script path of a wired seat-stash command, parsed the way hookCommand
// writes it (ops/bootstrap/install-harness.mjs:937-940): a double-quoted path
// that may contain spaces. The unquoted form is read too, for hand-written
// wiring. hookCommand quotes because paths keep spaces; an extraction that
// stops at the first space red-flagged a correct install (review 2026-10-10).
const wiredStashScript = (command) => (String(command).match(/"([^"]*seat-stash-hook\.mjs)"/) || [])[1]
  ?? (String(command).match(/(?:^|\s)([^\s"]*seat-stash-hook\.mjs)/) || [])[1]
  ?? '';
check(
  wiredStashScript('node "/x/checkout with space/ops/bootstrap/seat-stash-hook.mjs"') === '/x/checkout with space/ops/bootstrap/seat-stash-hook.mjs',
  'the wired-script extraction must keep a quoted path with spaces (review 2026-10-10)',
);
check(
  wiredStashScript('node /x/plain/seat-stash-hook.mjs') === '/x/plain/seat-stash-hook.mjs'
    && wiredStashScript('node "/x/other with space/plain.mjs"') === ''
    && wiredStashScript('echo no script here') === '',
  'the wired-script extraction must read the unquoted form and name nothing when no script is present',
);
const stashSettingsPath = join(HOME, '.claude', 'settings.json');
let wiredStashCommand = '';
if (existsSync(join(HOME, '.claude'))) {
  const stashSettingsText = readHome(stashSettingsPath, 'seat stash hook wiring');
  if (stashSettingsText !== null) {
    let wiredStashCommands = [];
    try {
      wiredStashCommands = (JSON.parse(stashSettingsText)?.hooks?.PreToolUse ?? [])
        .filter((group) => String(group.matcher ?? '').split('|').includes('Bash'))
        .flatMap((group) => group.hooks ?? [])
        .map((hook) => String(hook.command ?? ''))
        .filter((command) => command.includes('seat-stash-hook.mjs'));
    } catch { wiredStashCommands = []; }
    check(
      wiredStashCommands.length > 0,
      `${stashSettingsPath} — seat-stash-hook.mjs must be wired on PreToolUse(Bash); run node ops/bootstrap/install-harness.mjs from the main checkout`,
    );
    const wiredScript = wiredStashCommands.map(wiredStashScript).find(Boolean) ?? '';
    check(
      wiredStashCommands.length === 0 || (wiredScript && existsSync(wiredScript)),
      `${stashSettingsPath} — the wired seat-stash command must name a script that exists (${wiredStashCommands.length === 0 ? 'nothing wired — see the line above' : wiredScript || 'no script path found in the command'})`,
    );
    wiredStashCommand = wiredStashCommands[0] ?? '';
  }
}
if (wiredStashCommand) {
  check(
    stashDenied(spawnSync(wiredStashCommand, {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git stash pop' } }),
      encoding: 'utf8',
      env: stashSeatEnv,
      timeout: 20000,
      shell: true,
    })),
    'the WIRED seat-stash command must deny a seat git stash pop',
  );
}

// 3e. Recursive forced deletion is refused by a HOOK, not a permission rule
// (decisions #14075/#14077): any Bash rule in permissions.deny keeps the
// desktop app's terminal approval card in front of
// mcp__terminal__run_in_terminal, and a rule cannot see that tool at all. Like
// 3c/3d the pin is a run, not a grep: the probes below execute the hook
// itself, through sudo, compounds, the terminal tool name and a symlinked
// path, and the deny reason must name the refused link and the alternative.
const deleteWires = installerText.split('\n').filter((line) => line.includes('shell-delete-hook.mjs'));
check(
  deleteWires.length > 0 && deleteWires.every((line) => !/\bcodex\b|\bkimi\b|\bgrok\b/.test(line)),
  'install-harness.mjs must wire shell-delete-hook.mjs for the claude runtime only, not codex, kimi or grok',
);
check(
  /if \(target\.runtime === 'claude'\) \{\s*shellDelete = ensureHook\(\s*settings\.hooks,\s*'PreToolUse',\s*'Bash\|mcp__terminal__run_in_terminal',\s*'shell-delete-hook\.mjs'/.test(installerText),
  'shell-delete-hook.mjs must sit in the claude-only installer branch, wired as PreToolUse on Bash|mcp__terminal__run_in_terminal',
);
const permissionCanon = JSON.parse(read(join(REPO, 'ops', 'bootstrap', 'permissions.json')));
check(
  !(permissionCanon.deny ?? []).some((entry) => String(entry?.rule ?? '').startsWith('Bash(')),
  'permissions.json must carry no Bash deny rule — a shell rule in deny keeps the terminal approval card; recursive forced deletion is shell-delete-hook.mjs\'s job (decisions #14075/#14077)',
);
const deleteHook = join(REPO, 'ops', 'bootstrap', 'shell-delete-hook.mjs');
// Leads and seats alike: no seat env is scrubbed or set — the hook must judge
// either way, so the probes run with whatever this shell carries.
const deleteProbe = (command, tool = 'Bash', hookPath = deleteHook) => spawnSync(process.execPath, [hookPath], {
  input: JSON.stringify({ tool_name: tool, tool_input: { command } }),
  encoding: 'utf8',
  env: { ...process.env },
  timeout: 20000,
});
const deleteDenied = (probe) => probe.status === 0 && /"permissionDecision":"deny"/.test(probe.stdout || '');
const deleteSilent = (probe) => probe.status === 0 && !(probe.stdout || '').trim();
for (const command of ['rm -rf x', 'rm -fr x', 'cd a && rm -rf b', 'sudo rm -r -f x']) {
  check(
    deleteDenied(deleteProbe(command)),
    `shell-delete-hook.mjs must deny \`${command}\``,
  );
}
// A `#` comment holding an apostrophe leaves a quote split cannot close, even
// inside `sh -c`: split retries once with shell comments removed and the
// guard refuses structurally (reviewer-grok-31fbca.1, reviewer-codex-243386.1,
// task 2051).
check(
  deleteDenied(deleteProbe("rm -rf ./build # don't")),
  'shell-delete-hook.mjs must deny `rm -rf ./build # don\'t` — split strips the comment and the guard refuses (reviewer-grok-31fbca.1)',
);
check(
  deleteDenied(deleteProbe("sh -c \"rm -rf x # don't\"")),
  'shell-delete-hook.mjs must deny `sh -c "rm -rf x # don\'t"` — the comment-stripping retry reaches a -c payload (reviewer-codex-243386.1)',
);
// A backslash-newline continuation runs as rm -rf in the shell.
check(
  deleteDenied(deleteProbe('rm \\\n-rf x')),
  'shell-delete-hook.mjs must deny `rm \\<newline>-rf x` — a line continuation runs as rm -rf (reviewer-grok-31fbca.1)',
);
check(
  deleteSilent(deleteProbe("ls # don't")),
  'shell-delete-hook.mjs must pass `ls # don\'t` — the comment closes no rm judgement',
);
// Deliberate over-refusals (reviewer-codex-243386.1): the terminal tool types
// into an interactive zsh where `#` is an ordinary word unless
// interactivecomments is set, and a heredoc body may feed a shell. These must
// STAY refused.
for (const [command, label] of [
  ['echo hello # ; rm -rf x', 'an interactive zsh runs the rm after the # word'],
  ['rm -r x # -f', 'an interactive zsh passes # and -f to rm as words'],
  ['cat <<EOF\nrm -rf x\nEOF', 'a heredoc body may feed a shell'],
]) {
  check(
    deleteDenied(deleteProbe(command)),
    `shell-delete-hook.mjs deliberately refuses \`${command.replace(/\n/g, '\\n')}\` — ${label} (reviewer-codex-243386.1)`,
  );
}
check(
  deleteDenied(deleteProbe('rm -rf x', 'mcp__terminal__run_in_terminal')),
  'shell-delete-hook.mjs must deny rm -rf through mcp__terminal__run_in_terminal — the tool a permission rule cannot see',
);
for (const command of ['rm x', 'rm -r x', 'echo rm -rf x', 'git rm -rf x']) {
  check(
    deleteSilent(deleteProbe(command)),
    `shell-delete-hook.mjs must pass \`${command}\``,
  );
}
const deleteReasonProbe = deleteProbe('rm -rf x');
check(
  deleteDenied(deleteReasonProbe) && /rm -rf x/.test(deleteReasonProbe.stdout || '') && /without -f, or ask the operator/.test(deleteReasonProbe.stdout || ''),
  'shell-delete-hook.mjs must name the refused link and the alternative in its deny reason',
);
// Invoked through a symlinked file or directory the body must still run: the
// hook's main-module guard compares real paths (lessons #14032/#14033).
// realpathSync because a symlinked tmpdir (macOS /tmp) would defeat the probe.
const deleteLinkDir = join(realpathSync(tmpdir()), `shell-delete-linkdir-${process.pid}`);
rmSync(deleteLinkDir, { force: true });
symlinkSync(realpathSync(tmpdir()), deleteLinkDir);
const deleteLinkHook = join(deleteLinkDir, `shell-delete-link-${process.pid}.mjs`);
symlinkSync(deleteHook, deleteLinkHook);
check(
  deleteDenied(deleteProbe('rm -rf x', 'Bash', deleteLinkHook)),
  'shell-delete-hook.mjs must deny rm -rf when invoked through a symlinked path',
);
rmSync(deleteLinkHook, { force: true });
rmSync(deleteLinkDir, { force: true });
// Fail closed, pinned by breaking the import on purpose in a temp copy: the
// real hook file is never touched (seat-stash precedent, review 2026-10-08).
const deleteFailClosedHook = join(realpathSync(tmpdir()), `shell-delete-failclosed-${process.pid}.mjs`);
writeFileSync(deleteFailClosedHook, read(deleteHook).replace('../orchestrator/src/seat-guard.ts', '/nonexistent-seat-guard.ts'));
check(
  deleteDenied(deleteProbe('rm -rf x', 'Bash', deleteFailClosedHook)),
  'shell-delete-hook.mjs must deny text naming rm even when the seat-guard import breaks (fail closed)',
);
// namesRm joins backslash-newline continuations too: with the import broken,
// `r\<newline>m -rf x` must still be caught (reviewer-codex-243386.1).
check(
  deleteDenied(deleteProbe('r\\\nm -rf x', 'Bash', deleteFailClosedHook)),
  'shell-delete-hook.mjs must deny `r\\<newline>m -rf x` even when the seat-guard import breaks (reviewer-codex-243386.1)',
);
check(
  deleteSilent(deleteProbe('npm run lint', 'Bash', deleteFailClosedHook)),
  'a broken seat-guard import must not touch commands without rm after quote and backslash removal',
);
rmSync(deleteFailClosedHook, { force: true });

// 3f. rtk filter trust adoption (task 2050, landed in 08e9b4fc0): the
// SessionStart hook adopts a desktop session worktree's `.rtk/filters.toml`
// from the main checkout only through the PURE exported rtkFilterTrust — no
// I/O, so its outcomes are pinned here on fixtures, and the wiring is pinned
// from a syntax tree below. Two fixtures exist to kill the mutants the step
// was written against: differing bytes must answer `differs` even when the
// trust list names both files with the right sha, and a source trusted only
// under another sha must answer `source-untrusted` — trust is never invented.
// rtk itself is never run from here: `rtk trust -y` would change this
// machine's trust store, and this sensor is read-only. The hook is imported
// DYNAMICALLY and guarded: a session-start.mjs that no longer parses must
// fail these checks by name, not crash the whole sensor at its own import
// (measured: the static import died on SyntaxError before any check ran).
const startModule = await import('../ops/bootstrap/session-start.mjs').then((m) => m, () => null);
check(
  typeof startModule?.rtkFilterTrust === 'function',
  "ops/bootstrap/session-start.mjs must load and export rtkFilterTrust — a parse error there is this section's red line",
);
const rtkFilterTrust = startModule?.rtkFilterTrust ?? (() => 'rtkFilterTrust-not-loadable');
const trustSha = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const trustList = (files) => files.map((f) => `${f} (trusted 2026-01-01 12:00)\n  sha256:${trustSha}`).join('\n');
const trustArgs = (over = {}) => ({
  sessionRoot: '/wt/seat',
  mainRoot: '/repo/main',
  bothExist: true,
  bytesEqual: true,
  mainSha256: trustSha,
  trustList: '',
  platform: 'linux',
  ...over,
});
check(
  rtkFilterTrust(trustArgs({ sessionRoot: '/repo/main' })) === 'same-checkout',
  'rtkFilterTrust: the session root equal to the main root answers same-checkout, before any file or trust judgement',
);
check(
  rtkFilterTrust(trustArgs({ bothExist: false })) === 'no-file',
  'rtkFilterTrust: a missing filters.toml answers no-file',
);
check(
  rtkFilterTrust(trustArgs({ trustList: trustList(['/wt/seat/.rtk/filters.toml']) })) === 'already-trusted',
  'rtkFilterTrust: the session file itself in the trust list with this sha answers already-trusted',
);
check(
  rtkFilterTrust(trustArgs({ trustList: trustList(['/repo/main/.rtk/filters.toml']) })) === 'trust',
  'rtkFilterTrust: byte-equal to a trusted main copy answers trust',
);
check(
  rtkFilterTrust(trustArgs({ bytesEqual: false })) === 'differs',
  'rtkFilterTrust: differing bytes answer differs',
);
check(
  rtkFilterTrust(trustArgs({})) === 'source-untrusted',
  'rtkFilterTrust: an empty trust list answers source-untrusted',
);
check(
  rtkFilterTrust(trustArgs({
    bytesEqual: false,
    trustList: trustList(['/wt/seat/.rtk/filters.toml', '/repo/main/.rtk/filters.toml']),
  })) === 'differs',
  'rtkFilterTrust: differing bytes answer differs even when the trust list names both files with the right sha — never trust',
);
check(
  rtkFilterTrust(trustArgs({
    trustList: `/repo/main/.rtk/filters.toml (trusted 2026-01-01 12:00)\n  sha256:deadbeef\n`,
  })) === 'source-untrusted',
  'rtkFilterTrust: the main file in the trust list under another sha answers source-untrusted — a pinned old sha is not proof for these bytes',
);
// win32: `rtk trust --list` spells trusted paths with a \\?\ prefix and
// backslashes, so a raw string match never fires and the trust step is
// silently skipped (ported from ops/orchestrator/worktree-setup.json).
check(
  rtkFilterTrust(trustArgs({
    sessionRoot: 'D:\\wt\\seat',
    mainRoot: 'D:\\repo\\main',
    trustList: trustList(['\\\\?\\D:\\repo\\main\\.rtk\\filters.toml']),
    platform: 'win32',
  })) === 'trust',
  'rtkFilterTrust: a win32 trust list line spelled \\?\\-prefixed with backslashes still answers trust',
);
// The same spelling for the SESSION file: the path match must answer
// already-trusted, and the win32 bare-sha fallback (which would fire on the
// very same entry's indented sha line) must not outrank it into a new `trust`
// decision. This is the fixture a dropped win32 normalisation flips — the
// `trust` fixture above is fallback-covered by design.
check(
  rtkFilterTrust(trustArgs({
    sessionRoot: 'D:\\wt\\seat',
    mainRoot: 'D:\\repo\\main',
    trustList: trustList(['\\\\?\\D:\\wt\\seat\\.rtk\\filters.toml']),
    platform: 'win32',
  })) === 'already-trusted',
  'rtkFilterTrust: a win32-trusted session file answers already-trusted — path spelling wins over the bare-sha fallback',
);
// The wiring, pinned from a SYNTAX TREE, not from text. Text pins died
// twice: a lazy [\s\S]*? crossed closing braces (reviewer-codex-8e7902.1),
// and the hand-written brace counter that replaced it extended past the
// guard's real closing brace whenever a comment, string or template held an
// extra brace, while a comment holding the call's own words satisfied a
// substring pin (reviewer-codex-1d05cc.1). So session-start.mjs is parsed
// with the installed typescript (check-ui-canon precedent), the rtk probe
// guard is found as an if NODE, and the pins below require CALL NODES inside
// it. Every failure mode fails red with its own line: a failed typescript
// import, a parse error, a missing or duplicated guard, a call outside it, a
// second `rtk trust -y` anywhere in the file. This sensor executes neither
// rtk command.
const ts = await import('typescript').then((m) => m.default ?? m, () => null);
check(
  ts !== null && typeof ts.createSourceFile === 'function',
  'the typescript package must import for the session-start wiring pin (check-ui-canon precedent)',
);
const startText = read(join(REPO, 'ops', 'bootstrap', 'session-start.mjs'));
const startSf = ts === null
  ? null
  : ts.createSourceFile('session-start.mjs', startText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
check(
  startSf !== null && startSf.parseDiagnostics.length === 0,
  `ops/bootstrap/session-start.mjs must parse for the session-start wiring pin${
    startSf && startSf.parseDiagnostics.length ? `: ${String(startSf.parseDiagnostics[0].messageText).slice(0, 120)}` : ''
  }`,
);
const wiring = { guards: -1, callInside: 0, trustRuns: -1, runInsideGuard: 0, branches: 0, runInsideBranch: 0 };
if (startSf !== null && startSf.parseDiagnostics.length === 0) {
  const find = (root, pred) => {
    const out = [];
    const walk = (node) => {
      if (pred(node)) out.push(node);
      node.forEachChild(walk);
    };
    walk(root);
    return out;
  };
  const isRtkProbeGuard = (n) => ts.isIfStatement(n)
    && ts.isPrefixUnaryExpression(n.expression)
    && n.expression.operator === ts.SyntaxKind.ExclamationToken
    && ts.isCallExpression(n.expression.operand)
    && ts.isPropertyAccessExpression(n.expression.operand.expression)
    && ts.isIdentifier(n.expression.operand.expression.expression)
    && n.expression.operand.expression.expression.text === 'dead'
    && n.expression.operand.expression.name.text === 'includes'
    && ts.isStringLiteral(n.expression.operand.arguments[0])
    && n.expression.operand.arguments[0].text === 'rtk';
  const isTrustRun = (n) => ts.isCallExpression(n)
    && ts.isIdentifier(n.expression) && n.expression.text === 'run'
    && ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text === 'rtk'
    && ts.isArrayLiteralExpression(n.arguments[1])
    && n.arguments[1].elements.length === 2
    && n.arguments[1].elements.every((e) => ts.isStringLiteral(e))
    && n.arguments[1].elements[0].text === 'trust'
    && n.arguments[1].elements[1].text === '-y';
  const isTrustBranch = (n) => ts.isIfStatement(n)
    && ts.isBinaryExpression(n.expression)
    && n.expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
    && ((ts.isIdentifier(n.expression.left) && n.expression.left.text === 'decision'
      && ts.isStringLiteral(n.expression.right) && n.expression.right.text === 'trust')
      || (ts.isStringLiteral(n.expression.left) && n.expression.left.text === 'trust'
        && ts.isIdentifier(n.expression.right) && n.expression.right.text === 'decision'));
  const guards = find(startSf, isRtkProbeGuard);
  wiring.guards = guards.length;
  wiring.trustRuns = find(startSf, isTrustRun).length;
  if (guards.length === 1) {
    const guardBlock = guards[0].thenStatement;
    wiring.callInside = find(guardBlock, (n) => ts.isCallExpression(n)
      && ts.isIdentifier(n.expression) && n.expression.text === 'rtkFilterTrust').length;
    wiring.runInsideGuard = find(guardBlock, isTrustRun).length;
    const branches = find(guardBlock, isTrustBranch);
    wiring.branches = branches.length;
    if (branches.length === 1) wiring.runInsideBranch = find(branches[0].thenStatement, isTrustRun).length;
  }
}
check(
  wiring.guards === 1,
  `session-start.mjs must carry exactly one rtk probe guard (if (!dead.includes('rtk'))) — found ${wiring.guards}`,
);
check(
  wiring.callInside === 1,
  "session-start.mjs must call rtkFilterTrust as a call node inside the rtk probe guard's block — comment or string text is not a call",
);
check(
  wiring.trustRuns === 1,
  `session-start.mjs must carry exactly one run('rtk', ['trust', '-y'], ...) call in the whole file — found ${wiring.trustRuns}`,
);
check(
  wiring.runInsideGuard === 1,
  "session-start.mjs must run rtk trust -y as a call node inside the rtk probe guard's block",
);
check(
  wiring.branches === 1,
  `session-start.mjs must carry exactly one decision === 'trust' branch inside the rtk probe guard — found ${wiring.branches}`,
);
check(
  wiring.runInsideBranch === 1,
  "session-start.mjs must run rtk trust -y inside the decision === 'trust' branch",
);

// Task 2126: pin delivery independently of the hook's subprocess tests.
// Use AST nodes: a comment naming the hook or a call after a Claude guard
// must not satisfy the Claude-only PreToolUse/EnterWorktree contract.
const worktreeInstallerSf = ts === null ? null : ts.createSourceFile(
  'install-harness.mjs', installerText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS,
);
let worktreeWiringValid = false;
if (worktreeInstallerSf && worktreeInstallerSf.parseDiagnostics.length === 0) {
  const findNodes = (root, predicate) => {
    const found = [];
    const walk = (node) => {
      if (predicate(node)) found.push(node);
      node.forEachChild(walk);
    };
    walk(root);
    return found;
  };
  const literal = (node, value) => node && ts.isStringLiteral(node) && node.text === value;
  const isWorktreeWire = (node) => ts.isCallExpression(node)
    && ts.isIdentifier(node.expression) && node.expression.text === 'ensureHook'
    && literal(node.arguments[3], 'lead-worktree-hook.mjs');
  const wires = findNodes(worktreeInstallerSf, isWorktreeWire);
  const claudeBranches = findNodes(worktreeInstallerSf, (node) => ts.isIfStatement(node)
    && ts.isBinaryExpression(node.expression)
    && node.expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
    && ts.isPropertyAccessExpression(node.expression.left)
    && ts.isIdentifier(node.expression.left.expression)
    && node.expression.left.expression.text === 'target'
    && node.expression.left.name.text === 'runtime'
    && literal(node.expression.right, 'claude'));
  const wire = wires[0];
  const command = wire?.arguments[4];
  worktreeWiringValid = wires.length === 1
    && claudeBranches.some((branch) => findNodes(branch.thenStatement, isWorktreeWire).includes(wire))
    && wire.arguments.length === 5
    && ts.isPropertyAccessExpression(wire.arguments[0])
    && ts.isIdentifier(wire.arguments[0].expression)
    && wire.arguments[0].expression.text === 'settings'
    && wire.arguments[0].name.text === 'hooks'
    && literal(wire.arguments[1], 'PreToolUse')
    && literal(wire.arguments[2], 'EnterWorktree')
    && command && ts.isCallExpression(command)
    && ts.isIdentifier(command.expression) && command.expression.text === 'hookCommand'
    && command.arguments.length === 2
    && ts.isPropertyAccessExpression(command.arguments[0])
    && ts.isIdentifier(command.arguments[0].expression)
    && command.arguments[0].expression.text === 'ctx'
    && command.arguments[0].name.text === 'repo'
    && literal(command.arguments[1], 'lead-worktree-hook.mjs');
}
check(
  worktreeWiringValid,
  'install-harness.mjs must wire lead-worktree-hook.mjs exactly once inside the Claude-only branch as PreToolUse on EnterWorktree',
);
// Reuse the primary behavioral owner rather than maintaining duplicate probes.
const worktreeProbe = spawnSync(process.execPath, [
  '--test', '--test-timeout=60000', '--test-force-exit',
  join(REPO, 'scripts', 'test-lead-worktree-hook.mjs'),
], {
  encoding: 'utf8',
  timeout: 60000,
});
check(
  worktreeProbe.status === 0,
  `lead-worktree-hook.mjs must advise the Enter/edit+commit/ExitWorktree keep/self-land cycle without a permission decision and pass other tools, seats and malformed stdin: ${
    worktreeProbe.status === 0 ? '' : (worktreeProbe.stderr || worktreeProbe.stdout || worktreeProbe.error?.message || '').trim().slice(-300)
  }`,
);

// 4. Contract mirror.
check(
  read(join(REPO, 'CLAUDE.md')) === read(join(REPO, 'AGENTS.md')),
  'CLAUDE.md and AGENTS.md diverged — they are byte-identical mirrors',
);

for (const label of ok) console.log(`ok: ${label}`);
// Printed BEFORE the verdict and never folded into it: a check nobody could
// take is neither a pass nor a defect, and the reader has to be able to tell
// which of the three it is.
for (const label of skipped) console.log(`skip: ${label}`);
if (failures.length) {
  console.error('');
  for (const label of failures) console.error(`FAIL: ${label}`);
  process.exit(1);
}
console.log(
  `\nhook-topology: ${ok.length} checks green${
    skipped.length ? `, ${skipped.length} not measurable from here (see skip: above)` : ''
  }`,
);
