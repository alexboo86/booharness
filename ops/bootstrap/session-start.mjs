#!/usr/bin/env node
// Session-start delivery hook: one script, every runtime, every launch mode.
//
// Emits toolset health, MCP and skills checks, seat load, domain knowledge
// and, for a lead, the two chat-join lines, to stdout (the host adds that to
// the session context).
//
// The trigger map is deliberately NOT printed here (2026-07-31 token audit):
// the same rules already live in AGENTS.md and are enforced by hard hooks, so
// the copy here was a per-session duplicate that only cost context.
//
// Contract with the host (learned from the 2026-07-28 rollback, memory #255):
//   - exit 0 ALWAYS: a broken check must never break the session;
//   - bounded output: diagnostics capped at OUTPUT_BUDGET_BYTES; lead rules, and the STE rule block while the language switch is not off, reserved in full;
//   - quiet: nothing on stderr, no interactive prompts, hard timeouts.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forgetDeliveredLessons } from './domain-lessons-hook.mjs';
import { spawnPlan } from '../../scripts/memory/lesson-lib.mjs';
import { installerCanonDir, supportLeadInstalled } from '../../scripts/git-env.mjs';
import { formatLine, isStale, readCache } from '../usage-cache.mjs';
import { effectiveLeadSkills, readHarnessConfig } from '../../scripts/lib/harness-config.mjs';

const PROBE_TIMEOUT_MS = 4000;
const OUTPUT_BUDGET_BYTES = 6 * 1024;

function run(cmd, args, timeout, shell = process.platform === 'win32', cwd) {
  try {
    const r = spawnSync(cmd, args, {
      timeout,
      // SIGKILL, not SIGTERM: a child that ignores TERM outlives the bound, and the
      // hook contract promises hard timeouts (reviewer-codex-a5a459.1, task 2427).
      killSignal: 'SIGKILL',
      encoding: 'utf8',
      windowsHide: true,
      shell, // win32 default: resolve .cmd/.exe shims on PATH
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(cwd ? { cwd } : {}),
    });
    if (r.error) {
      // A timeout is not a verdict about the tool: the child was killed at OUR
      // bound, so the honest report is "no answer", not "dead" (task 2127).
      // spawnSync spells it error.code ETIMEDOUT in both shell and no-shell
      // modes; a missing binary is ENOENT and stays a plain failure.
      return { ok: false, out: String(r.error.message || r.error), timedOut: r.error.code === 'ETIMEDOUT' };
    }
    return { ok: r.status === 0, out: (r.stdout || '').trim() || (r.stderr || '').trim() };
  } catch (error) {
    return { ok: false, out: String(error && error.message ? error.message : error) };
  }
}

// A byte-level cap that lands on a UTF-8 boundary. Slicing through a
// multibyte sequence decodes the partial tail to U+FFFD, which is THREE
// bytes, so the "capped" string could re-encode LARGER than the budget it
// was cut to. Walk the cut back to a sequence start (continuation bytes are
// 10xxxxxx): the output stays valid UTF-8 and strictly within budget.
function capBytesUtf8(s, budgetBytes) {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= budgetBytes) return s;
  let end = Math.max(budgetBytes, 0);
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString('utf8');
}

/// Settings files that arm the advisor, with the model each one names. A
/// missing or unparseable file arms nothing.
export function advisorSettings(paths) {
  const armed = [];
  for (const path of paths) {
    try {
      const model = JSON.parse(readFileSync(path, 'utf8'))?.advisorModel;
      if (typeof model === 'string' && model) armed.push({ path, model });
    } catch {
      /* absent or hand-edited: it arms nothing */
    }
  }
  return armed;
}

/**
 * The domain map, four lines. A page states in its own header whether anyone
 * has walked its anchors; the first twelve audits came back 698 confirmed
 * against 474 wrong, so "written" and "checked" are different states and the
 * session is entitled to know which pages are which before it trusts one.
 * Pure apart from the reads, and exported so a test can feed it a fixture.
 */
