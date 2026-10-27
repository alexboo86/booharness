/**
 * RTK history.db collector for `npm run harness:report`.
 *
 * Reads only. Multiple candidate DBs are first-class: a split between the
 * unix-style state path and LOCALAPPDATA is how metrics went silent for five
 * days (live vs malformed), so absence and corruption are report results, not
 * empty strings.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const TOP_N = 10;

/**
 * @typedef {{ label: string, status: 'ok'|'warn'|'fail', detail: string }} HealthItem
 * @typedef {{ label: string, value: number|string, unit: string|null, note: string|null }} Metric
 * @typedef {{ columns: string[], values: string[][] }} RowTable
 * @typedef {{
 *   id: 'rtk',
 *   title: string,
 *   health: HealthItem[],
 *   metrics: Metric[],
 *   rows: RowTable[],
 *   errors: string[],
 * }} Section
 */

/**
 * Candidate history.db locations, including rtk's platform default when
 * a process ran without RTK_DB_PATH (orch seats before task 1461). Keep this list shared with rtk:split.
 *
 * @param {string} home
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} env
 * @param {string} platform
 * @returns {string[]}
 */
export function candidatePaths(home, env = process.env, platform = process.platform) {
  const out = [];
  const seen = new Set();
  const push = (p) => {
    const resolved = path.resolve(p);
    const key = resolved.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(resolved);
  };

  if (env.RTK_DB_PATH) push(env.RTK_DB_PATH);
  push(path.join(home, '.local', 'state', 'rtk', 'history.db'));
  if (platform === 'darwin') push(path.join(home, 'Library', 'Application Support', 'rtk', 'history.db'));
  if (platform === 'linux') push(path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'rtk', 'history.db'));
  // Keep an explicit LOCALAPPDATA candidate even in a cross-platform fixture.
  if (env.LOCALAPPDATA || platform === 'win32') {
    push(path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'rtk', 'history.db'));
  }
  return out;
}

/** @param {string} filePath */
function toRoUri(filePath) {
  const normalized = path.resolve(filePath).replace(/\\/g, '/');
  // Windows drive paths need file:///C:/... ; unix absolute already starts with /
  const withSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return `file:${withSlash}?mode=ro`;
}

/** @param {unknown} ts */
export function isValidTimestamp(ts) {
  if (typeof ts !== 'string' || !ts.trim()) return false;
  // Reject path-shaped garbage that lexicographic MAX() happily returns.
  if (/[\\/]/.test(ts) && !/^\d{4}-\d{2}-\d{2}/.test(ts)) return false;
  const ms = Date.parse(ts);
  return Number.isFinite(ms);
}

/**
 * Successful rtk routing vs bare/fallback. `rtk fallback:` and `rtk:toml`
 * mean the binary did not filter the command; they count as bare.
 * @param {unknown} rtkCmd
 */
export function isViaRtk(rtkCmd) {
  if (typeof rtkCmd !== 'string') return false;
  if (/^rtk(\.exe)?\s+fallback:/i.test(rtkCmd)) return false;
  return /^rtk(\.exe)?\s+/i.test(rtkCmd);
}

/** First command verb from a shell line (handles `rtk <verb>` and paths). */
export function firstVerb(cmd) {
  if (typeof cmd !== 'string' || !cmd.trim()) return '(empty)';
  let s = cmd.trim();
  // Drop a leading `rtk` / `rtk.exe` so the underlying verb is what we group by.
  const rtkLead = s.match(/^rtk(?:\.exe)?(?:\s+|$)/i);
  if (rtkLead) {
    s = s.slice(rtkLead[0].length).trim();
    if (/^fallback:\s*/i.test(s)) {
      s = s.replace(/^fallback:\s*/i, '');
    }
  }
  const m = s.match(/^([A-Za-z0-9_./\\:-]+)/);
  if (!m) return '(unknown)';
  const base = m[1].replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase();
  return base || '(unknown)';
}

/**
 * @param {string} filePath
 * @returns {{
 *   path: string,
 *   exists: boolean,
 *   status: 'ok'|'malformed'|'missing',
 *   error?: string,
 *   minTs?: string,
 *   maxTs?: string,
 *   minMs?: number,
 *   maxMs?: number,
 *   commandCount?: number,
 * }}
 */
