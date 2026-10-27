// node --test — contract for the rtk-rewrite-plus layer (unified-toolset
// invariant, holes 1-2 of handoff #301). Upstream `rtk rewrite` is injected as
// a stub that mirrors the MEASURED behaviour of rtk 0.44.0 on 2026-07-28.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  alreadyRouted,
  rewritePlus,
  rewriteHeavy,
  unwrapShell,
  unwrapUndispatchable,
  defaultUpstreamRewrite,
  RTK_SUBCOMMANDS,
  RTK_MANAGED_SHELL_COMMANDS,
  RTK_COMMANDS,
} from './rtk-rewrite-lib.mjs';

// alreadyRouted separates the two things the warn-only counter was conflating.
// The deny that the counter exists to price could only ever fire on a command
// the agent did NOT route; a refinement of one it did route (`rtk cat` ->
// `rtk proxy cat`) is a different, cheaper observation. Measured 2026-08-05:
// 75 of 119 logged would-deny events were already-routed commands, so the
// number the operator would read to decide about restoring deny was inflated
// 2.7x by events a deny would never have produced.
test('alreadyRouted: a bare heavy command is not routed', () => {
  assert.equal(alreadyRouted('git status'), false);
});

test('alreadyRouted: a command the agent put under rtk is routed', () => {
  assert.equal(alreadyRouted('rtk cat scripts/nested-checkouts.mjs'), true);
  assert.equal(alreadyRouted('rtk.exe grep foo'), true);
  assert.equal(alreadyRouted('  rtk proxy cargo build  '), true);
});

test('alreadyRouted: a chain counts as routed only when EVERY segment is', () => {
  assert.equal(alreadyRouted('rtk git status && rtk diff'), true);
  // The bare `ls -la` is exactly what a deny would have caught, so the whole
  // chain must stay countable as a would-deny event.
  assert.equal(alreadyRouted('rtk git status && ls -la'), false);
  assert.equal(alreadyRouted('ls -la ; rtk git status'), false);
});

test('alreadyRouted: a pipeline is judged by the stage whose output is read', () => {
  assert.equal(alreadyRouted('cat foo | rtk grep bar'), true);
  assert.equal(alreadyRouted('rtk cat foo | grep bar'), false);
});

test('alreadyRouted: a shell wrapper does not hide the real command', () => {
  assert.equal(alreadyRouted(`bash -lc 'rtk git status'`), true);
  assert.equal(alreadyRouted(`bash -lc 'git status'`), false);
});

test('alreadyRouted: empty and non-string input is not routed', () => {
  assert.equal(alreadyRouted(''), false);
  assert.equal(alreadyRouted('   '), false);
  assert.equal(alreadyRouted(null), false);
});

test('alreadyRouted: rtk as a substring of another program is not routed', () => {
  assert.equal(alreadyRouted('rtkfoo bar'), false);
});

// An `env VAR=x` (or bare `VAR=x`) prefix puts the rtk invocation somewhere
// other than position 0. The gate that validates the invocation used to anchor
// at ^rtk, so it read `env … rtk cargo test …` as "not an rtk call" and threw
// upstream's answer away. Measured 2026-08-05 over the 300 most frequent
// commands in rtk's own history db: this was one of only two shapes where the
// binary rewrote and we declined — and it is `cargo test`, the category that
// saves 85-97%.
test('an env-prefixed rewrite is accepted, not discarded', () => {
  const upstream = (c) =>
    c === 'env CARGO_TARGET_DIR=/tmp/x cargo test --manifest-path <project-specific>/Cargo.toml'
      ? 'env CARGO_TARGET_DIR=/tmp/x rtk cargo test --manifest-path <project-specific>/Cargo.toml'
      : null;
  assert.equal(
    rewritePlus('env CARGO_TARGET_DIR=/tmp/x cargo test --manifest-path <project-specific>/Cargo.toml', upstream),
    'env CARGO_TARGET_DIR=/tmp/x rtk cargo test --manifest-path <project-specific>/Cargo.toml',
  );
});