export function knowledgeIndex(repoRoot) {
  const domainsDir = join(repoRoot, '.agents', 'domains');
  let dirs;
  try {
    dirs = readdirSync(domainsDir).filter((d) => d.startsWith('domain-')).sort();
  } catch {
    return [];
  }
  const checked = [];
  const draft = [];
  const missing = [];
  for (const dir of dirs) {
    const name = dir.replace(/^domain-/, '');
    let head;
    try {
      head = readFileSync(join(domainsDir, dir, 'knowledge.md'), 'utf8').split('\n').slice(0, 12).join('\n');
    } catch {
      missing.push(name);
      continue;
    }
    if (/^fact-checked:/m.test(head)) checked.push(name);
    else draft.push(name);
  }
  if (!checked.length && !draft.length) return [];
  const out = ['# Domain knowledge (`.agents/domains/domain-<name>/knowledge.md`)'];
  out.push(
    '- the MAP of a subsystem: what exists, how it is wired, what it stores, what must not break.',
    '  Read a domain\'s page BEFORE forming a hypothesis about it — not only before editing it.',
    '  Lessons are scars and arrive separately (`memoryctl lessons --path <file>`); neither replaces the other.',
  );
  if (checked.length) out.push(`- fact-checked by another family (${checked.length}): ${checked.join(', ')}`);
  if (draft.length) out.push(`- DRAFT, nobody walked its anchors (${draft.length}): ${draft.join(', ')} — read as a lead, not as truth`);
  if (missing.length) out.push(`- no page yet (${missing.length}): ${missing.join(', ')}`);
  return out;
}

/**
 * Pure decision for task 2050 (no I/O): should this session checkout's
 * `.rtk/filters.toml` be trusted on the strength of the main checkout's trust?
 * rtk pins trust to path PLUS sha256, so a session worktree the provisioner
 * never saw runs with the project filters silently off even when its filter
 * file is byte-identical to a trusted one (98 of 109 session worktrees,
 * 2026-10-04). Returns one of: 'same-checkout' | 'no-file' | 'already-trusted'
 * | 'trust' | 'differs' | 'source-untrusted'. 'trust' only when the bytes are
 * equal AND the main checkout's file shows in `rtk trust --list` with that sha.
 */
export function rtkFilterTrust({ sessionRoot, mainRoot, bothExist, bytesEqual, mainSha256, trustList, platform }) {
  const win = platform === 'win32';
  // Ported from the `rtk trust --list` line of ops/orchestrator/worktree-setup.json:
  // on win32 the list spells trusted paths with a \\?\ prefix and backslashes,
  // so a raw string match never fires and the trust step is silently skipped.
  const norm = (s) => {
    if (!win) return s;
    const p = String(s).replaceAll('\\', '/');
    return (p.startsWith('//?/') ? p.slice(4) : p).toLowerCase();
  };
  if (norm(sessionRoot) === norm(mainRoot)) return 'same-checkout';
  if (!bothExist) return 'no-file';
  if (!bytesEqual) return 'differs';
  const wantedSha = `sha256:${mainSha256}`;
  const lines = String(trustList).split('\n');
  // rtk prints one entry as two lines: the path line (with a `(trusted <date>)`
  // suffix), then an indented `sha256:<hex>` line. A path counts as trusted
  // WITH THAT SHA only when its sha line matches - a pinned old sha is a
  // different trust decision, not proof for these bytes.
  const trustedWithSha = (file) =>
    lines.some((line, i) => {
      if (!norm(line).includes(norm(file))) return false;
      const shaLine = lines.slice(i + 1).find((l) => l.trim() !== '');
      return shaLine !== undefined && shaLine.trim() === wantedSha;
    });
  const sessionFile = `${sessionRoot}/.rtk/filters.toml`;
  const mainFile = `${mainRoot}/.rtk/filters.toml`;
  if (trustedWithSha(sessionFile)) return 'already-trusted';
  // The win32 half of the ported fallback: when path spelling cannot be
  // matched at all, a bare `sha256:<hex>` line for these bytes still counts.
  if (trustedWithSha(mainFile) || (win && lines.some((l) => l.trim() === wantedSha))) return 'trust';
  return 'source-untrusted';
}

/**
 * The session and instructions a lead needs to join orch chat, or none.
 * The session is the SessionStart input's session_id — the id the other hooks
 * receive. A seat (ORCH_SEAT_ID or SEAT_POLICY_ROLE) and a missing id add
 * nothing: a blank id would be a join line the lead cannot run.
 */
