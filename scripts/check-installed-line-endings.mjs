#!/usr/bin/env node
// CRLF sensor for everything the Mac consumes from this repo.
//
// Measured failure this file exists to make impossible: a script copied out of
// a Windows working tree arrives with \r\n, and on the Mac dies as
// `bad interpreter: bash^M` — an error that reads as "the tool is not
// installed" and costs an hour of searching in the wrong place. .gitattributes
// pins LF for *.sh in GIT, but git only governs git: nothing looked at the
// bytes that actually landed on the Mac, so nothing could see them arrive
// broken. Two ends, one sensor:
//
//   repo mode      git blobs of every Mac entry file (cat-file, so a Windows
//                  working tree cannot lie about what ships)
//   installed mode the installed surface on the machine this runs on — scan
//                  every .sh/.mjs/.plist/.json plus the extensionless
//                  `memoryctl` client
//
// .ps1/.bat/.cmd are CRLF by design (.gitattributes) and are never findings.
//
//   node scripts/check-installed-line-endings.mjs                  # both modes
//   node scripts/check-installed-line-endings.mjs --installed-root <dir> --no-repo
//   node scripts/check-installed-line-endings.mjs --repo           # blobs only

import { scrubbedGitEnv } from './git-env.mjs';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMain } from './lib/is-main.mjs'
import { harnessLabel, harnessPaths, readHarnessConfig } from './lib/harness-config.mjs'
import { spawnSync } from 'node:child_process'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

// Everything a macOS install of this harness copies out of the tree: the memory
// service + client, the installer that ships them, the hooks and shims that run
// there, and the stand scripts. A new Mac-consumed entry is a one-line addition
// here — that is the contract.
export const MAC_ENTRY_FILES = [
  '.claude/scripts/memoryctl',
  '.claude/scripts/memoryctl-http.sh',
  'scripts/memory/store.mjs',
  'scripts/memory/task-pure.mjs',
  'scripts/memory/embed-recipe.mjs',
  'scripts/memory/search-results.mjs',
  'scripts/memory/reranker.mjs',
  'scripts/memory/rerank-worker.py',
  'scripts/memory/memoryd.mjs',
  'scripts/memory/mcp-server.mjs',
  'docs/agent/domain-routing.generated.json',
  'ops/bootstrap/install-memory.mjs',
  'ops/backup-memory.mjs',
  'ops/bootstrap/verify-memory-transfer.mjs',
  'ops/bootstrap/session-start.mjs',
  'ops/bootstrap/domain-lessons-hook.mjs',
  'ops/bootstrap/code-intel-order-hook.mjs',
  'ops/bootstrap/codex-rtk-hook.mjs',
  'ops/bootstrap/rtk-rewrite-lib.mjs',
  'ops/bootstrap/session-inject-once.mjs',
  'ops/bootstrap/json-context-wrap.mjs',
  'ops/bootstrap/provision-worktree.sh',
  'ops/setup-machine.sh',
  'scripts/stand/stand-env.sh',
  'scripts/stand/stand-api.sh',
  'scripts/stand/stand-backfill.sh',
]

// CRLF is the designed form for these on Windows; they are never Mac entries.
const SKIP_EXTENSIONS = new Set(['.ps1', '.bat', '.cmd', '.exe', '.dll'])
const SCAN_EXTENSIONS = new Set(['.sh', '.mjs', '.py', '.plist', '.json'])
// The PATH client is installed extensionless; scan it by exact name and by
// nothing else — an arbitrary extensionless file in a bin dir is not ours.
const SCAN_EXACT_NAMES = new Set(['memoryctl'])

function scanFile(file, bytes) {
  let firstCrOffset = -1
  let crCount = 0
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] === 0x0d) {
      crCount += 1
      if (firstCrOffset < 0) firstCrOffset = i
    }
  }
  if (crCount === 0) return null
  return { file, crCount, firstCrOffset, problem: `CR byte at offset ${firstCrOffset} (${crCount} total) — on macOS this becomes 'bad interpreter: bash^M'` }
}

function wanted(name) {
  if (SCAN_EXACT_NAMES.has(name)) return true
  const dot = name.lastIndexOf('.')
  if (dot === -1) return false
  const ext = name.slice(dot).toLowerCase()
  if (SKIP_EXTENSIONS.has(ext)) return false
  return SCAN_EXTENSIONS.has(ext)
}