test('a bare VAR=value prefix is accepted the same way', () => {
  const upstream = (c) => (c === 'RUST_LOG=debug cargo build' ? 'RUST_LOG=debug rtk cargo build' : null);
  assert.equal(rewritePlus('RUST_LOG=debug cargo build', upstream), 'RUST_LOG=debug rtk cargo build');
});

test('an answer naming a subcommand rtk cannot dispatch is still refused', () => {
  // The whole point of the gate: `rtk du` is not a subcommand, rtk answers
  // "unrecognized subcommand", runs the command raw and writes a parse_failure.
  const upstream = (c) => (c === 'env A=1 du -sh .' ? 'env A=1 rtk du -sh .' : null);
  assert.equal(rewritePlus('env A=1 du -sh .', upstream), null);
});

test('a prefix that is not an assignment does not smuggle a bad rewrite through', () => {
  // `sudo rtk du` must fail the gate exactly like `rtk du` does.
  const upstream = (c) => (c === 'sudo du -sh .' ? 'sudo rtk du -sh .' : null);
  assert.equal(rewritePlus('sudo du -sh .', upstream), null);
});

test('an upstream answer naming the 1.0.1 canonical `bypass` passes the gate like `proxy`', () => {
  // Same shape as the wc case below, but through the renamed verb: the gate
  // must know `bypass` is dispatchable, or every answer naming it is thrown
  // away once upstream starts emitting the canonical name.
  const upstream = (c) => (c === 'du -sh .svod' ? 'rtk bypass du -sh .svod' : null);
  assert.equal(rewritePlus('du -sh .svod', upstream), 'rtk bypass du -sh .svod');
});

// head/tail/wc used to be declined wholesale as "self-bounding", on the ground
// that accepting cost a deny turn for no saving. Deny ended 2026-07-31, so that
// ground is gone — but the three are not one case. Measured 2026-08-05 over the
// 1200 most frequent commands: 29 of the 31 shapes we refused while the binary
// rewrote were `wc -l`, where the answer only puts rtk in front of the SAME
// program. `head` is the other kind: the answer runs `rtk read`, a different
// reader whose output shape the caller did not ask for.
test('a rewrite that only routes the same program is accepted', () => {
  const upstream = (c) => (c === 'wc -l svod/src/status.rs' ? 'rtk wc -l svod/src/status.rs' : null);
  assert.equal(rewritePlus('wc -l svod/src/status.rs', upstream), 'rtk wc -l svod/src/status.rs');
});

test('a rewrite that substitutes a different reader is declined', () => {
  const upstream = (c) => (c === 'head -80 vitest.config.ts' ? 'rtk read vitest.config.ts --max-lines 80' : null);
  assert.equal(rewritePlus('head -80 vitest.config.ts', upstream), null);
});

test('the substitution rule applies to tail as well as head', () => {
  const upstream = (c) => (c === 'tail -20 app.log' ? 'rtk read app.log --tail 20' : null);
  assert.equal(rewritePlus('tail -20 app.log', upstream), null);
});

test('substitution is judged for readers only, not for every command', () => {
  // `git status` -> `rtk git status` is a routing rewrite and always was fine;
  // `cargo test` -> `rtk cargo test` likewise. The reader rule must not widen.
  const upstream = (c) => (c === 'git status' ? 'rtk git status' : null);
  assert.equal(rewritePlus('git status', upstream), 'rtk git status');
});

// Measured upstream behaviour: maps single git/head/tail/cat-with-file forms,
// compounds of mapped commands, standalone ssh; declines sed/awk and pipelines
// with an unmapped stage.
function upstreamStub(command) {
  if (/^git\s+status$/.test(command)) return 'rtk git status';
  if (/^git\s+diff --stat$/.test(command)) return 'rtk git diff --stat';
  if (/^head -50 package\.json$/.test(command)) {
    return 'rtk read package.json --max-lines 50';
  }
  if (/^ssh mac 'cargo test'$/.test(command)) return "rtk ssh mac 'cargo test'";
  if (command === 'git status && git diff --stat') {
    return 'rtk git status && rtk git diff --stat';
  }
  return null;
}

