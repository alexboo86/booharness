#!/usr/bin/env node
// Moves the ONE durable memory database to another machine — verifiably.
//
// A byte-copy of memory.db is not a transfer: with journal_mode=WAL a third of
// the committed content can sit in memory.db-wal, and a copy of the main file
// alone ships a database that never contained it. And a copy that replaces the
// last good database before anyone checked it is not a failed transfer, it is
// data loss wearing a success exit. The three modes:
//
//   source machine (the donor, service may be running):
//     node ops/bootstrap/verify-memory-transfer.mjs \
//         --source <memory.db|state-dir> --export <snapshot.db> \
//         --emit-manifest <manifest.json> [--token <memory.token>]
//
//   accept side, verify a database already in place:
//     node ops/bootstrap/verify-memory-transfer.mjs \
//         --source-manifest <manifest.json> --target <memory.db> [--token ...]
//
//   accept side, stage + verify + atomically install:
//     node ops/bootstrap/verify-memory-transfer.mjs \
//         --source-manifest <manifest.json> --snapshot <snapshot.db> \
//         --install-into <state-dir> [--token <memory.token>] \
//         [--service-url http://127.0.0.1:7717]
//
// The manifest is computed FROM THE SNAPSHOT — the bytes that actually travel —
// and the export cross-checks the snapshot against the live source, so a WAL
// tail that failed to travel fails HERE, on the donor, where the data still is.
//
// The install never renames an unverified byte range over a live database: the
// snapshot is copied to a staged sibling, verified there, and only then renamed
// into place (rename replaces atomically on POSIX and on Windows). A fault
// anywhere before the rename leaves the previous database untouched.
//
// Two writers are refused by construction: the install probes the service URL
// first and refuses while /health answers — two writers on two copies of one
// database is split-brain memory, two writers on one file over a share is WAL
// corruption.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { isMain } from '../../scripts/lib/is-main.mjs';
import { harnessLabel, harnessTaskName, readHarnessConfig } from '../../scripts/lib/harness-config.mjs';
import { SCHEMA_VERSION, lessonMatchesPath } from '../../scripts/memory/store.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_SERVICE_URL = 'http://127.0.0.1:7717';
// The path whose lesson delivery criterion 27 makes decisive: a known lesson
// must still arrive after the move. The service probe reads this from the
// manifest, so both sides ask about the same file. Must exist in the tree and
// be owned by a live domain — `svod/src/adapter/mod.rs` left with Svod, and
// lessons --path on an unrouted file is 0 even when the row is in the database.
const LESSONS_PROBE_PATH = 'scripts/memory/store.mjs';

const USAGE = `usage:
  emit:    --source <db|dir> --export <snapshot.db> --emit-manifest <m.json> [--token <file>]
  verify:  --source-manifest <m.json> --target <db|dir> [--token <file>]
  install: --source-manifest <m.json> --snapshot <snapshot.db> --install-into <dir> [--token <file>] [--service-url <url>]`;

function usageDie(message) {
  console.error(`verify-memory-transfer: ${message}\n${USAGE}`);
  process.exit(2);
}

function parseArgs(argv) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    if (!name?.startsWith('--')) usageDie(`unexpected argument: ${name}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) usageDie(`${name} needs a value`);
    flags.set(name.slice(2), value);
  }
  return flags;
}

const args = parseArgs(process.argv.slice(2));
const isMainModule = isMain(import.meta.url);

/// Resolve `--source`/`--target`: a state directory names its database inside.
function resolveDbPath(given) {
  const stat = fs.statSync(given, { throwIfNoEntry: false });
  if (stat?.isDirectory()) return path.join(given, 'memory.db');
  return given;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function openReadonly(file, what) {
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    db.exec('PRAGMA busy_timeout=5000');
    return db;
  } catch (error) {
    throw new Error(`cannot open ${what} ${file}: ${error.message}`);
  }
}

function sqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function checkIntegrity(db, what, failures) {
  const rows = db.prepare('PRAGMA integrity_check').all();
  const text = rows.map((row) => Object.values(row)[0]).join('\n');
  if (text !== 'ok') failures.push(`${what}: integrity_check is "${text.slice(0, 200)}"`);
  const fk = db.prepare('PRAGMA foreign_key_check').all();
  if (fk.length) failures.push(`${what}: foreign_key_check reports ${fk.length} violation(s)`);
  return { integrity_check: text, foreign_key_violations: fk.length };
}

function schemaVersion(db, what, failures) {
  const raw = db.prepare('PRAGMA user_version').get().user_version;
  const version = Number(raw);
  if (!Number.isInteger(version) || version <= 0) {
    failures.push(`${what}: user_version is ${raw} — not a memoryctl database`);
    return 0;
  }
  // The kit defect, caught at the door: a database the checkout's store cannot
  // open is not cargo, it is the crash the Mac would see at first launch.
  if (version > SCHEMA_VERSION) {
    failures.push(
      `${what}: schema v${version} is newer than this checkout's store v${SCHEMA_VERSION} — `
      + `install the current checkout first (npm run install:memory)`,
    );
  }
  return version;
}

