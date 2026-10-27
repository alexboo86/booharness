#!/usr/bin/env node
// Operator #13055: local historical-mistake reproductions, not a test suite.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
export function runLessonProbe(id, checkout) {
  const home = mkdtempSync(path.join(tmpdir(), 'lesson-probe-'));
  try {
    const child = spawnSync(process.execPath, [self, '--worker', String(id), path.resolve(checkout)], {
      cwd: checkout, encoding: 'utf8', timeout: 50_000, maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: home },
    });
    if (child.error || child.status !== 0) return { acceptance: false, mistakeAbsent: false, error: child.error?.message ?? child.stderr.trim(), status: child.status };
    const result = JSON.parse(child.stdout);
    if (typeof result.acceptance !== 'boolean' || typeof result.mistakeAbsent !== 'boolean') throw new Error('invalid probe result');
    return result;
  } catch (error) {
    return { acceptance: false, mistakeAbsent: false, error: error.message };
  } finally { rmSync(home, { recursive: true, force: true }); }
}

async function reproduce(id, checkout) {
  const observations = [];
  const observe = (name, actual, expected) => {
    observations.push({ name, actual, expected });
    return actual === expected;
  };
  const load = (file) => import(pathToFileURL(path.join(checkout, file)).href);
  if (['12805', '12713', '12845'].includes(id)) {
    const hook = (command) => {
      const child = spawnSync(process.execPath, [path.join(checkout, 'ops/bootstrap/code-intel-order-hook.mjs'), 'claude'], {
        cwd: checkout, env: process.env, encoding: 'utf8', timeout: 4000,
        input: JSON.stringify({ session_id: 'lesson-ab-reproduction', tool_name: 'Bash', cwd: checkout, tool_input: { command } }),
      });
      if (child.error || child.status !== 0) throw new Error(`hook failed: ${child.error?.message ?? child.stderr}`);
      if (!child.stdout.trim()) return 'allow';
      const reply = JSON.parse(child.stdout);
      if (reply.hookSpecificOutput?.permissionDecision === 'deny') return 'deny';
      if (reply.hookSpecificOutput?.permissionDecision === 'allow' || reply.hookSpecificOutput?.additionalContext) return 'allow';
      throw new Error(`unknown hook response: ${child.stdout}`);
    };
    const basic = [
      ['npm run check:commit -- a && git commit -m x -- a', 'allow'],
      ['npm run check:commit -- a; git commit -m x -- a', 'deny'],
    ];
    let accepted = basic;
    let mistakes;
    if (id === '12805') {
      accepted = [...basic,
        ['npm run check:commit -- a > log; rc=$?\n[ $rc -eq 0 ] || exit 1\ngit commit -m x -- a', 'allow'],
        ['npm run check:commit -- a && # c\ngit commit -m x -- a', 'allow'],
        ['npm run check:commit -- a; rc=$?; [ $rc -eq 0 ] # || exit 1\ngit commit -m x -- a', 'deny'],
        ['npm run check:commit -- a; rc=$?; [ $rc -eq 0 ] || exit 1a; git commit -m x -- a', 'deny'],
        ['npm run check:commit -- a; rc=$?; [ $rc -eq 0 ] || exit ""; git commit -m x -- a', 'deny'],
        ['npm run check:commit -- a; rc=$?; rc=0; [ $rc -eq 0 ] || exit 1; git commit -m x -- a', 'deny'],
        ['enable -n exit; npm run check:commit -- a; rc=$?; [ $rc -eq 0 ] || exit 1; git commit -m x -- a', 'deny'],
      ];
      mistakes = [
        'npm run check:commit -- a > log; rc=$?; test $rc -eq 0 -o 1 || exit 1; git commit -m x -- a; echo COMMIT-RAN',
        'npm run check:commit -- a > log; rc=$?; test $rc -eq 0 -o 1 && git commit -m x -- a',
      ];
    } else if (id === '12713') {
      accepted = [...basic, ...['rtk git', 'env git', 'command git', 'exec git', '/usr/bin/git', 'git.exe'].map((git) => [`npm run check:commit -- a; ${git} commit -m x`, 'deny']),
        ['rtk npm run check:commit -- a && rtk git commit -m x', 'allow'],
        ['npm run --silent check:commit -- a && env GIT_X=1 git -C d commit -m x', 'allow'],
        ...['rtk git', 'env git', 'command git', 'exec git', '/usr/bin/git', 'git.exe'].map((git) => [`npm run check:commit -- a | tail && ${git} commit -m x`, 'deny']),
      ];
      mistakes = ['npm run check:commit -- src & git commit -m x'];
    } else {
      accepted = [...basic,
        ["npm run check:commit -- a; rc=$?\n[ $rc -eq 0 ] || exit 1\ngit commit -F - -- a <<'EOF'\ndon't\n# message\nEOF", 'allow'],
        ["cat <<'A' <<'B'\nx\nA\ny\nB\nnpm run check:commit -- a; git commit -m y", 'deny'],
        ["npm run check:commit -- a && cat <<'END'\nx\nEND \ngit commit -m y\nEND", 'deny'],
        ["npm run check:commit -- a && cat <<'END'\nx\n\tEND\ngit commit -m y\nEND", 'deny'],
        ["npm run check:commit -- a && cat <<\"'\"\nx\n'\ngit commit -m y", 'deny'],
        ["npm run check:commit -- a && cat <<'END'X\nx\nENDX\ngit commit -m y", 'deny'],
        ['npm run check:commit -- a && # c\ngit commit -m x -- a', 'allow'],
        ['npm run check:commit -- a && echo x\r# ; git commit -m y', 'deny'],
      ];
      mistakes = [
        "npm run check:commit -- a && git commit -F - -- a << 'EOF'\nmessage\nEOF\ngit add -A && git commit -m y",
        "npm run check:commit -- a && git commit -F - <<'A'<<<'B'\nx\nA\ncd target && git commit -m y",
      ];
    }
    const acceptance = accepted.map(([command, expected]) => observe(command, hook(command), expected)).every(Boolean);
    const mistakeAbsent = mistakes.map((command) => observe(command, hook(command), 'deny')).every(Boolean);
    return { acceptance, mistakeAbsent, observations };
  }
  if (id === '12737') {
    const { kimi } = await load('ops/usage-snapshot.mjs');
    const answer = async (remaining) => {
      try {
        const rows = await kimi({ pi: { access: 'local-probe', expires: 10000 }, cli: null, now: () => 1,
          request: async () => ({ limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '100', remaining } }] }) });
        return rows.find((row) => row.window === '5h')?.used ?? 'no-reading';
      } catch (error) {
        if (!/no usage/.test(error.message)) throw error;
        return 'no-reading';
      }
    };
    const parsed = (await Promise.all([['100', 0], ['70', 30], ['0', 100]].map(async ([input, expected]) => observe(`remaining=${input}`, await answer(input), expected)))).every(Boolean);
    const { TokenKick } = await load('ops/orchestrator/src/token-kick.ts');
    const cadence = async (timeout) => {
      let now = 1000; let calls = 0;
      const kick = new TokenKick(async () => { calls++; if (timeout) throw Object.assign(new Error('local deadline'), { killed: true }); },
        () => 0, () => now, () => {});
      const rows = [{ family: 'kimi', error: 'token expired' }];
      await kick.kick(rows);
      now += 60_000; await kick.kick(rows);
      const held = calls === 1;
      now += timeout ? 60_000 : 9 * 60_000; await kick.kick(rows);
      return held && calls === 2;
    };
    const acceptance = parsed && observe('kick before 15-minute expiry', await cadence(false), true)
      && observe('timed-out kick retries after 2 minutes', await cadence(true), true);
    const mistakeAbsent = observe('remaining=150', await answer('150'), 'no-reading');
    return { acceptance, mistakeAbsent, observations };
  }
  if (id === '12562') {
    const { seatContext } = await load('ops/orchestrator/src/context.ts');
    // The daemon routes a skill absent in the subject's historical checkout.
    // An empty local cwd faithfully reproduces that missing-file boundary.
    const missing = process.env.HOME;
    const name = 'test-audit';
    const relative = `.agents/skills/${name}/SKILL.md`;
    const context = async (cwd, remote) => {
      const text = await seatContext({ role: 'researcher', family: 'codex', harness: 'pi', brief: 'local reproduction', files: [], cwd, remote,
        lookup: async () => { throw new Error('unexpected memory lookup'); },
        route: async () => ({ skills: [{ name, description: 'probe' }], source: 'map' }) });
      const line = text.split('\n').find((line) => line.startsWith(`- ${name}:`));
      const emitted = /read `([^`]+)`/.exec(line ?? '')?.[1];
      if (!emitted) throw new Error('routed skill missing from context');
      return emitted;
    };
    const remotePath = await context(missing, true);
    const localPath = await context(checkout, false);
    const acceptance = observe('remote checkout-relative skill', remotePath, relative) && observe('present local skill', localPath, relative);
    const fallback = await context(missing, false);
    const mistakeAbsent = observe('missing local skill remains readable', path.isAbsolute(fallback) && existsSync(fallback), true);
    return { acceptance, mistakeAbsent, observations };
  }
  if (id === '12703') {
    const { default: extension } = await load('ops/orchestrator/src/pi-extension.ts');
    const make = async (scout) => {
      if (scout) { process.env.ORCH_SEAT_TOOL_URL = 'http://127.0.0.1:1'; process.env.ORCH_SEAT_TOKEN = 'local-probe'; }
      else { delete process.env.ORCH_SEAT_TOOL_URL; delete process.env.ORCH_SEAT_TOKEN; }
      const handlers = new Map();
      const tools = [];
      await extension({ on: (event, handler) => { const list = handlers.get(event) ?? []; list.push(handler); handlers.set(event, list); },
        registerCommand() {}, registerTool: (tool) => tools.push(tool), getActiveTools: () => [], getSettings: () => ({}) });
      const fire = (event, input) => (handlers.get(event) ?? []).map((handler) => handler(input));
      const read = () => fire('tool_result', { toolName: 'read', input: { path: 'a' }, details: {}, content: [{ type: 'text', text: 'original' }] });
      const nudge = (results) => results.some((result) => result?.content?.some((part) => /scout_request/.test(part.text ?? '')));
      return { fire, read, nudge, tools };
    };
    const immediate = await make(true);
    const first = immediate.read();
    const skill = readFileSync(path.join(checkout, '.agents/skills/scout-request/SKILL.md'), 'utf8');
    const map = JSON.parse(readFileSync(path.join(checkout, '.agents/domains/_skill-map.json'), 'utf8'));
    const routed = ['coder', 'reviewer', 'bughunter'].every((role) => map.roleDefaults?.[role]?.includes('scout-request'));
    const acceptance = observe('scout skill delivered to worker roles', routed && skill.includes('scout_request') && skill.includes('200'), true)
      && observe('scout registered', immediate.tools.some((tool) => tool.name === 'scout_request'), true)
      && observe('first read nudged', immediate.nudge(first), true)
      && observe('only once', immediate.nudge(immediate.read()), false)
      && observe('original content kept', first.some((result) => result?.content?.[0]?.text === 'original'), true);
    const delayed = await make(true);
    delayed.fire('tool_result', { toolName: 'bash', input: { command: 'git diff' }, details: {} });
    delayed.fire('turn_end', {});
    const mistakeAbsent = observe('read after first assistant step', delayed.nudge(delayed.read()), true);
    const settled = await make(true); settled.fire('agent_settled', {});
    const disabled = await make(false);
    const boundaries = observe('no nudge after settled', settled.nudge(settled.read()), false)
      && observe('no scout, no nudge', disabled.nudge(disabled.read()), false);
    return { acceptance: acceptance && boundaries, mistakeAbsent, observations };
  }
  throw new Error(`unknown lesson probe ${id}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  if (process.argv[2] === '--worker') {
    try { console.log(JSON.stringify(await reproduce(process.argv[3], process.argv[4]))); }
    catch (error) { console.error(error.stack); process.exitCode = 1; }
  } else {
    const result = runLessonProbe(process.argv[2], process.argv[3] ?? process.cwd());
    console.log(JSON.stringify(result));
    process.exitCode = Number(!result.acceptance || !result.mistakeAbsent || Boolean(result.error));
  }
}