test('upstream whole-command rewrite wins untouched', () => {
  assert.equal(
    rewritePlus('git status && git diff --stat', upstreamStub),
    'rtk git status && rtk git diff --stat'
  );
});

// --- task 2783: `git log` runs past rtk filtering --------------------------
// Measured 2026-10-21 (rtk 1.0.1, 45-commit fixture): `rtk git log` printed 10
// entries, `rtk git log --oneline` 50, `rtk git log -S KEY` 10 of 15 matches —
// no marker, no recall hash, an explicit `-n N` honoured. A history question
// answered short reads as the whole history, so the layer declines the
// rewrite upstream offers for every `git log` form; every other git subcommand
// keeps its routing.
test('git log stays bare even when upstream offers the rewrite', () => {
  const eager = (command) => `rtk ${command}`;
  assert.equal(rewritePlus('git log', eager), null);
  assert.equal(rewritePlus('git log --oneline', eager), null);
  assert.equal(rewritePlus('git log -S KEY --all', eager), null);
  // Global options may precede the verb, with and without operands.
  assert.equal(rewritePlus('git -C /d/x log --oneline', eager), null);
  assert.equal(rewritePlus('git --git-dir /d/x/.git log -G RE', eager), null);
});

test('a chain answer that routes a git log segment is refused whole', () => {
  // Upstream answers compounds of mapped commands as one string (measured,
  // see upstreamStub's `git status && git diff --stat` case), so the refusal
  // cannot live in the per-segment pass alone: a whole-chain answer would
  // slip the log filter in through the front door.
  const upstream = (command) =>
    command === 'cd /d/x && git log --oneline && git status'
      ? 'cd /d/x && rtk git log --oneline && rtk git status'
      : null;
  assert.equal(rewritePlus('cd /d/x && git log --oneline && git status', upstream), null);
});

test('the git log refusal leaves every other git subcommand routed', () => {
  const eager = (command) => `rtk ${command}`;
  assert.equal(rewritePlus('git status', eager), 'rtk git status');
  // A chain keeps the log segment bare and routes the rest — the whole-command
  // eager answer is refused, the per-segment pass still rewrites `git status`.
  assert.equal(rewritePlus('git log --oneline && git status', eager),
    'git log --oneline && rtk git status');
  assert.equal(rewritePlus('git log -S KEY && git status', eager),
    'git log -S KEY && rtk git status');
});

test('a pipeline judges the git log stage, not the whole pipeline', () => {
  // `git log | grep KEY`: the log stage feeds the pipe, only the final stage
  // reaches the context, and routing the final stage is a grep filter, not the
  // history cap. The log stage itself stays bare so the grep sees ALL of the
  // history; a self-bounding final stage still declines as before.
  assert.equal(rewritePlus('git log | grep KEY', () => null), 'git log | rtk grep KEY');
  assert.equal(rewritePlus('git log | head -5', () => null), null);
});

test('the kimi refusal transport does not deny bare git log', () => {
  // kimi is denied into `rtk …` when a rewrite exists; `git log` deliberately
  // has none (isBareGitLog), so needsHeavyRouting must not call it heavy — a
  // deny would leave the member no way to run it at all.
  assert.equal(rewriteHeavy('git log -S KEY'), null);
  assert.equal(rewriteHeavy('git -C /d/x log --oneline'), null);
});

test('operator screenshot case: cd && sed | head — head is self-bounding, left raw', () => {
  // Narrow-coverage policy (2026-07-31): the last stage bounds its own output,
  // so a rewrite would buy nothing but a denied turn on guard-only providers.
  assert.equal(
    rewritePlus("cd /d/x && sed -n '1,50p' file | head -60", upstreamStub),
    null
  );
});