function count(db, sql) {
  return Number(db.prepare(sql).get().n);
}

function coreCounts(db) {
  return {
    mem_entries: count(db, 'SELECT COUNT(*) n FROM mem_entries'),
    mem_entries_live: count(db, 'SELECT COUNT(*) n FROM mem_entries WHERE superseded_by IS NULL'),
    // What `SELECT COUNT(*) FROM mem_entries_fts` answers for an external-content
    // FTS5 table is the CONTENT table's count — every entry, superseded included.
    // The count that reflects the INDEX lives in the docsize shadow table, one
    // row per searchable document; measured: after a supersede the content
    // count still says 3 while docsize says 2 and MATCH answers {1,3}.
    mem_entries_fts: count(db, 'SELECT COUNT(*) n FROM mem_entries_fts'),
    mem_entries_fts_indexed: count(db, 'SELECT COUNT(*) n FROM mem_entries_fts_docsize'),
    mem_tasks: count(db, 'SELECT COUNT(*) n FROM mem_tasks'),
    mem_tasks_open: count(db, "SELECT COUNT(*) n FROM mem_tasks WHERE status NOT IN ('done','cancelled')"),
    mem_task_handoffs: count(db, 'SELECT COUNT(*) n FROM mem_task_handoffs'),
  };
}

/// One row, serialized deterministically: column order comes from the SELECT,
/// BLOBs become hex markers so a buffer and its look-alike string differ.
function serializeRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (Buffer.isBuffer(value)) out[key] = { blob: value.toString('hex') };
    else if (typeof value === 'bigint') out[key] = { int: value.toString() };
    else out[key] = value;
  }
  return out;
}

// Every read goes through safe integers. SQLite stores signed 64-bit values, and
// an FTS shadow table carries hashes that use the full width: read as doubles
// they either lose precision silently or, in better-sqlite3, throw RangeError
// mid-export. Both are wrong for a digest whose whole job is to prove the
// content travelled unchanged. BigInt is serialized as a decimal string, so the
// digest is identical on both machines and independent of the host's number
// range. Fixture-sized databases never reach the range — the operator's does.
function readRows(db, sql) {
  const statement = db.prepare(sql);
  statement.setReadBigInts(true);
  return statement.iterate();
}

function digestQuery(db, sql) {
  const hash = crypto.createHash('sha256');
  let rows = 0;
  for (const row of readRows(db, sql)) {
    hash.update(JSON.stringify(serializeRow(row)));
    hash.update('\n');
    rows += 1;
  }
  return { rows, sha256: hash.digest('hex') };
}

/// Per-table digests over EVERY table (FTS shadow tables included) — the
/// version-stable fingerprint of what actually traveled. Byte-level file
//  hashes are deliberately NOT compared across machines: VACUUM output is not
//  byte-stable between SQLite builds, and the logical content is the contract.
function tableDigests(db) {
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all().map((row) => row.name);
  const out = {};
  for (const name of tables) {
    // Tables with rowid order by it; WITHOUT ROWID tables throw and are sorted
    // after serialization instead — same rows, deterministic order either way.
    let digest;
    try {
      digest = digestQuery(db, `SELECT * FROM "${name}" ORDER BY rowid`);
    } catch {
      const rows = [...readRows(db, `SELECT * FROM "${name}"`)]
        .map(serializeRow)
        .sort((left, right) => (JSON.stringify(left) < JSON.stringify(right) ? -1 : 1));
      const hash = crypto.createHash('sha256');
      for (const row of rows) {
        hash.update(JSON.stringify(row));
        hash.update('\n');
      }
      digest = { rows: rows.length, sha256: hash.digest('hex') };
    }
    out[name] = digest;
  }
  return out;
}

function ddlDigest(db) {
  return digestQuery(db, 'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').sha256;
}