function walk(root, out) {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile() && wanted(entry.name)) out.push(full)
  }
}

function walkInto(root) {
  const files = []
  walk(root, files)
  return files
}

/// Scan installed roots. Missing roots are skipped (an absent install cannot
/// carry a CRLF), every present scanned file must be CR-free.
export function scanInstalledSurface(roots) {
  const findings = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    const files = statSync(root).isDirectory() ? walkInto(root) : [root]
    for (const file of files) {
      // A file that EXISTS and will not open is a finding, not a crash. This
      // scan is the last link of `npm run check:harness-audit`, so an uncaught
      // throw here ends the whole chain in a stack trace and every sensor after
      // it says nothing — which reads exactly like silence, not like failure.
      // Reported rather than skipped, because CR-freedom is the claim this
      // sensor makes about every installed file, and a file nobody read is not
      // a file anybody proved clean.
      let bytes
      try {
        bytes = readFileSync(file)
      } catch (error) {
        findings.push({
          file,
          crCount: 0,
          firstCrOffset: -1,
          problem: `installed but unreadable (${error.code ?? error.message}) — CR-freedom could not be decided here`,
        })
        continue
      }
      const finding = scanFile(file, bytes)
      if (finding) findings.push(finding)
    }
  }
  return findings
}

/// Read one entry file's bytes from git — index first, then HEAD — so the
/// check sees exactly what a clone would materialise, not this working tree.
function gitBlob(repo, relative) {
  for (const rev of [`:${relative}`, `HEAD:${relative}`]) {
    const run = spawnSync('git', ['cat-file', 'blob', rev], { env: scrubbedGitEnv(), cwd: repo })
    if (run.status === 0) return { bytes: run.stdout }
    // A real blob that happens to be empty also returns status 0 with empty
    // stdout, so only a nonzero exit means "not at this rev".
  }
  return null
}

/// Every entry must be tracked and CR-free in git.
export function checkRepoBlobs(repo, files) {
  const findings = []
  for (const relative of files) {
    const blob = gitBlob(repo, relative)
    if (!blob) {
      findings.push({ file: relative, crCount: 0, firstCrOffset: -1, problem: 'not tracked in git — an untracked file ships by accident or not at all' })
      continue
    }
    const finding = scanFile(relative, Buffer.from(blob.bytes, 'binary'))
    if (finding) findings.push(finding)
  }
  return findings
}

// ── CLI ───────────────────────────────────────────────────────────────────

function defaultInstalledRoots(prefix) {
  const home = process.env.MEMORYCTL_HOME || (process.env.USERPROFILE || process.env.HOME)
  if (!home) return []
  const label = harnessLabel({ prefix, name: 'memoryctl' })
  return [
    harnessPaths({ prefix, home }).shareDir,
    join(home, '.local', 'bin', 'memoryctl'),
    join(home, 'Library', 'LaunchAgents', `${label}.plist`),
  ]
}

function report(findings, label) {
  if (!findings.length) return
  console.error(`check-installed-line-endings: ${label}`)
  for (const finding of findings) {
    console.error(`  ${finding.file} — ${finding.problem}`)
  }
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2)
  const flag = (name) => args.indexOf(name)
  const value = (name) => {
    const at = flag(name)
    return at > -1 ? args[at + 1] : null
  }

  const wantRepo = flag('--no-repo') === -1
  const installedRoot = value('--installed-root')
  let roots
  try {
    const prefix = readHarnessConfig({ repoRoot: REPO }).names.prefix
    roots = installedRoot ? [installedRoot] : defaultInstalledRoots(prefix)
  } catch (error) {
    console.error(`check-installed-line-endings: ${error.message}`)
    process.exit(1)
  }

  let failed = 0
  if (wantRepo) {
    const findings = checkRepoBlobs(REPO, MAC_ENTRY_FILES)
    report(findings, 'git blobs of Mac entry files carry CR (LF is required):')
    failed += findings.length
  }
  if (roots.length) {
    const findings = scanInstalledSurface(roots)
    report(findings, 'installed files carry CR — on macOS they fail as "bad interpreter":')
    failed += findings.length
  }

  if (failed) {
    console.error(`\n${failed} file(s). Fix the SOURCE to LF — converting only the installed copy hides the next bad transfer.`)
    process.exit(1)
  }
  console.log('check-installed-line-endings: OK (no CR in repo blobs or installed surface)')
  process.exit(0)
}