test('sed and awk are declined: rtk has no such subcommand', () => {
  // Until 2026-08-02 both were prefixed here. rtk answers `unrecognized
  // subcommand`, runs the command raw through its fallback and files a
  // parse_failure — same bytes in the context, one extra process, and a dent in
  // the savings average. 244 of 938 tracked commands were this shape.
  assert.equal(rewritePlus("sed -n '1,50p' package.json", upstreamStub), null);
  assert.equal(rewritePlus("awk '{print $1}' data.txt", upstreamStub), null);
});

test('an upstream rewrite naming an unknown subcommand is declined', () => {
  // Upstream `rtk rewrite` is the source of most parse failures: it happily
  // answers `rtk du -sh x` for a verb the binary cannot dispatch.
  const overEager = (command) => `rtk ${command}`;
  assert.equal(rewritePlus('du -sh .svod', overEager), null);
  assert.equal(rewritePlus('stat -c %y CLAUDE.md', overEager), null);
  assert.equal(rewritePlus('node -e "1"', overEager), null);
  // ...while a verb it CAN dispatch still passes.
  assert.equal(rewritePlus('git status', overEager), 'rtk git status');
});

test('project-declared filters count as dispatchable', () => {
  // `[filters.ssh]` in .rtk/filters.toml is why `rtk ssh` filters real output
  // even though `ssh` is absent from `rtk --help`. Guarded so the test states
  // the dependency instead of failing obscurely in a tree without the file.
  const declared = existsSync(join(process.cwd(), '.rtk', 'filters.toml'));
  if (!declared) return;
  assert.equal(
    rewritePlus("cd /d/x && ssh mac 'cargo test -p server'", upstreamStub),
    "cd /d/x && rtk ssh mac 'cargo test -p server'"
  );
});