function logicalDigest(counts, digests, ddl) {
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(counts));
  hash.update('\n');
  for (const name of Object.keys(digests).sort()) {
    hash.update(`${name}:${digests[name].rows}:${digests[name].sha256}\n`);
  }
  hash.update(`ddl:${ddl}\n`);
  return hash.digest('hex');
}

/// The counts that may only GROW while the export runs. The store is
/// append-only at the row level, so a shrinking total is a lost row. The
/// DERIVED counts (`mem_entries_live`, `mem_tasks_open`, the docsize index
/// count) move both ways - a supersede or a task closed during the export is
/// the writer working, not the export failing.
export const MONOTONE_COUNTS = [
  'mem_entries',
  'mem_tasks',
  'mem_task_handoffs',
  'mem_entries_fts',
];

/// Which monotone counts regressed — the export's own acceptance criterion.
export function lostRows(before, after) {
  return MONOTONE_COUNTS.filter((key) => (after[key] ?? 0) < (before[key] ?? 0));
}

function openTaskIds(db) {
  return db.prepare(
    "SELECT id FROM mem_tasks WHERE status NOT IN ('done','cancelled') ORDER BY id LIMIT 50",
  ).all().map((row) => Number(row.id));
}

function sampleEntry(db) {
  const row = db.prepare(`
    SELECT id, title FROM mem_entries
    WHERE superseded_by IS NULL
    ORDER BY pinned DESC, ts DESC, id DESC LIMIT 1`).get();
  return row ? { id: Number(row.id), title: row.title } : null;
}

/// How many lessons the SOURCE would deliver for the probe path — counted with
/// the store's own matcher under the same gate the service applies (only
/// `status: "active"` rows deliver), so the service probe on the far side
/// compares an expectation the same rules computed.
function lessonsProbe(db) {
  let delivered = 0;
  for (const row of db.prepare(
    "SELECT links FROM mem_entries WHERE kind = 'lesson' AND superseded_by IS NULL",
  ).iterate()) {
    try {
      const links = JSON.parse(row.links);
      if (links?.status === 'active' && lessonMatchesPath(links, LESSONS_PROBE_PATH)) delivered += 1;
    } catch { /* a malformed links blob is not the transfer's business */ }
  }
  return { path: LESSONS_PROBE_PATH, count: delivered };
}

function buildManifest({ snapshotDb, sourceDb, tokenFile, snapshotFile, integrity }) {
  const counts = coreCounts(snapshotDb);
  checkFtsCoversLive(snapshotDb, counts);
  const digests = {
    entries: digestQuery(snapshotDb, 'SELECT * FROM mem_entries ORDER BY id').sha256,
    tasks: digestQuery(snapshotDb, 'SELECT * FROM mem_tasks ORDER BY id').sha256,
    task_handoffs: digestQuery(
      snapshotDb,
      'SELECT * FROM mem_task_handoffs ORDER BY task_id, entry_id',
    ).sha256,
    tables: tableDigests(snapshotDb),
  };
  digests.ddl = ddlDigest(snapshotDb);
  digests.logical = logicalDigest(counts, digests.tables, digests.ddl);
  return {
    tool: 'verify-memory-transfer',
    manifest_version: 1,
    created_at: new Date().toISOString(),
    source_db: sourceDb,
    store_schema_version: SCHEMA_VERSION,
    schema_version: Number(snapshotDb.prepare('PRAGMA user_version').get().user_version),
    integrity_check: integrity.integrity_check,
    foreign_key_violations: integrity.foreign_key_violations,
    counts,
    digests,
    open_task_ids: openTaskIds(snapshotDb),
    sample_entry: sampleEntry(snapshotDb),
    lessons_probe: lessonsProbe(snapshotDb),
    token_sha256: tokenFile ? sha256File(tokenFile) : null,
    snapshot_sha256: snapshotFile ? sha256File(snapshotFile) : null,
  };
}

/// The FTS index must cover exactly the live entries: the docsize shadow holds
/// one row per searchable document, the supersede trigger removes them, so
/// indexed == live is the invariant "FTS соответствует базовым таблицам".
function checkFtsCoversLive(db, counts) {
  if (counts.mem_entries_fts_indexed !== counts.mem_entries_live) {
    throw new Error(
      `FTS does not match the base tables: ${counts.mem_entries_fts_indexed} indexed documents `
      + `against ${counts.mem_entries_live} live entries — rebuild before transferring`,
    );
  }
}