function probeCandidate(filePath) {
  if (!fs.existsSync(filePath)) {
    return { path: filePath, exists: false, status: 'missing' };
  }

  let db;
  try {
    db = new DatabaseSync(toRoUri(filePath), { uri: true });
  } catch (err) {
    return {
      path: filePath,
      exists: true,
      status: 'malformed',
      error: `open failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => String(r.name));
    if (!tables.includes('commands')) {
      return {
        path: filePath,
        exists: true,
        status: 'malformed',
        error: 'missing commands table',
      };
    }

    // Full scan is intentional: MAX(timestamp) on a corrupt column returns a
    // path string and would look like a valid high watermark.
    const rows = db.prepare('SELECT timestamp FROM commands').all();
    let minMs = Infinity;
    let maxMs = -Infinity;
    let minTs = null;
    let maxTs = null;
    let badTs = 0;
    for (const row of rows) {
      const ts = row.timestamp;
      if (!isValidTimestamp(ts)) {
        badTs += 1;
        continue;
      }
      const ms = Date.parse(/** @type {string} */ (ts));
      if (ms < minMs) {
        minMs = ms;
        minTs = /** @type {string} */ (ts);
      }
      if (ms > maxMs) {
        maxMs = ms;
        maxTs = /** @type {string} */ (ts);
      }
    }

    if (rows.length === 0) {
      // Empty but structurally sound — still "readable".
      if (tables.includes('parse_failures')) {
        db.prepare('SELECT COUNT(*) AS n FROM parse_failures').get();
      }
      return {
        path: filePath,
        exists: true,
        status: 'ok',
        commandCount: 0,
      };
    }

    if (badTs > 0 || minTs == null || maxTs == null) {
      return {
        path: filePath,
        exists: true,
        status: 'malformed',
        error:
          badTs > 0
            ? `${badTs} command row(s) have non-date timestamp values (e.g. file paths)`
            : 'no valid command timestamps',
        commandCount: rows.length,
      };
    }

    // parse_failures is part of the schema contract; a disk-image error here
    // is how the LOCALAPPDATA copy surfaces as half-readable.
    if (tables.includes('parse_failures')) {
      db.prepare('SELECT COUNT(*) AS n FROM parse_failures').get();
    }

    return {
      path: filePath,
      exists: true,
      status: 'ok',
      minTs,
      maxTs,
      minMs,
      maxMs,
      commandCount: rows.length,
    };
  } catch (err) {
    return {
      path: filePath,
      exists: true,
      status: 'malformed',
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    try {
      db.close();
    } catch {
      /* already closed / never usable */
    }
  }
}

/**
 * @param {string} filePath
 * @param {number} cutoffMs
 */
function readMetrics(filePath, cutoffMs) {
  const cutoffIso = new Date(cutoffMs).toISOString();
  const db = new DatabaseSync(toRoUri(filePath), { uri: true });
  try {
    const commands = db
      .prepare(
        `SELECT original_cmd, rtk_cmd, timestamp
         FROM commands
         WHERE timestamp >= ?`,
      )
      .all(cutoffIso);

    // Filter again in JS: ISO compare works for well-formed stamps; reject any
    // stragglers that sorted after the cutoff string but are not dates.
    const inWindow = commands.filter((r) => isValidTimestamp(r.timestamp));

    /** @type {Map<string, { bare: number, via: number, pf: number }>} */
    const byVerb = new Map();
    const bump = (verb, field) => {
      let row = byVerb.get(verb);
      if (!row) {
        row = { bare: 0, via: 0, pf: 0 };
        byVerb.set(verb, row);
      }
      row[field] += 1;
    };

    let viaN = 0;
    let bareN = 0;
    /** @type {Record<string, number>} */
    const topVia = Object.create(null);
    /** @type {Record<string, number>} */
    const topBare = Object.create(null);

    for (const row of inWindow) {
      const verb = firstVerb(row.original_cmd);
      if (isViaRtk(row.rtk_cmd)) {
        viaN += 1;
        topVia[verb] = (topVia[verb] || 0) + 1;
        bump(verb, 'via');
      } else {
        bareN += 1;
        topBare[verb] = (topBare[verb] || 0) + 1;
        bump(verb, 'bare');
      }
    }

    let pfRows = [];
    try {
      pfRows = db
        .prepare(
          `SELECT raw_command, timestamp
           FROM parse_failures
           WHERE timestamp >= ?`,
        )
        .all(cutoffIso)
        .filter((r) => isValidTimestamp(r.timestamp));
    } catch (err) {
      // Probe already classified full-db failure; metrics path should still
      // return what commands can give and surface this as a soft error.
      throw new Error(
        `parse_failures unreadable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    /** @type {Record<string, number>} */
    const topPf = Object.create(null);
    for (const row of pfRows) {
      const verb = firstVerb(row.raw_command);
      topPf[verb] = (topPf[verb] || 0) + 1;
      bump(verb, 'pf');
    }

    const rank = (obj) =>
      Object.entries(obj)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, TOP_N);

    const total = inWindow.length;
    const pfN = pfRows.length;
    const viaShare = total === 0 ? null : viaN / total;
    const pfShare = total === 0 ? null : pfN / total;

    const verbRows = [...byVerb.entries()]
      .map(([verb, c]) => ({
        verb,
        bare: c.bare,
        via: c.via,
        pf: c.pf,
        total: c.bare + c.via + c.pf,
      }))
      .sort((a, b) => b.total - a.total || a.verb.localeCompare(b.verb));

    return {
      total,
      viaN,
      bareN,
      viaShare,
      pfN,
      pfShare,
      topVia: rank(topVia),
      topBare: rank(topBare),
      topPf: rank(topPf),
      verbRows,
    };
  } finally {
    db.close();
  }
}