function leadChatJoinLines(event, env) {
  if (env.ORCH_SEAT_ID || env.SEAT_POLICY_ROLE) return [];
  const session = event?.session_id;
  if (typeof session !== 'string' || session.trim() === '' || /[\r\n]/.test(session)) return [];
  return [
    `session_id: ${session}`,
    `chat_join {handle: "<track slug>", session: "${session}"} — the handle is the lead's track slug.`,
    'For chat_join also pass desktop: get_session "self" field sessionId; omit desktop when that tool is unavailable.',
  ];
}


// The reader's message quotes the file. This line must not. The category comes
// from the reader's own prefix; a read error adds only the system code.
function harnessConfigFaultLine(error, file) {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (message.startsWith('Cannot read harness config ')) {
    const code = error?.cause && typeof error.cause.code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(error.cause.code)
      ? ` (${error.cause.code})`
      : '';
    return `WARNING: harness config: the file cannot be read${code}: ${file}\n`;
  }
  if (message.startsWith('Invalid JSON in harness config ')) {
    return `WARNING: harness config: the file is not valid JSON: ${file}\n`;
  }
  return `WARNING: harness config: the reader refuses the config: ${file}; the installer prints the reason\n`;
}
async function main() {
  // A compaction keeps the session id and drops what the context held, so the
  // lesson hook's "delivered once this session" marks stop being true: forget
  // them, and the next edit of each file brings its lessons back. Live event,
  // Claude Code 2.1.268 (2026-09-12): SessionStart `"source":"compact"` with
  // the session_id its PreCompact carried, context 35,540 -> 1,929 tokens.
  // `/clear` is `"source":"clear"` under a NEW session id: nothing to forget.
  let preCompact = false;
  let event = null;
  try {
    event = JSON.parse(readFileSync(0, 'utf8'));
    preCompact = event.hook_event_name === 'PreCompact';
    if (preCompact || event.source === 'compact') forgetDeliveredLessons(event.session_id ?? event.sessionId);
  } catch {
    // No event on stdin, or the marks would not go: they stay until the next edit.
  }
  // Kimi sends PreCompact, not SessionStart after compact: forget only, no probes.
  if (preCompact) return;

  const here = dirname(fileURLToPath(import.meta.url));
  const manifest = JSON.parse(readFileSync(process.env.SESSION_START_TOOLSET || join(here, 'toolset.json'), 'utf8'));

  const lines = [];
  lines.push('# Mandatory toolset (session-start check)');

  const dead = []; // every failed probe — later gates (rtk trust adoption) judge on this list
  const noAnswer = []; // killed at PROBE_TIMEOUT_MS: unknown, not dead (task 2127)
  for (const [name, spec] of Object.entries(manifest.tools)) {
    const [cmd, ...args] = spec.probe;
    const probe = run(cmd, args, PROBE_TIMEOUT_MS);
    if (probe.ok) {
      // `use` is the one line that says WHEN to reach for a tool nobody reaches
      // for unprompted (the scout, measured 2026-09-11: the first lead session
      // after it shipped used it only when the operator asked why not).
      // A `use` line is the one sentence saying WHEN to reach for a tool, so it
      // has to be runnable ON THIS PLATFORM: the scout is a bash script, and
      // `bash` by name on Windows is WSL, which answers `execvpe(/bin/bash)
      // failed` (measured 2026-09-16). `use_win32` carries the Git Bash spelling.
      const use = (process.platform === 'win32' && spec.use_win32) || spec.use;
      lines.push(use ? `- ${name}: OK - ${use}` : `- ${name}: OK`);
    } else {
      dead.push(name); // a timed-out tool keeps its place: gates below must not lean on a tool that has not answered
      const reason = probe.out.split(/\r?\n/)[0].slice(0, 160) || 'no output';
      if (probe.timedOut) {
        // NO ANSWER, not DEAD. Under load the same tool answers seconds later
        // (session local_4791ad64, 2026-10-05: memoryctl /health answered 16.3 s
        // past two 4 s timeouts while the session told the operator memory was
        // dead). Slow and down are different states and only a longer probe can
        // tell them apart; this hook has no budget for one, so it says so
        // instead of guessing a verdict.
        noAnswer.push(name);
        lines.push(`- ${name}: NO ANSWER in ${PROBE_TIMEOUT_MS / 1000} s — ${reason}`);
      } else {
        lines.push(`- ${name}: DEAD — ${reason}`);
      }
    }
  }
  if (noAnswer.length > 0) {
    lines.push(
      `WARNING: ${noAnswer.join(', ')} gave no answer in ${PROBE_TIMEOUT_MS / 1000} s — slow or down is unknown. Retry the probe once with a longer bound before calling it unavailable, and report the retry's result.`
    );
  }
  const unreachable = dead.filter((name) => !noAnswer.includes(name));
  if (unreachable.length > 0) {
    lines.push(
      `WARNING: ${unreachable.join(', ')} unavailable. Do NOT silently work around a dead mandatory tool — tell the operator in your first reply.`
    );
  }

  // Only a lead can notify the operator. Match install-memory's state rule and
  // read the last verified ship; a hook must not start another backup or probe.
  if (!process.env.ORCH_SEAT_ID) {
    const stateDir = process.env.MEMORYCTL_STATE_DIR
      || join(process.env.MEMORYCTL_HOME || homedir(), '.local', 'state', 'memoryctl');
    let localOptions;
    try {
      localOptions = JSON.parse(readFileSync(join(stateDir, 'local-service.json'), 'utf8'));
    } catch { /* Remote mode has no local options; unreadable options arm nothing. */ }
    if (localOptions?.backupTo != null) {
      try {
        // Backup imports node:sqlite: even loading it is optional and fallible.
        // Do not load it on seats, in remote mode, or with backups disabled.
        const { assertShippedHealth } = await import('../backup-memory.mjs');
        if (typeof assertShippedHealth !== 'function') throw new Error('assertShippedHealth export is unavailable');
        try {
          assertShippedHealth(join(stateDir, 'backup-staging'));
        } catch (error) {
          const reason = String(error?.message ?? error).replace(/[\r\n]+/g, ' ');
          lines.push(`WARNING: memory backup: ${reason}. Tell the operator in your first reply.`);
        }
      } catch (error) {
        const reason = capBytesUtf8(String(error?.message ?? error).replace(/[\r\n]+/g, ' '), 200);
        lines.push(`WARNING: memory backup: health could not be read: ${reason}. Tell the operator in your first reply.`);
      }
    }
  }

  // MCP servers: the client launches them itself, so "configured" is the
  // checkable fact here — a live probe would race the client's own startup.
  // Configured = named in the project .mcp.json or the runtime's global config.
  const repoRoot = dirname(dirname(here));

  // rtk project filters (task 2050): a desktop session worktree
  // (.claude/worktrees/<name>) is never provisioned, so its `.rtk/filters.toml`
  // - byte-identical to the main checkout's - is untrusted and the project
  // filters are silently OFF for the whole session. When the main checkout's
  // copy is trusted with the same sha, adopt that trust here. Fail-open like
  // everything in this hook, bounded by PROBE_TIMEOUT_MS per call.
  if (!dead.includes('rtk')) {
    try {
      const sessionCwd = typeof event?.cwd === 'string' && event.cwd ? event.cwd : process.cwd();
      const top = run('git', ['rev-parse', '--show-toplevel'], PROBE_TIMEOUT_MS, process.platform === 'win32', sessionCwd);
      const sessionRoot = top.ok ? top.out.split(/\r?\n/)[0].trim() : '';
      if (sessionRoot) {
        const sessionFile = join(sessionRoot, '.rtk', 'filters.toml');
        const mainFile = join(repoRoot, '.rtk', 'filters.toml');
        const bothExist = existsSync(sessionFile) && existsSync(mainFile);
        let bytesEqual = false;
        let mainSha256 = '';
        if (bothExist) {
          const mainBytes = readFileSync(mainFile);
          bytesEqual = mainBytes.equals(readFileSync(sessionFile));
          mainSha256 = createHash('sha256').update(mainBytes).digest('hex');
        }
        const list = run('rtk', ['trust', '--list'], PROBE_TIMEOUT_MS);
        const decision = rtkFilterTrust({
          sessionRoot,
          mainRoot: repoRoot,
          bothExist,
          bytesEqual,
          mainSha256,
          trustList: list.ok ? list.out : '',
          platform: process.platform,
        });
        if (decision === 'trust') {
          const trusted = run('rtk', ['trust', '-y'], PROBE_TIMEOUT_MS, process.platform === 'win32', sessionRoot);
          lines.push(
            trusted.ok
              ? `- rtk filters: trusted ${sessionFile} - byte-identical to the main checkout's trusted copy, project filters now apply here.`
              : `- rtk filters: NOT applied — trust failed: ${(trusted.out.split(/\r?\n/)[0] || 'no output').slice(0, 160)}`
          );
        } else if (decision === 'differs' || decision === 'source-untrusted') {
          lines.push(
            `- rtk filters: NOT applied — ${decision === 'differs'
              ? 'session .rtk/filters.toml differs from the main checkout copy; a hand-edited file is never trusted on someone else\'s pin.'
              : 'the main checkout\'s .rtk/filters.toml is not itself trusted, so there is no trusted source to adopt.'}`
          );
        }
      }
    } catch {
      /* trust adoption is a convenience; it must never break session start */
    }
  }

  // Operator #13207: always-on for leads only; seats answer the lead, not the operator.
  // Reuse the seat environment check from domain-lessons-hook.mjs.
  // lead.plainStyle false turns this print off. Absent or true keeps it. The
  // config is the checkout that contains this hook: repoRoot is two directories
  // above session-start.mjs (ops/bootstrap → the repository root). A loaded module
  // always has that path; there is no second lookup that can fail. A file the
  // reader refuses never removes the print. The diagnostic line names a fixed
  // category and the config path, never the reader's message.
  let operatorRules = '';
  let harnessConfigFault = '';
  if (!process.env.ORCH_SEAT_ID) {
    let suppressRules = false;
    try {
      const config = readHarnessConfig({ repoRoot });
      suppressRules = config.lead?.plainStyle === false;
    } catch (error) {
      harnessConfigFault = harnessConfigFaultLine(error, join(repoRoot, 'ops', 'bootstrap', 'harness.config.json'));
    }
    if (!suppressRules) {
      try {
        const body = readFileSync(join(repoRoot, '.agents', 'skills', 'i-have-adhd', 'SKILL.md'), 'utf8')
          .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim();
        operatorRules = `# i-have-adhd: rules apply to every reply to the operator; the project contract outranks them.\n${body}\n\n`;
      } catch {
        /* A missing skill must not break session start. */
      }
    }
  }
  const mcpConfigs = [join(repoRoot, '.mcp.json'), join(homedir(), '.claude.json')];
  let mcpText = '';
  for (const path of mcpConfigs) {
    try {
      mcpText += readFileSync(path, 'utf8');
    } catch {
      /* a missing config file is judged by what the other one holds */
    }
  }
  // The allowlist is the SSOT `install-harness.mjs` installs from, and nothing else.
  //
  // `toolset.json` used to carry its own `mcps` list, and the two disagreed:
  // five names against the SSOT's seven, missing `booharness` and `context7`.
  // Two lists that both mean "the MCP servers we sanction" cannot both be
  // right, and the one that decides what is INSTALLED is the one that decides
  // what is sanctioned. `_`-prefixed keys are rejections kept as a record
  // (`_clickhouse_rejected`), not servers.
  const mcpSsot = JSON.parse(readFileSync(join(here, 'mcp-servers.json'), 'utf8'));
  const allowedMcps = Object.keys(mcpSsot?.servers ?? {}).filter((id) => !id.startsWith('_'));
  // The operator profile is a second SSOT, not a surplus: its servers are here
  // because someone ran the installer WITH the flag. They are still worth
  // naming, because they are the expensive ones - `operator-support` alone
  // publishes 61 tools - and because seeing them is how the operator remembers
  // this session is carrying them.
  let operatorMcps = [];
  try {
    const operatorSsot = JSON.parse(readFileSync(join(here, 'mcp-servers.operator.json'), 'utf8'));
    operatorMcps = Object.keys(operatorSsot?.servers ?? {}).filter((id) => !id.startsWith('_'));
  } catch {
    /* no operator profile on this machine: everything configured is shared */
  }
  const missingMcps = allowedMcps.filter((id) => !mcpText.includes(`"${id}"`));
  // What is ACTUALLY named in the configs, not what the manifest expects.
  //
  // The line used to print the manifest whenever nothing was missing, so a
  // server configured BEYOND the allowlist was invisible by construction.
  // Measured 2026-08-09: `.mcp.json` and every runtime config carried nine
  // servers while this line reported five, and the two extra were the
  // operator-only `operator-trade` and `operator-support` - the latter alone
  // publishing 61 tools into every session that loads its schemas eagerly.
  // A harness whose own report cannot show a surplus cannot be trimmed by
  // measurement, which is the only way it is allowed to be trimmed.
  const configured = new Set();
  for (const path of mcpConfigs) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      continue; // absent or hand-edited: the other file still reports.
    }
    for (const id of Object.keys(parsed?.mcpServers ?? {})) configured.add(id);
  }
  const surplus = [...configured].filter(
    (id) => !allowedMcps.includes(id) && !operatorMcps.includes(id)
  );
  const operatorHere = [...configured].filter((id) => operatorMcps.includes(id));
  lines.push('');
  lines.push('# MCP servers');
  lines.push(
    missingMcps.length === 0
      ? `- configured: ${[...configured].sort().join(', ') || '(none found)'}`
      : `- MISSING from .mcp.json/.claude.json: ${missingMcps.join(', ')} — tell the operator, re-run ops/bootstrap/install-harness.mjs.`
  );
  if (operatorHere.length > 0) {
    lines.push(
      `- operator profile ON: ${operatorHere.sort().join(', ')} — the largest tool surfaces this machine installs. Drop them with ops/bootstrap/install-harness.mjs (no --operator-profile). The support desk needs --support-profile ON TOP of --operator-profile: operator decision 2026-08-12, it is 61 tools of static schema tax on every turn and belongs to sessions that actually work tickets.`
    );
  }
  if (surplus.length > 0) {
    lines.push(
      `- BEYOND both SSOTs: ${surplus.sort().join(', ')} — nothing sanctions these, and each ships its tool schemas into every turn. Remove them, or add them to ops/bootstrap/mcp-servers.json deliberately.`
    );
  }

  // Skills: canon lives in <repo>/.agents/skills, and a Claude session reads its
  // links from THIS CHECKOUT (`<repo>/.claude/skills`) since 2026-08-18 — one
  // shared home let the other checkout's session write through the link into
  // this canon. A canon skill without a link is drift.
  //
  // The home layout is still accepted, because the member runtimes keep it and
  // because a machine mid-migration has both. Reporting drift over a checkout
  // that is simply linked the OTHER way is a sensor crying wolf, and this one
  // greets every session.
  //
  // A lead is promised only the lead set, not the whole canon: the installer links
  // leadInstalledSkills (effectiveLeadSkills: its class core skills plus the config's skills.lead
  // when that key is present), plus supportLeadSkills when a support-lead install left a
  // managed link to one of them (check-skills-drift.mjs judges the same set). Seat skills reach a
  // seat through orch. Measured 2026-09-24: comparing the whole canon (57) with the
  // 18 lead links printed "NOT LINKED ... (+29 more)" every session, and re-running
  // the installer could never clear it.
  lines.push('');
  lines.push('# Skills');
  try {
    const canonDir = join(repoRoot, '.agents', 'skills');
    const map = JSON.parse(readFileSync(join(repoRoot, '.agents', 'domains', '_skill-map.json'), 'utf8'));
    const projectSkillsDir = join(repoRoot, '.claude', 'skills');
    const homeSkillsDir = join(homedir(), '.claude', 'skills');
    const skillsDir = process.env.SESSION_START_SKILLS_DIR
      || (existsSync(projectSkillsDir) ? projectSkillsDir : homeSkillsDir);
    const linked = (name) => existsSync(join(skillsDir, name, 'SKILL.md')) || existsSync(join(homeSkillsDir, name, 'SKILL.md'));
    const support = map.supportLeadSkills ?? [];
    // The support profile is judged in the scope's own lead directory, by a managed link into
    // that scope's canon, exactly as check-skills-drift does: a legacy HOME link to one support
    // skill does not promise a project scope the whole set (review 2026-09-24, reviewer-codex-0ed8a3).
    const scopeCanon = skillsDir === homeSkillsDir ? installerCanonDir(repoRoot) : canonDir;
    // The config's skills.lead replaces the non-core part of the lead set. An absent config
    // file holds no key. A config the reader refuses leaves the set unknown: the line says so
    // and never quotes the reader's message, the same rule as harnessConfigFaultLine.
    // A skills.off name is linked into no runtime, so it is no part of the judged set either.
    let skillsConfig;
    let configRefused = false;
    try {
      skillsConfig = existsSync(join(repoRoot, 'ops', 'bootstrap', 'harness.config.json'))
        ? readHarnessConfig({ repoRoot }).skills
        : undefined;
    } catch {
      configRefused = true;
    }
    if (configRefused) {
      lines.push('- lead skills not judged: the reader refuses the harness config; the installer prints the reason');
    } else {
      const off = new Set(skillsConfig?.off ?? []);
      const canon = [...(effectiveLeadSkills({ map, lead: skillsConfig?.lead }) ?? []), ...(supportLeadInstalled([skillsDir], scopeCanon, support) ? support : [])]
        .filter((name) => !off.has(name) && existsSync(join(canonDir, name, 'SKILL.md')));
      const missingSkills = canon.filter((name) => !linked(name));
      lines.push(
        missingSkills.length === 0
          ? `- lead skills linked: ${canon.length}`
          : `- NOT LINKED into ${skillsDir}: ${missingSkills.slice(0, 10).join(', ')}${missingSkills.length > 10 ? ` (+${missingSkills.length - 10} more)` : ''} — re-run ops/bootstrap/install-harness.mjs.`
      );
    }
  } catch (error) {
    lines.push(`- skills check failed: ${String(error && error.message ? error.message : error).slice(0, 160)}`);
  }
  // The advisor (habr 1080738, 2026-09-10): `advisorModel` in a settings file
  // arms Claude Code's advisor in every session that reads the file, and each
  // call hands the advisor the executor's full transcript - measured there at
  // 2.03x the accounted context (median over 1170 calls), so a 1M window
  // behaves like 500k. One stray `/advisor opus` writes it into the USER
  // settings, and nothing else on this machine would say so. The user settings
  // are the ACTIVE config directory's: the GLM lead runs Claude Code with its
  // own CLAUDE_CONFIG_DIR (round harness-habr-intake-r1).
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  for (const { path, model } of advisorSettings([
    join(configDir, 'settings.json'),
    join(configDir, 'settings.local.json'),
    join(repoRoot, '.claude', 'settings.json'),
    join(repoRoot, '.claude', 'settings.local.json'),
  ])) {
    lines.push(
      `- advisorModel=${model} in ${path}: the advisor re-reads the full transcript on every call (~2x context) in every session here — tell the operator; \`/advisor off\` clears it.`
    );
  }

  // Seat load. The operator picks a family by what is left in its window, and
  // until now that number existed only if someone remembered to run the script
  // (2026-09-19: `ops/usage-snapshot.mjs` was named in one hook's advice text
  // and nowhere else). This hook makes NO network call of its own — it prints
  // the parked snapshot with its age and, when that snapshot is stale, starts a
  // detached refresh for the NEXT session. A refresh that fails, hangs or is
  // killed with the terminal costs this session nothing.
  const snapshot = readCache();
  const loadLine = formatLine(snapshot);
  lines.push(
    loadLine
      ?? '- seat load: no snapshot yet — `node ops/usage-snapshot.mjs` writes one (and the next session prints it).',
  );
  if (!snapshot || isStale(snapshot)) {
    try {
      const child = spawn(process.execPath, [join(repoRoot, 'ops', 'usage-snapshot.mjs')], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
    } catch { /* A refresh that cannot start is next session's problem, not this one's. */ }
  }

  lines.push('');
  lines.push(...knowledgeIndex(repoRoot));

  // Worktree code-intel provisioning (design 1в, 2026-07-28): an app-native
  // worktree (.claude/worktrees/<name>) used to have no worktree-local index, so
  // the indexed tool silently answered from the MAIN checkout — wrong branch.
  // The seeding script is idempotent, fail-open and quiet when nothing to do.
  // SESSION_START_PROVISION_SCRIPT overrides the path (test seam, same pattern
  // as SESSION_START_SKILLS_DIR above).
  let provisionText = '';
  const provision =
    process.env.SESSION_START_PROVISION_SCRIPT ||
    join(dirname(fileURLToPath(import.meta.url)), 'provision-worktree.sh');
  if (existsSync(provision)) {
    // `bash` by name is WSL on Windows: C:\WINDOWS\system32\bash.exe wins over
    // Git Bash, which is not on the agent's PATH, and the call dies with
    // `execvpe(/bin/bash) failed`. This hook is fail-open, so the worktree
    // simply never got provisioned and nobody was told. spawnPlan finds Git
    // Bash through git.exe instead of the PATH (lesson-lib.mjs). On unix the
    // script is mode 644 — not executable — so it still goes through `bash`.
    const seeded = process.platform === 'win32'
      // plan.shell is false: an absolute Git Bash path under cmd.exe splits at
      // "C:\Program Files" and the fail-open hook swallowed that on every start.
      ? (() => { const plan = spawnPlan(provision, []); return run(plan.file, plan.argv, 30000, plan.shell); })()
      : run('bash', [provision], 30000);
    if (seeded.ok && seeded.out) provisionText = seeded.out;
  }

  // The reviewed lead rules exceed the diagnostic budget: deliver them in full,
  // then cap diagnostics (including a verbose provisioner) on a UTF-8 boundary.
  // Front of the capped text: the cut is at the end, so these two lines survive
  // a full diagnostic budget. Every lead pays them; a seat or a missing id adds none.
  const chatJoin = leadChatJoinLines(event, process.env);
  if (chatJoin.length) lines.unshift(...chatJoin);

  // Language switch (task 2164, plan 14879 A4): a lead prints the STE rule block
  // when the mode is flag or enforce. Beside operatorRules, outside the diagnostic
  // cap, so a full budget cannot cut it and the 6 KiB pin stays. off, a fault, a
  // missing rule file or any throw adds nothing: the output stays byte-identical
  // to a session with no switch. Read at each run. A seat adds none.
  let steRules = '';
  if (!process.env.ORCH_SEAT_ID && !process.env.SEAT_POLICY_ROLE) {
    try {
      const { loadConfig } = await import('../orchestrator/src/config.ts');
      const { readLanguageMode } = await import('../orchestrator/src/shared.entry.ts');
      const read = readLanguageMode(loadConfig().stateDir);
      if ((read.mode === 'flag' || read.mode === 'enforce') && !read.fault) {
        steRules = readFileSync(join(here, '..', 'orchestrator', 'ste', 'rule.md'), 'utf8');
      }
    } catch {
      steRules = '';
    }
  }

  const delivered = operatorRules + steRules + capBytesUtf8(`${lines.join('\n')}\n${provisionText ? `${provisionText}\n` : ''}`, OUTPUT_BUDGET_BYTES);
  process.stdout.write(harnessConfigFault
    ? `${delivered}${delivered.endsWith('\n') ? '' : '\n'}${harnessConfigFault}`
    : delivered);
}

