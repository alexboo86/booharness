import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { harnessPaths, readHarnessConfig } from '../lib/harness-config.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const CLOSED_TASK_STATUSES = new Set(['done', 'cancelled']);
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const EXPECTED_TABLES = ['mem_entries', 'mem_tasks', 'mem_task_handoffs'];
const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function emptySection() {
  return {
    id: 'memory',
    title: 'Memory',
    health: [],
    metrics: [],
    rows: [],
    errors: [],
  };
}

function detail(error) {
  return error instanceof Error ? error.message : String(error);
}

function fail(section, label, error) {
  const message = detail(error);
  section.health.push({ label, status: 'fail', detail: message });
  section.errors.push(`${label}: ${message}`);
}

function metric(label, value, unit, note = null) {
  return { label, value, unit, note };
}

async function probeService(section, options) {
  const label = 'Memory service';
  try {
    const serviceUrl = String(options.serviceUrl ?? 'http://127.0.0.1:7717').replace(/\/+$/, '');
    const timeoutMs = Number.isFinite(Number(options.healthTimeoutMs))
      ? Math.max(1, Number(options.healthTimeoutMs))
      : 2_000;
    const response = await fetch(`${serviceUrl}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`GET /health returned HTTP ${response.status}`);
    const body = await response.json();
    if (body?.ok !== true || body?.service !== 'memoryctl') {
      throw new Error(`GET /health returned an unexpected payload: ${JSON.stringify(body)}`);
    }
    section.health.push({
      label,
      status: 'ok',
      detail: `HTTP ${response.status}, service=${body.service}`,
    });
  } catch (error) {
    fail(section, label, error);
  }
}

function probeInstalledCopy(section, repositoryStorePath, installedStorePath) {
  const label = 'Installed service copy';
  try {
    const repository = fs.readFileSync(repositoryStorePath);
    const installed = fs.readFileSync(installedStorePath);
    if (!repository.equals(installed)) {
      section.health.push({
        label,
        status: 'warn',
        detail: 'правка в репозитории не доехала до сервиса, нужен npm run install:memory + рестарт',
      });
      return;
    }
    section.health.push({
      label,
      status: 'ok',
      detail: `matches ${path.relative(path.dirname(repositoryStorePath), installedStorePath)}`,
    });
  } catch (error) {
    fail(section, label, error);
  }
}

function openReadOnly(databasePath) {
  const url = pathToFileURL(path.resolve(databasePath));
  url.searchParams.set('mode', 'ro');
  // Importing openMemoryDb would create a token and run migrations; the report must never repair its subject.
  return new DatabaseSync(url.href, { uri: true });
}

function tableNames(db) {
  return new Set(
    db.prepare('PRAGMA table_list').all()
      .filter((row) => row.type === 'table')
      .map((row) => row.name),
  );
}

function parseDependencies(row) {
  let dependencies;
  try {
    dependencies = JSON.parse(row.depends_on);
  } catch (error) {
    throw new Error(`task ${row.id} has invalid depends_on JSON: ${detail(error)}`);
  }
  if (!Array.isArray(dependencies)) throw new Error(`task ${row.id} depends_on is not an array`);
  return dependencies;
}

function parseLessonLinks(row) {
  let links;
  try {
    links = JSON.parse(row.links);
  } catch (error) {
    throw new Error(`lesson ${row.id} has invalid links JSON: ${detail(error)}`);
  }
  if (!links || typeof links !== 'object' || Array.isArray(links)) {
    throw new Error(`lesson ${row.id} links is not an object`);
  }
  if (typeof links.domain !== 'string' || !links.domain.trim()) {
    throw new Error(`lesson ${row.id} has no domain`);
  }
  if (typeof links.anchor !== 'string' || !links.anchor.trim()) {
    throw new Error(`lesson ${row.id} has no anchor`);
  }
  if (!['active', 'inbox', 'retired'].includes(links.status)) {
    throw new Error(`lesson ${row.id} has invalid status ${JSON.stringify(links.status)}`);
  }
  return links;
}

function anchorPath(anchor) {
  const separator = anchor.indexOf(':');
  return separator === -1 ? anchor : anchor.slice(0, separator);
}

function isGlob(value) {
  return /[*?[]/.test(value);
}

function isOrphan(repoRoot, anchor, lessonId) {
  const repoPath = anchorPath(anchor);
  if (isGlob(repoPath)) return false;
  const segments = repoPath.split('/');
  if (!repoPath
    || repoPath.includes('\\')
    || path.posix.isAbsolute(repoPath)
    || /^[A-Za-z]:\//.test(repoPath)
    || segments.includes('..')) {
    throw new Error(`lesson ${lessonId} has unsafe anchor ${JSON.stringify(anchor)}`);
  }
  try {
    return !fs.statSync(path.join(repoRoot, ...segments)).isFile();
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
}

function collectDatabase(databasePath, repoRoot, days, now) {
  let db;
  try {
    db = openReadOnly(databasePath);
    const tables = tableNames(db);
    const missing = EXPECTED_TABLES.filter((table) => !tables.has(table));
    if (missing.length) throw new Error(`missing expected table(s): ${missing.join(', ')}`);

    const quickCheck = db.prepare('PRAGMA quick_check').all();
    if (quickCheck.length !== 1 || quickCheck[0].quick_check !== 'ok') {
      throw new Error(`PRAGMA quick_check failed: ${JSON.stringify(quickCheck)}`);
    }

    const cutoff = now - (days * DAY_MS);
    const entryCounts = new Map(
      db.prepare('SELECT kind, COUNT(*) AS count FROM mem_entries WHERE ts >= ? GROUP BY kind')
        .all(cutoff)
        .map((row) => [row.kind, Number(row.count)]),
    );
    const otherEntries = [...entryCounts.entries()]
      .filter(([kind]) => !['handoff', 'lesson', 'feedback'].includes(kind))
      .reduce((sum, [, count]) => sum + count, 0);
    const windowNote = `last ${days} day${days === 1 ? '' : 's'}`;
    const metrics = [
      metric('Entries: handoff', entryCounts.get('handoff') ?? 0, 'entries', windowNote),
      metric('Entries: lesson', entryCounts.get('lesson') ?? 0, 'entries', windowNote),
      metric('Entries: feedback', entryCounts.get('feedback') ?? 0, 'entries', windowNote),
      metric('Entries: other', otherEntries, 'entries', windowNote),
    ];

    // Who is actually writing. The MCP wrapper was deferred behind exactly this
    // number — "do the MEMBERS write memory, or only the lead?" — and it could
    // not be taken before, because nothing recorded an author. Every MCP write
    // now carries the calling client's name, so the question is answerable by
    // query rather than by argument.
    //
    // `agent` is reported verbatim, never bucketed into "lead" and "member":
    // the mapping from a client name to a role is a guess, and a guess printed
    // as a measurement is how this report would start lying.
    // A store written before authorship existed has no such column, and a
    // report that dies on the whole section over one optional breakdown is
    // worse than one that says the breakdown is unavailable.
    const hasAgent = db.prepare('PRAGMA table_info(mem_entries)')
      .all()
      .some((column) => column.name === 'agent');
    let writerRows = [];
    if (!hasAgent) {
      metrics.push(metric('Writers', 'not recorded', null, 'mem_entries has no agent column'));
    } else {
      const writers = db.prepare(
        'SELECT COALESCE(NULLIF(TRIM(agent), \'\'), \'\') AS agent, '
        + 'COUNT(*) AS count FROM mem_entries WHERE ts >= ? GROUP BY agent ORDER BY count DESC',
      ).all(cutoff);
      writerRows = writers.map((row) => [row.agent || '(empty)', String(row.count)]);
      // `unknown` is the CLI's own placeholder when MEMORYCTL_AGENT_ID is unset
      // (memoryctl:25), so counting only the empty string would report 2%
      // blindness where the real figure is three quarters. A placeholder is not
      // an author.
      const anonymous = writers
        .filter((row) => !row.agent || row.agent === 'unknown')
        .reduce((sum, row) => sum + Number(row.count), 0);
      const totalWrites = writers.reduce((sum, row) => sum + Number(row.count), 0);
      metrics.push(
        metric('Distinct writers', writers.length, 'agents', windowNote),
        metric(
          'Writes with no author',
          anonymous,
          'entries',
          totalWrites
            ? `${Math.round((anonymous / totalWrites) * 100)}% — counts '' and 'unknown', the CLI placeholder; these cannot answer "members or lead"`
            : 'nothing written in the window',
        ),
      );
    }

    const tasks = db.prepare(
      'SELECT id, priority, status, claimed_by, depends_on FROM mem_tasks ORDER BY id',
    ).all();
    const tasksById = new Map(tasks.map((row) => [Number(row.id), row]));
    const openByPriority = Object.fromEntries(PRIORITIES.map((priority) => [priority, 0]));
    const readyByPriority = Object.fromEntries(PRIORITIES.map((priority) => [priority, 0]));
    for (const row of tasks) {
      const dependencies = parseDependencies(row);
      if (CLOSED_TASK_STATUSES.has(row.status)) continue;
      if (!PRIORITIES.includes(row.priority)) {
        throw new Error(`open task ${row.id} has unexpected priority ${JSON.stringify(row.priority)}`);
      }
      openByPriority[row.priority] += 1;
      const ready = row.status === 'open'
        && row.claimed_by === null
        && dependencies.every((id) => {
          const blocker = tasksById.get(Number(id));
          return !blocker || CLOSED_TASK_STATUSES.has(blocker.status);
        });
      if (ready) readyByPriority[row.priority] += 1;
    }
    for (const priority of PRIORITIES) {
      metrics.push(metric(`Open tasks: ${priority}`, openByPriority[priority], 'tasks'));
      metrics.push(metric(`Ready tasks: ${priority}`, readyByPriority[priority], 'tasks'));
    }

    const lessonRows = db.prepare(
      'SELECT id, links FROM mem_entries WHERE kind = ? AND superseded_by IS NULL ORDER BY id',
    ).all('lesson');
    const domains = new Map();
    for (const row of lessonRows) {
      const links = parseLessonLinks(row);
      if (links.status !== 'active') continue;
      const domain = links.domain.trim();
      const current = domains.get(domain) ?? { active: 0, orphans: 0 };
      current.active += 1;
      if (isOrphan(repoRoot, links.anchor, row.id)) current.orphans += 1;
      domains.set(domain, current);
    }
    const domainRows = [...domains.entries()].sort(([left], [right]) => left.localeCompare(right));
    const activeTotal = domainRows.reduce((sum, [, counts]) => sum + counts.active, 0);
    const orphanTotal = domainRows.reduce((sum, [, counts]) => sum + counts.orphans, 0);
    metrics.push(metric('Active lessons', activeTotal, 'lessons'));
    for (const [domain, counts] of domainRows) {
      metrics.push(metric(`Active lessons: ${domain}`, counts.active, 'lessons'));
    }
    metrics.push(metric('Orphan lesson anchors', orphanTotal, 'lessons'));

    return {
      metrics,
      rows: [
        {
          columns: ['Domain', 'Active lessons', 'Orphans'],
          values: domainRows.map(([domain, counts]) => [
            domain,
            String(counts.active),
            String(counts.orphans),
          ]),
        },
        // Only when there is something to show: an empty table is noise, and a
        // store with no agent column has nothing to say here at all.
        ...(writerRows.length ? [{ columns: ['Writer (agent)', 'Entries'], values: writerRows }] : []),
      ],
      healthDetail: `${databasePath}; quick_check=ok; tables=${EXPECTED_TABLES.join(',')}`,
    };
  } finally {
    db?.close();
  }
}

/** @returns {Promise<object>} */
export async function collect(options = {}) {
  const section = emptySection();
  const input = options && typeof options === 'object' ? options : {};
  const homeDir = input.homeDir ?? os.homedir();
  const repoRoot = path.resolve(input.repoRoot ?? DEFAULT_REPO_ROOT);
  const stateDir = input.stateDir
    ?? process.env.MEMORYCTL_STATE_DIR
    ?? path.join(homeDir, '.local', 'state', 'memoryctl');
  const repositoryStorePath = input.repositoryStorePath
    ?? path.join(repoRoot, 'scripts', 'memory', 'store.mjs');
  const databasePath = input.databasePath ?? path.join(stateDir, 'memory.db');
  const requestedDays = Number(input.days ?? 7);
  const days = Number.isFinite(requestedDays) && requestedDays > 0 ? Math.floor(requestedDays) : 7;
  const requestedNow = Number(input.now ?? Date.now());
  const now = Number.isFinite(requestedNow) ? requestedNow : Date.now();

  await probeService(section, input);
  try {
    const installedStorePath = input.installedStorePath ?? path.join(
      harnessPaths({ prefix: readHarnessConfig({ repoRoot }).names.prefix, home: homeDir }).shareDir,
      'scripts', 'memory', 'store.mjs',
    );
    probeInstalledCopy(section, repositoryStorePath, installedStorePath);
  } catch (error) {
    fail(section, 'Installed service copy', error);
  }
  try {
    const database = collectDatabase(databasePath, repoRoot, days, now);
    section.metrics.push(...database.metrics);
    section.rows.push(...database.rows);
    section.health.push({ label: 'Memory database', status: 'ok', detail: database.healthDetail });
  } catch (error) {
    fail(section, 'Memory database', error);
  }
  return section;
}