function formatTop(entries) {
  if (!entries.length) return 'none';
  return entries.map(([v, n]) => `${v}:${n}`).join(', ');
}

function pct(share) {
  if (share == null || !Number.isFinite(share)) return 'n/a';
  return `${(share * 100).toFixed(1)}%`;
}

function shortPath(p) {
  const home = os.homedir();
  if (p.startsWith(home)) return `~${p.slice(home.length).replace(/\\/g, '/')}`;
  return p;
}

/**
 * @param {{
 *   days?: number,
 *   home?: string,
 *   env?: NodeJS.ProcessEnv | Record<string, string|undefined>,
 *   platform?: string,
 *   now?: number,
 * }} [options]
 * @returns {Promise<Section>}
 */
export async function collect(options = {}) {
  /** @type {Section} */
  const section = {
    id: 'rtk',
    title: 'RTK command history',
    health: [],
    metrics: [],
    rows: [],
    errors: [],
  };

  try {
    const days = Number.isFinite(options.days) ? Number(options.days) : 7;
    const home = options.home ?? os.homedir();
    const env = options.env ?? process.env;
    const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
    const cutoffMs = now - days * 864e5;

    const paths = candidatePaths(home, env, options.platform);
    const probes = paths.map(probeCandidate);

    /** @type {typeof probes} */
    const live = [];
    for (const probe of probes) {
      const label = `history.db ${shortPath(probe.path)}`;
      if (probe.status === 'missing') {
        // An absent CANDIDATE is the goal, not a fault: since RTK_DB_PATH was
        // pinned outside AppData there is meant to be exactly one history, and
        // every location that stays empty is one fewer place the statistics can
        // split into. Reporting it as a failure would leave this section
        // permanently red over a file that is correctly not there, and a red
        // that never goes green is a red nobody reads. The real failures are
        // handled below and keep their teeth: zero readable databases is a
        // fail, two or more is a warn.
        section.health.push({
          label,
          status: 'ok',
          detail: 'absent — nothing can split here',
        });
        continue;
      }
      if (probe.status === 'malformed') {
        section.health.push({
          label,
          status: 'fail',
          detail: `malformed: ${probe.error ?? 'unreadable'}`,
        });
        section.errors.push(`malformed: ${probe.path} — ${probe.error ?? 'unreadable'}`);
        continue;
      }
      // ok
      live.push(probe);
      const last = probe.maxTs ?? '(empty)';
      section.health.push({
        label,
        status: 'ok',
        detail: `readable; last write ${last}; rows=${probe.commandCount ?? 0}`,
      });
    }

    if (live.length === 0) {
      section.health.push({
        label: 'metrics source',
        status: 'fail',
        detail: 'no readable history.db — metrics not measured',
      });
      // Not one absent candidate but ALL of them: there is no source at all, so
      // say it here rather than per candidate. Silence and a zero must never
      // look alike.
      section.errors.push(
        `no readable rtk history.db among: ${paths.join(', ')} — nothing was measured`,
      );
      section.metrics.push({
        label: 'commands in window',
        value: 'not measured',
        unit: null,
        note: `no readable db in last ${days}d window`,
      });
      return section;
    }

    if (live.length >= 2) {
      const dates = live
        .map((p) => `${shortPath(p.path)} last=${p.maxTs ?? 'empty'}`)
        .join('; ');
      section.health.push({
        label: 'multiple live history.db',
        status: 'warn',
        detail: `${live.length} readable databases — metrics may disagree: ${dates}`,
      });
    }

    // Prefer the freshest readable DB for the numeric section.
    live.sort((a, b) => (b.maxMs ?? -1) - (a.maxMs ?? -1));
    const primary = live[0];

    if (primary.minMs != null && primary.maxMs != null) {
      const spanDays = (primary.maxMs - primary.minMs) / 864e5;
      const spanLabel =
        spanDays < 1
          ? `${(spanDays * 24).toFixed(1)}h`
          : `${spanDays.toFixed(2)}d`;
      section.health.push({
        label: 'data window (live db)',
        status: spanDays + 1e-9 < days ? 'warn' : 'ok',
        detail:
          spanDays + 1e-9 < days
            ? `covers ${spanLabel} (${primary.minTs} → ${primary.maxTs}), shorter than requested ${days}d — metrics look thinner than the window suggests`
            : `covers ${spanLabel} (${primary.minTs} → ${primary.maxTs}) for requested ${days}d`,
      });
    } else {
      section.health.push({
        label: 'data window (live db)',
        status: 'warn',
        detail: 'live db has no timestamped command rows',
      });
    }

    let metrics;
    try {
      metrics = readMetrics(primary.path, cutoffMs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      section.errors.push(`metrics read failed for ${primary.path}: ${msg}`);
      section.health.push({
        label: 'metrics source',
        status: 'fail',
        detail: msg,
      });
      section.metrics.push({
        label: 'commands in window',
        value: 'not measured',
        unit: null,
        note: msg,
      });
      return section;
    }

    section.metrics.push(
      {
        label: 'commands in window',
        value: metrics.total,
        unit: 'count',
        note: `source=${shortPath(primary.path)}; days=${days}`,
      },
      {
        label: 'via rtk',
        value: metrics.viaN,
        unit: 'count',
        note: metrics.viaShare == null ? null : `share ${pct(metrics.viaShare)}`,
      },
      {
        label: 'bare / fallback',
        value: metrics.bareN,
        unit: 'count',
        note:
          metrics.total === 0
            ? null
            : `share ${pct(metrics.bareN / metrics.total)}`,
      },
      {
        label: 'via rtk share',
        value: metrics.viaShare == null ? 'n/a' : Number((metrics.viaShare * 100).toFixed(1)),
        unit: metrics.viaShare == null ? null : '%',
        note: null,
      },
      {
        label: 'parse_failures',
        value: metrics.pfN,
        unit: 'count',
        note:
          metrics.pfShare == null
            ? null
            : `${pct(metrics.pfShare)} of commands in window`,
      },
      {
        label: 'parse_failures share',
        value: metrics.pfShare == null ? 'n/a' : Number((metrics.pfShare * 100).toFixed(1)),
        unit: metrics.pfShare == null ? null : '%',
        note: 'should fall after gate fixes; spike means rewrites still miss',
      },
      {
        label: 'top bare verbs',
        value: formatTop(metrics.topBare),
        unit: null,
        note: null,
      },
      {
        label: 'top via-rtk verbs',
        value: formatTop(metrics.topVia),
        unit: null,
        note: null,
      },
      {
        label: 'top parse_failures verbs',
        value: formatTop(metrics.topPf),
        unit: null,
        note: null,
      },
    );

    section.rows.push({
      columns: ['verb', 'bare', 'via rtk', 'parse_failures'],
      values: metrics.verbRows.map((r) => [
        r.verb,
        String(r.bare),
        String(r.via),
        String(r.pf),
      ]),
    });

    return section;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    section.errors.push(`collect failed: ${msg}`);
    section.health.push({
      label: 'collector',
      status: 'fail',
      detail: msg,
    });
    return section;
  }
}