// Run only when this file IS the program. Without the guard, importing it to
// unit-test one pure function runs the whole hook — probes the machine,
// writes its report to stdout — and the test measures the machine
// instead of the function.
//
// Compared as RESOLVED paths, not as URLs. `import.meta.url` is already
// realpath-resolved by the loader while `process.argv[1]` is the path as
// invoked, so a single symlinked component anywhere in the hook's command line
// makes the two differ and the hook exits 0 having printed nothing — silently,
// fail-open, and indistinguishable from a healthy session. On macOS that is not
// hypothetical: `/tmp`, `/var` and `/etc` are all symlinks into `/private`.
// Measured 2026-08-20: invoked through a symlinked directory the URL comparison
// answered false; through the real path, true.
const invokedAs = process.argv[1] || '';
let isMainModule = false;
try {
  isMainModule =
    invokedAs !== '' && fileURLToPath(import.meta.url) === realpathSync(invokedAs);
} catch {
  // An argv[1] that cannot be resolved is not this file; importing must stay
  // silent rather than fail.
  isMainModule = false;
}
if (isMainModule) {
  try {
    await main();
  } catch (error) {
    // Even a broken manifest must not break the session.
    process.stdout.write(
      `# Mandatory toolset check failed to run: ${String(error && error.message ? error.message : error).slice(0, 200)}\n`
    );
  }
  process.exit(0);
}