/// Verify a database against a manifest. Returns `{ failures, warnings }`;
/// empty failures = good. The token is verified STRICTLY when it is present or
/// explicitly passed, and warned about when it is nowhere to be found — a
/// tokenless verify still proves the content, it just does not prove the auth.
function verifyAgainstManifest(manifest, dbFile, tokenFile) {
  const failures = [];
  const warnings = [];
  let db;
  try {
    db = openReadonly(dbFile, 'target');
  } catch (error) {
    return { failures: [error.message], warnings };
  }
  try {
    checkIntegrity(db, 'target', failures);
    const version = schemaVersion(db, 'target', failures);
    if (version !== manifest.schema_version) {
      failures.push(`schema version: target v${version} != manifest v${manifest.schema_version}`);
    }
    const counts = coreCounts(db);
    for (const [key, expected] of Object.entries(manifest.counts)) {
      if (counts[key] !== expected) {
        failures.push(`count ${key}: target ${counts[key]} != manifest ${expected}`);
      }
    }
    if (digestQuery(db, 'SELECT * FROM mem_entries ORDER BY id').sha256 !== manifest.digests.entries) {
      failures.push('mem_entries rows differ from the manifest (content hash)');
    }
    if (digestQuery(db, 'SELECT * FROM mem_tasks ORDER BY id').sha256 !== manifest.digests.tasks) {
      failures.push('mem_tasks rows differ from the manifest (content hash)');
    }
    if (digestQuery(db, 'SELECT * FROM mem_task_handoffs ORDER BY task_id, entry_id').sha256
      !== manifest.digests.task_handoffs) {
      failures.push('mem_task_handoffs rows differ from the manifest (content hash)');
    }
    const tables = tableDigests(db);
    const manifestTables = new Set(Object.keys(manifest.digests.tables));
    for (const name of Object.keys(tables)) {
      if (!manifestTables.has(name)) {
        failures.push(`table ${name} exists in the target but not in the manifest`);
        continue;
      }
      const expected = manifest.digests.tables[name];
      if (tables[name].rows !== expected.rows || tables[name].sha256 !== expected.sha256) {
        failures.push(`table ${name}: ${tables[name].rows} rows now vs ${expected.rows} traveled`);
      }
    }
    for (const name of manifestTables) {
      if (!(name in tables)) failures.push(`table ${name} is missing from the target`);
    }
    if (ddlDigest(db) !== manifest.digests.ddl) {
      failures.push('schema objects (DDL) differ from the manifest');
    }
    if (counts.mem_entries_fts_indexed !== counts.mem_entries_live) {
      failures.push(
        `FTS does not match the base tables: ${counts.mem_entries_fts_indexed} indexed documents `
        + `against ${counts.mem_entries_live} live entries`,
      );
    }
  } finally {
    db.close();
  }
  if (manifest.token_sha256 !== null) {
    const sibling = path.join(path.dirname(dbFile), 'memory.token');
    const token = tokenFile ?? (fs.existsSync(sibling) ? sibling : null);
    if (token === null) {
      warnings.push(`no memory.token beside ${dbFile} and none passed — the content is verified, the auth is not`);
    } else if (sha256File(token) !== manifest.token_sha256) {
      failures.push(`token: ${token} does not match the manifest hash`);
    }
  }
  return { failures, warnings };
}

/// Is the memory service answering on `url` right now? Refuses to install
/// under a live writer — the one guarantee the WAL format cannot give us.
function serviceIsLive(url) {
  return new Promise((resolve) => {
    const request = http.get(`${url.replace(/\/$/, '')}/health`, { timeout: 1500 }, (response) => {
      response.resume();
      response.on('end', () => resolve(true));
      response.on('error', () => resolve(true)); // answered SOMETHING: treat as live
    });
    request.on('timeout', () => { request.destroy(); resolve(false); });
    request.on('error', () => resolve(false));
  });
}