test('pinned subcommand set still matches the installed binary', (t) => {
  // The set is pinned to keep the hot path spawn-free; this is what notices
  // when a new rtk adds a filter, so it gets used instead of silently ignored.
  const rtkBin = process.platform === 'win32' ? 'rtk.exe' : 'rtk';
  // A pinned move lands in the pin BEFORE the lead installs the binary (task
  // 2519: pin 1.0.1 committed first, install after). An installed rtk OLDER
  // than the pin is that mid-upgrade state: its --help is the old release's,
  // and both directions below would report the upgrade itself as drift. The
  // sensor's subject is a binary at or past the pin — a NEWER binary (the
  // drift it exists to catch) is still asserted, fail closed when unreadable.
  const pinnedRtk = (() => {
    try { return JSON.parse(readFileSync(new URL('./tool-pins.json', import.meta.url), 'utf8')).rtk; }
    catch { return null; }
  })();
  if (typeof pinnedRtk === 'string' && /^\d+\.\d+\.\d+$/.test(pinnedRtk)) {
    const probed = spawnSync(rtkBin, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, NO_COLOR: '1', CLICOLOR: '0', CLICOLOR_FORCE: '0' },
    });
    const found = probed.status === 0 && !probed.error
      ? String(probed.stdout).match(/(\d+)\.(\d+)\.(\d+)/) : null;
    if (found) {
      const inst = [+found[1], +found[2], +found[3]];
      const pin = pinnedRtk.split('.').map(Number);
      const older = inst[0] < pin[0]
        || (inst[0] === pin[0] && (inst[1] < pin[1] || (inst[1] === pin[1] && inst[2] < pin[2])));
      if (older) {
        return t.skip(`installed rtk ${found[0]} is older than the pin ${pinnedRtk}; parity is asserted at the pinned version`);
      }
    }
  }
  const help = spawnSync(rtkBin, ['--help'], {
    encoding: 'utf8',
    timeout: 5000,
    // Colour is the difference between a sensor and a decoration. A Svod
    // reviewer measured `rtk --help` arriving with ANSI in ITS environment:
    // `Commands:` never matched, the parser bailed, and the test passed while
    // the pin had a hole punched in it. Ask for plain text AND strip whatever
    // still arrives.
    env: { ...process.env, NO_COLOR: '1', CLICOLOR: '0', CLICOLOR_FORCE: '0' },
  });
  if (help.error || help.status !== 0) return; // no binary here: not this test's subject

  const plain = String(help.stdout).replace(/\[[0-9;]*[A-Za-z]/g, '');
  const lines = plain.split(/\r?\n/);
  const start = lines.findIndex((line) => /^Commands:/.test(line));
  // Fail CLOSED from here on: the binary answered, so anything we cannot parse
  // is a broken sensor, not an absent subject.
  assert.ok(start >= 0, `rtk --help has no Commands: block this test can read:\n${plain.slice(0, 400)}`);
  const after = lines.slice(start + 1);
  const end = after.findIndex((line) => /^\S/.test(line) && /:$/.test(line.trim()));
  const listed = new Set(
    (end < 0 ? after : after.slice(0, end))
      .filter((line) => /^\s{2}\S/.test(line))
      .map((line) => line.trim().split(/\s+/)[0])
  );
  assert.ok(listed.size > 0, 'parsed zero subcommands from rtk --help — the sensor is broken');
  const missing = [...listed].filter((name) => !RTK_SUBCOMMANDS.has(name));
  assert.deepEqual(missing, [], `rtk gained subcommands the pin does not know: ${missing}`);
  // A pin name that is a HIDDEN clap alias of a listed command is dispatchable
  // and so is not "invented": rtk 1.0.1 renamed `proxy` to `bypass` and kept
  // `proxy` as a silent alias that --help does not list (upstream pins this in
  // test_proxy_is_a_silent_alias_for_bypass). The alias must stay dispatchable
  // for rtkCanDispatch, so the pin keeps it and the sensor allows the pair.
  const PINNED_HIDDEN_ALIASES = new Map([['proxy', 'bypass']]);
  const invented = [...RTK_SUBCOMMANDS].filter((name) => !listed.has(name)
    && !(PINNED_HIDDEN_ALIASES.has(name) && listed.has(PINNED_HIDDEN_ALIASES.get(name))));
  assert.deepEqual(invented, [], `the pin claims subcommands rtk does not have: ${invented}`);
});

test('RTK 0.49 additions route through the pinned dispatch gate', () => {
  // Measured with rtk 0.49.0 --help/rewrite. These are real shell CLIs;
  // the upstream rewrite owns their command shapes, our gate must accept them.
  const mapped = ['ctest --output-on-failure', 'bun test', 'bunx tsc --noEmit',
    'sqlfluff lint .', 'deno test', 'mvnd test'];
  for (const command of mapped) {
    const verb = command.split(' ')[0];
    assert.ok(RTK_SUBCOMMANDS.has(verb), `${verb} must be dispatchable`);
    assert.ok(RTK_MANAGED_SHELL_COMMANDS.has(verb), `${verb} is a managed shell CLI`);
    assert.equal(rewritePlus(command, () => `rtk ${command}`), `rtk ${command}`);
    assert.equal(unwrapUndispatchable(`rtk ${command}`), null);
  }
  // recall is RTK's own output-recovery verb, not a bare program. phpt
  // wraps `php run-tests.php`, not a shell program called `phpt`. Neither
  // gets an invented bare-command rewrite, but explicit rtk calls must work.
  for (const command of ['recall deadbeef', 'phpt tests/foo.phpt']) {
    const verb = command.split(' ')[0];
    assert.ok(RTK_SUBCOMMANDS.has(verb), `${verb} must be dispatchable`);
    assert.equal(RTK_MANAGED_SHELL_COMMANDS.has(verb), false);
    assert.equal(rewritePlus(command, () => null), null);
    assert.equal(unwrapUndispatchable(`rtk ${command}`), null);
  }
});

