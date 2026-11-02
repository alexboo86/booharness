// Section 3d of scripts/check-hook-topology.mjs, moved out whole (task 3458
// follow-up: that file crossed the 1500-line large-file ratchet). Pure move:
// the same checks in the same order with the same labels, deps passed in; the
// per-function split below only satisfies the CC<=10 growth gate.
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
import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Probe envs are shared by the hook probes and the live-wired-command probe.
const stashSeatEnv = { ...process.env, ORCH_SEAT_ID: 'probe', SEAT_POLICY_ROLE: 'coder' };
const stashLeadEnv = { ...process.env };
delete stashLeadEnv.ORCH_SEAT_ID;
delete stashLeadEnv.SEAT_POLICY_ROLE;
const stashDenied = (probe) => probe.status === 0 && /"permissionDecision":"deny"/.test(probe.stdout || '');
const stashSilent = (probe) => probe.status === 0 && !(probe.stdout || '').trim();
// The script path of a wired seat-stash command, parsed the way hookCommand
// writes it (ops/bootstrap/install-harness.mjs:937-940): a double-quoted path
// that may contain spaces. The unquoted form is read too, for hand-written
// wiring. hookCommand quotes because paths keep spaces; an extraction that
// stops at the first space red-flagged a correct install (review 2026-10-10).
const wiredStashScript = (command) => (String(command).match(/"([^"]*seat-stash-hook\.mjs)"/) || [])[1]
  ?? (String(command).match(/(?:^|\s)([^\s"]*seat-stash-hook\.mjs)/) || [])[1]
  ?? '';

function pinSeatStashInstallerWiring({ installerText, check }) {
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
}

function probeSeatStashHook({ REPO, check, read }) {
  const stashHook = join(REPO, 'ops', 'bootstrap', 'seat-stash-hook.mjs');
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
}

function auditSeatStashCoverageClaim({ HOME, check, readHome }) {
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
}

function pinWiredStashScriptExtraction({ check }) {
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
}

function wiredStashCommandsIn(stashSettingsText) {
  return (JSON.parse(stashSettingsText)?.hooks?.PreToolUse ?? [])
    .filter((group) => String(group.matcher ?? '').split('|').includes('Bash'))
    .flatMap((group) => group.hooks ?? [])
    .map((hook) => String(hook.command ?? ''))
    .filter((command) => command.includes('seat-stash-hook.mjs'));
}

function checkWiredStashCommands({ wiredStashCommands, stashSettingsPath, check }) {
        check(
          wiredStashCommands.length > 0,
          `${stashSettingsPath} — seat-stash-hook.mjs must be wired on PreToolUse(Bash); run node ops/bootstrap/install-harness.mjs from the main checkout`,
        );
        const wiredScript = wiredStashCommands.map(wiredStashScript).find(Boolean) ?? '';
        check(
          wiredStashCommands.length === 0 || (wiredScript && existsSync(wiredScript)),
          `${stashSettingsPath} — the wired seat-stash command must name a script that exists (${wiredStashCommands.length === 0 ? 'nothing wired — see the line above' : wiredScript || 'no script path found in the command'})`,
        );
  return wiredStashCommands[0] ?? '';
}

function fireWiredStashCommand({ wiredStashCommand, check }) {
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
}

function auditSeatStashLiveWiring({ HOME, check, readHome, notes }) {
  // The live wiring. Gated on the claude HOME being present on this machine,
  // not on settings.json: a claude home whose settings carry no stash hook is
  // the red line (lesson #10952). When wired, the wired command's script must
  // exist — a hook pointing at a dead path is not wired — and the wired command
  // itself is fired live below.
  // Task 3458: an orch seat home is `.claude/` with NO settings.json, and this
  // directory gate let readHome rethrow ENOENT (home-read-lib.mjs rethrows it
  // on purpose), killing every later section of this sensor. A missing file is
  // an answer — one note, not a crash and not a silent pass. A settings.json
  // that exists but cannot be read or parsed is the other answer: a hard
  // failure naming this path, because the wiring it carries cannot be audited.
  pinWiredStashScriptExtraction({ check });
  const stashSettingsPath = join(HOME, '.claude', 'settings.json');
  let wiredStashCommand = '';
  if (existsSync(join(HOME, '.claude'))) {
    let stashSettingsText = null;
    let stashSettingsPresent = existsSync(stashSettingsPath);
    if (stashSettingsPresent) {
      try {
        stashSettingsText = readHome(stashSettingsPath, 'seat stash hook wiring');
      } catch (error) {
        // Vanished between the stat and the read: that IS a missing file.
        if (error?.code !== 'ENOENT') throw error;
        stashSettingsPresent = false;
      }
    }
    if (!stashSettingsPresent) {
      notes.push(`no settings.json in ${join(HOME, '.claude')}: no hooks installed here`);
    } else if (stashSettingsText === null) {
      // Exists but unopenable: readHome already recorded the named skip, and a
      // check nobody could take is not a defect (home-read-lib.mjs).
    } else {
      let wiredStashCommands = null;
      try {
    wiredStashCommands = wiredStashCommandsIn(stashSettingsText);
      } catch (error) {
        check(
          false,
          `${stashSettingsPath} — settings.json is not valid JSON: ${error.message}; the seat-stash wiring cannot be audited`,
        );
      }
      if (wiredStashCommands !== null) {
        wiredStashCommand = checkWiredStashCommands({ wiredStashCommands, stashSettingsPath, check });
      }
    }
  }
  fireWiredStashCommand({ wiredStashCommand, check });
}

export function auditSeatStash(deps) {
  pinSeatStashInstallerWiring(deps);
  probeSeatStashHook(deps);
  auditSeatStashCoverageClaim(deps);
  auditSeatStashLiveWiring(deps);
}