function printFailures(failures) {
  console.error(`verify-memory-transfer: ${failures.length} problem(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
}

/// Copy `from` to `to` in verified chunks with fsync, so a completed stage is
/// on disk before anything is verified against it. `MEMORYCTL_TRANSFER_FAULT=midway-copy`
/// aborts after half the bytes — the deterministic stand-in for a transfer
/// killed on the wire, kept for the test that pins "the old database survives".
function stageCopy(from, to) {
  const total = fs.statSync(from).size;
  const read = fs.openSync(from, 'r');
  const write = fs.openSync(to, 'w', 0o600);
  const chunk = 64 * 1024;
  let copied = 0;
  try {
    while (copied < total) {
      const buffer = Buffer.alloc(Math.min(chunk, total - copied));
      const bytes = fs.readSync(read, buffer, 0, buffer.length, copied);
      if (bytes <= 0) throw new Error(`short read at ${copied} of ${total}`);
      fs.writeSync(write, buffer, 0, bytes);
      copied += bytes;
      if (process.env.MEMORYCTL_TRANSFER_FAULT === 'midway-copy' && copied >= total / 2) {
        // Die mid-write, the way a killed copy dies: staged partial file left,
        // destination untouched. NOT success.
        fs.closeSync(write);
        fs.closeSync(read);
        process.exit(74);
      }
    }
    fs.fsyncSync(write);
  } finally {
    try { fs.closeSync(write); } catch { /* already closed on the fault path */ }
    try { fs.closeSync(read); } catch { /* ditto */ }
  }
  return copied;
}

function chmod600(file) {
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

/// Staged siblings from an earlier killed run: swept at the START of an
/// install so a retry after an interruption starts clean.
function sweepStaged(stateDir) {
  for (const name of fs.readdirSync(stateDir)) {
    if (/^memory\.(db|token)\.incoming-/.test(name)) {
      fs.rmSync(path.join(stateDir, name), { force: true });
    }
  }
}

function serviceNames() {
  try {
    const prefix = readHarnessConfig({ repoRoot: REPO }).names.prefix;
    return {
      label: harnessLabel({ prefix, name: 'memoryctl' }),
      taskName: harnessTaskName({ prefix }),
    };
  } catch (error) {
    console.error(`verify-memory-transfer: ${error.message}`);
    process.exit(1);
  }
}

async function emit() {
  const source = resolveDbPath(args.get('source'));
  const exportPath = args.get('export');
  const manifestPath = args.get('emit-manifest');
  if (!source || !exportPath || !manifestPath) usageDie('emit needs --source, --export and --emit-manifest');
  const { taskName } = serviceNames();
  const tokenFile = args.get('token')
    ?? (fs.existsSync(path.join(path.dirname(source), 'memory.token'))
      ? path.join(path.dirname(source), 'memory.token')
      : null);

  const failures = [];
  const live = openReadonly(source, 'source');
  try {
    checkIntegrity(live, 'source', failures);
    schemaVersion(live, 'source', failures);
    if (failures.length) { printFailures(failures); process.exit(1); }

    const before = coreCounts(live);
    // VACUUM INTO is the consistent snapshot: it reads through the live WAL
    // (a read-only connection is allowed to run it) and writes a standalone
    // file — no -wal/-shm needed beside what travels.
    fs.rmSync(exportPath, { force: true });
    live.exec(`VACUUM INTO ${sqlQuote(exportPath)}`);

    const snapshot = openReadonly(exportPath, 'snapshot');
    try {
      const snapshotIntegrity = checkIntegrity(snapshot, 'snapshot', failures);
      if (failures.length) { printFailures(failures); process.exit(1); }
      const after = coreCounts(snapshot);
      for (const key of lostRows(before, after)) {
        failures.push(`the snapshot LOST rows: ${key} went ${before[key]} -> ${after[key]} — nothing may travel like this`);
      }
      if (failures.length) { printFailures(failures); process.exit(1); }
      if (JSON.stringify(after) !== JSON.stringify(before)) {
        console.error('verify-memory-transfer: NOTE the store kept writing during the export.');
        console.error('  The snapshot is a consistent point in time. For the final cutover export,');
        console.error(`  stop the writer first (Scheduled Task ${taskName} / launchd job).`);
      }
      const manifest = buildManifest({
        snapshotDb: snapshot,
        sourceDb: source,
        tokenFile,
        snapshotFile: exportPath,
        integrity: snapshotIntegrity,
      });
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      console.log(`verify-memory-transfer: snapshot ${exportPath}`);
      console.log(`verify-memory-transfer: manifest ${manifestPath}`);
      console.log(`  schema v${manifest.schema_version} (checkout store supports v${SCHEMA_VERSION})`);
      console.log(`  integrity_check=${manifest.integrity_check} foreign_key_violations=${manifest.foreign_key_violations}`);
      console.log(`  counts ${JSON.stringify(manifest.counts)}`);
      console.log(`  logical digest ${manifest.digests.logical.slice(0, 16)}…`);
      console.log(`  open tasks [${manifest.open_task_ids.join(', ')}] sample entry ${
        manifest.sample_entry ? `#${manifest.sample_entry.id}` : '(none)'}`);
      console.log(`  lessons for ${manifest.lessons_probe.path}: ${manifest.lessons_probe.count}`);
    } finally {
      snapshot.close();
    }
  } finally {
    live.close();
  }
}

async function verify() {
  const manifestPath = args.get('source-manifest');
  const target = args.get('target');
  if (!manifestPath || !target) usageDie('verify needs --source-manifest and --target');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const { failures, warnings } = verifyAgainstManifest(manifest, resolveDbPath(target), args.get('token'));
  for (const warning of warnings) console.error(`verify-memory-transfer: WARNING ${warning}`);
  if (failures.length) {
    printFailures(failures);
    process.exit(1);
  }
  console.log(`verify-memory-transfer: target matches the manifest (${manifest.counts.mem_entries} entries, `
    + `${manifest.counts.mem_tasks_open} open tasks, schema v${manifest.schema_version})`);
}

async function install() {
  const manifestPath = args.get('source-manifest');
  const snapshotFile = args.get('snapshot');
  const stateDir = args.get('install-into');
  if (!manifestPath || !snapshotFile || !stateDir) {
    usageDie('install needs --source-manifest, --snapshot and --install-into');
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const serviceUrl = args.get('service-url') ?? DEFAULT_SERVICE_URL;
  const { label, taskName } = serviceNames();

  if (await serviceIsLive(serviceUrl)) {
    console.error(`verify-memory-transfer: the memory service is LIVE at ${serviceUrl}.`);
    console.error('  Installing under a live writer is how one database ends up with two writers:');
    console.error(`  stop the service first (launchctl bootout gui/$(id -u)/${label} on macOS,`);
    console.error(`  Stop-ScheduledTask ${taskName} on Windows), then re-run.`);
    process.exit(1);
  }

  const snapshotSha = sha256File(snapshotFile);
  if (manifest.snapshot_sha256 && snapshotSha !== manifest.snapshot_sha256) {
    console.error(`verify-memory-transfer: snapshot ${snapshotFile} does not match the manifest hash.`);
    console.error('  The file changed in transit — re-copy it from the donor before installing.');
    process.exit(1);
  }

  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(stateDir, 0o700);
  sweepStaged(stateDir);

  const stagedDb = path.join(stateDir, `memory.db.incoming-${process.pid}`);
  const tokenFile = args.get('token');
  const stagedToken = tokenFile ? path.join(stateDir, `memory.token.incoming-${process.pid}`) : null;

  stageCopy(snapshotFile, stagedDb);
  if (tokenFile) stageCopy(tokenFile, stagedToken);

  const { failures } = verifyAgainstManifest(manifest, stagedDb, stagedToken ?? undefined);
  if (failures.length) {
    printFailures(failures);
    console.error('  The staged copy was NOT installed; the previous database is untouched.');
    fs.rmSync(stagedDb, { force: true });
    if (stagedToken) fs.rmSync(stagedToken, { force: true });
    process.exit(1);
  }

  // Commit. The outgoing database's -wal/-shm belong to IT; leaving them next
  // to the new file would be corruption on first open, so they go first —
  // an interruption here leaves the old database readable and un-replaced.
  for (const sidecar of ['memory.db-wal', 'memory.db-shm']) {
    fs.rmSync(path.join(stateDir, sidecar), { force: true });
  }
  fs.renameSync(stagedDb, path.join(stateDir, 'memory.db'));
  chmod600(path.join(stateDir, 'memory.db'));
  if (stagedToken) {
    fs.renameSync(stagedToken, path.join(stateDir, 'memory.token'));
    chmod600(path.join(stateDir, 'memory.token'));
  }

  console.log(`verify-memory-transfer: installed ${path.join(stateDir, 'memory.db')}`);
  console.log(`  ${manifest.counts.mem_entries} entries, ${manifest.counts.mem_tasks_open} open tasks, `
    + `schema v${manifest.schema_version}, verified against ${manifestPath}`);
  if (!tokenFile && manifest.token_sha256) {
    console.error('  WARNING: the manifest carries a token hash but no --token was supplied:');
    console.error('  the service will start, and clients will authenticate against whatever token is');
    console.error('  already there. Pass --token <memory.token> to carry the operator token across.');
  }
  console.log('  Next: start the service, then scripts/probe-memory-service.mjs --manifest <manifest.json>');
}

if (isMainModule) {
  try {
    if (args.has('emit-manifest')) await emit();
    else if (args.has('target')) await verify();
    else if (args.has('install-into')) await install();
    else usageDie('nothing to do');
  } catch (error) {
    console.error(`verify-memory-transfer: ${error?.stack || error}`);
    process.exit(1);
  }
}