test('every managed shell command is one rtk can actually filter', () => {
  // The deny list a grok member launches with is built from this file (grok is
  // forced only by `--deny 'Bash(<cmd> *)'`; `--allow` forbids nothing, measured
  // 2026-08-07). Denying a command rtk cannot dispatch leaves the member unable
  // to run it by ANY route: bare is refused and `rtk <cmd>` does not exist. That
  // is why `cat`, `sed` and `awk` are in neither list, and why this holds.
  // A project-declared filter counts as dispatchable: `[filters.ssh]` in
  // .rtk/filters.toml is why `rtk ssh` filters real server-log output, and
  // `rtk --help` never lists it. Gating on the binary's help alone would have
  // kept the heaviest remote command out of the deny list.
  const filtersFile = join(process.cwd(), '.rtk', 'filters.toml');
  const filters = new Set(
    existsSync(filtersFile)
      ? [...readFileSync(filtersFile, 'utf8').matchAll(/^\s*\[filters\.([A-Za-z0-9_-]+)\]/gm)].map((m) => m[1])
      : []
  );
  const unfilterable = [...RTK_MANAGED_SHELL_COMMANDS]
    .filter((name) => !RTK_SUBCOMMANDS.has(name) && !filters.has(name));
  assert.deepEqual(unfilterable, [], `managed but not filterable: ${unfilterable}`);
  assert.ok(RTK_MANAGED_SHELL_COMMANDS.size > 0, 'a deny list of nothing enforces nothing');
  // Shell builtins are not programs to deny: `while read line` and `test -f x`
  // are a script's own words, and refusing them refuses the script.
  for (const builtin of ['read', 'test', 'env']) {
    assert.equal(RTK_MANAGED_SHELL_COMMANDS.has(builtin), false, `${builtin} is a shell builtin`);
  }
});

test('ssh with a remote command inside a compound is wrapped locally', () => {
  assert.equal(
    rewritePlus("cd /d/x && ssh mac 'cargo test -p server'", upstreamStub),
    "cd /d/x && rtk ssh mac 'cargo test -p server'"
  );
});

test('bare ssh login (no remote command) is left alone', () => {
  assert.equal(rewritePlus('ssh mac', upstreamStub), null);
});

test('self-bounding readers decline even an upstream rewrite', () => {
  // The stub maps `head -50 package.json` like the real binary; we still pass
  // it raw — the output is bounded by construction.
  assert.equal(
    rewritePlus('cd /d/x && head -50 package.json', upstreamStub),
    null
  );
  assert.equal(rewritePlus('head -50 package.json', upstreamStub), null);
  assert.equal(rewritePlus('tail -30 /var/log/x.log', upstreamStub), null);
  assert.equal(rewritePlus('wc -l src/main.ts', upstreamStub), null);
});

test('pipeline last stage only: mid-pipe stages stay raw', () => {
  assert.equal(
    rewritePlus('git log --oneline | grep fix', upstreamStub),
    'git log --oneline | rtk grep fix'
  );
});

test('low-volume filters pass raw under the narrow policy', () => {
  assert.equal(rewritePlus('git log --oneline | head -5', upstreamStub), null);
  assert.equal(rewritePlus('rtk gain 2>&1 | tail -30', upstreamStub), null);
  assert.equal(rewritePlus('cat big.log | wc -l', upstreamStub), null);
  assert.equal(rewritePlus("ps | sort | uniq -c", upstreamStub), null);
  assert.equal(rewritePlus("cut -d: -f1 /etc/passwd", upstreamStub), null);
});

test('heavy unbounded filters stay covered — the ones rtk can dispatch', () => {
  assert.equal(rewritePlus('rg foo src', upstreamStub), 'rtk rg foo src');
  assert.equal(
    rewritePlus('docker logs app | grep ERROR', upstreamStub),
    'docker logs app | rtk grep ERROR'
  );
  // `cat` is not one of them: upstream maps it to `rtk read` when it can, and
  // when it cannot, prefixing buys a parse_failure instead of a filter.
  assert.equal(rewritePlus('cat huge.log', upstreamStub), null);
});

test('redirection into a file is never filtered (data integrity)', () => {
  assert.equal(rewritePlus("sed -n '1p' f > out.txt", upstreamStub), null);
  assert.equal(rewritePlus('git log | head -5 > out.txt', upstreamStub), null);
});

test('command substitution disables the compound pass', () => {
  assert.equal(rewritePlus('sed -n "$(cat lines)" f', upstreamStub), null);
});

test('here-doc and newlines disable the compound pass', () => {
  assert.equal(rewritePlus('cat <<EOF\nhello\nEOF', upstreamStub), null);
});

test('already-rtk segments are not double-wrapped', () => {
  assert.equal(rewritePlus('rtk grep foo f', upstreamStub), null);
  assert.equal(rewritePlus('rtk git status', upstreamStub), null);
});

test('`rtk <verb rtk cannot dispatch>` is repaired into `rtk proxy <verb>`', () => {
  // A Paseo member's --allowedTools is Bash(rtk *), so it cannot type a bare
  // command even when the bare one is right. Measured on a freshly reset db:
  // 6 of 6 parse failures were `rtk node --test ...` from one member.
  assert.equal(
    rewritePlus('rtk node --test scripts/x.test.mjs', upstreamStub),
    'rtk proxy node --test scripts/x.test.mjs'
  );
  assert.equal(rewritePlus('rtk sed -n 1p f', upstreamStub), 'rtk proxy sed -n 1p f');
  assert.equal(rewritePlus('rtk.exe du -sh .', upstreamStub), 'rtk.exe proxy du -sh .');
  // Self-bounding readers are left alone when BARE, but `rtk head` is not bare:
  // it is an undispatchable rtk call that parse-fails and then runs anyway, so
  // repairing it costs one argument and removes a failure row.
  assert.equal(
    rewritePlus('git log | rtk head -5', upstreamStub),
    'git log | rtk proxy head -5'
  );
});

test('proxy repair does not touch what rtk already dispatches', () => {
  assert.equal(rewritePlus('rtk proxy node --check f.mjs', upstreamStub), null, 'no double proxy');
  assert.equal(rewritePlus('rtk cargo test', upstreamStub), null);
  assert.equal(rewritePlus('rtk --version', upstreamStub), null, 'a flag is rtk\'s own business');
  assert.equal(rewritePlus('rtk', upstreamStub), null);
});

test('proxy repair reaches the last stage of a pipeline and inside a chain', () => {
  assert.equal(
    rewritePlus('cd /d/x && rtk node --test t.mjs', upstreamStub),
    'cd /d/x && rtk proxy node --test t.mjs'
  );
  assert.equal(
    rewritePlus('git log --oneline | rtk node -e "1"', upstreamStub),
    'git log --oneline | rtk proxy node -e "1"'
  );
});

test('operators inside quotes are not split points', () => {
  assert.equal(
    rewritePlus("grep 'a && b' notes.txt", upstreamStub),
    "rtk grep 'a && b' notes.txt"
  );
});

test('unrelated commands pass untouched', () => {
  assert.equal(rewritePlus('npm run build', upstreamStub), null);
  assert.equal(rewritePlus('echo hello', upstreamStub), null);
});

test('semicolon chains rewrite each element independently', () => {
  assert.equal(
    rewritePlus('grep foo a; rg bar b', upstreamStub),
    'rtk grep foo a; rtk rg bar b'
  );
});

test('integration: quotes and pipes never execute in a shell during rewrite', (t) => {
  // Regression for the live 2026-07-28 incident: spawnSync(shell:true) let the
  // `| sed` inside the command string run in that shell and the hook replaced
  // the command with rtk's usage text.
  const { defaultUpstreamRewrite } = require_lib();
  const probe = defaultUpstreamRewrite(
    'rtk discover -p "harness-project" 2>&1 | sed -n \'2,4p\''
  );
  assert.ok(
    probe === null || !/Usage:/i.test(probe),
    `shell leakage detected: ${probe}`
  );
});

function require_lib() {
  return { defaultUpstreamRewrite };
}

test('unwrapShell peels bash -lc coats recursively', () => {
  assert.equal(unwrapShell('bash -lc "sed -n 1p f"'), 'sed -n 1p f');
  assert.equal(
    rewritePlus('bash -lc "grep foo f"', upstreamStub),
    'rtk grep foo f'
  );
});

test('already-declined verbs stay declined even inside a coat', () => {
  assert.equal(rewritePlus('bash -lc "sed -n 1p f"', upstreamStub), null);
});

// --- unwrap: the repair belongs to the CAGE, not to the tool -------------
// `rtk proxy <x>` exists because a Paseo member's --allowedTools is
// `Bash(rtk *)`: it cannot type a bare command. Codex is under no such rule —
// its adapter passes no allowlist — so for codex the same repair is a process
// hop that saves nothing and writes a 0% row. Measured 2026-08-05: codex typed
// `rtk powershell …` 8 and 9 times in two live rollouts, and 53 of 105 member
// calls reached rtk through `proxy` with zero savings.

test('an rtk call rtk cannot dispatch is unwrapped back to the bare command', () => {
  assert.equal(unwrapUndispatchable('rtk powershell -NoProfile -Command Get-Date'),
    'powershell -NoProfile -Command Get-Date');
  assert.equal(unwrapUndispatchable('rtk node --test x.mjs'), 'node --test x.mjs');
  assert.equal(unwrapUndispatchable('rtk.exe node --test x.mjs'), 'node --test x.mjs');
  // An explicit proxy is the same over-application, one word longer.
  assert.equal(unwrapUndispatchable('rtk proxy powershell -Command x'), 'powershell -Command x');
});

// rtk 1.0.1 renamed `proxy` to `bypass` and kept `proxy` as a silent alias with
// identical behaviour (src/lib.rs at v1.0.1: #[command(alias = "proxy")], and
// upstream's own test_proxy_is_a_silent_alias_for_bypass pins it). Every
// recognition site that peels `rtk proxy` must peel `rtk bypass` the same way.
test('the 1.0.1 canonical name `bypass` is unwrapped like the `proxy` alias', () => {
  assert.equal(unwrapUndispatchable('rtk bypass powershell -Command x'), 'powershell -Command x');
  assert.equal(unwrapUndispatchable('rtk.exe bypass node --test x.mjs'), 'node --test x.mjs');
  // An explicit `rtk bypass <dispatchable>` is the same over-application.
  assert.equal(unwrapUndispatchable('rtk bypass git status'), 'git status');
});

test('unwrap keeps project-declared RTK filters, not just built-ins', () => {
  const filtersFile = join(process.cwd(), '.rtk', 'filters.toml');
  if (!existsSync(filtersFile) || !/^\s*\[filters\.memoryctl\]/m.test(readFileSync(filtersFile, 'utf8'))) return;
  assert.equal(unwrapUndispatchable('rtk memoryctl hot'), null);
});

test('unwrap leaves alone what rtk really does dispatch', () => {
  for (const kept of ['rtk git status', 'rtk cargo test', 'rtk gain', 'rtk discover --all',
    'rtk read src/main.rs', 'rtk --version', 'git status', 'powershell -Command x']) {
    assert.equal(unwrapUndispatchable(kept), null, kept);
  }
});

test('unwrap reaches into a chain and a pipeline, like the repair it mirrors', () => {
  assert.equal(unwrapUndispatchable('cd /d/x && rtk node --test t.mjs'), 'cd /d/x && node --test t.mjs');
  assert.equal(unwrapUndispatchable('git log | rtk head -5'), 'git log | head -5');
});
