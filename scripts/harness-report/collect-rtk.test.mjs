import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { candidatePaths, collect } from './collect-rtk.mjs';

test('candidate paths include override, state path and each platform default without duplicates', () => {
  const home = path.join(os.tmpdir(), 'rtk-candidates');
  const state = path.join(home, '.local', 'state', 'rtk', 'history.db');
  assert.deepEqual(candidatePaths(home, { RTK_DB_PATH: state }, 'darwin'), [
    state, path.join(home, 'Library', 'Application Support', 'rtk', 'history.db'),
  ]);
  assert.deepEqual(candidatePaths(home, {}, 'win32'), [
    state, path.join(home, 'AppData', 'Local', 'rtk', 'history.db'),
  ]);
  assert.deepEqual(candidatePaths(home, { XDG_DATA_HOME: path.join(home, 'xdg') }, 'linux'), [
    state, path.join(home, 'xdg', 'rtk', 'history.db'),
  ]);
});

function emptyEnv(home) {
  const localAppData = path.join(home, 'AppData', 'Local');
  fs.mkdirSync(localAppData, { recursive: true });
  return {
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: localAppData,
  };
}

test('collect reads the macOS default DB when RTK_DB_PATH is absent', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-rtk-macos-'));
  try {
    const dbPath = path.join(home, 'Library', 'Application Support', 'rtk', 'history.db');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE commands (timestamp TEXT, original_cmd TEXT, rtk_cmd TEXT, project_path TEXT);
      CREATE TABLE parse_failures (timestamp TEXT, raw_command TEXT);
      INSERT INTO commands VALUES ('2026-08-01T10:00:00.000Z', 'git status', 'rtk git status', '/proj');
    `);
    db.close();
    const section = await collect({ home, env: {}, platform: 'darwin', days: 1, now: Date.parse('2026-08-01T12:00:00Z') });
    assert.equal(section.metrics.find((m) => m.label === 'commands in window')?.value, 1);
    assert.ok(section.health.some((h) => h.label.includes(dbPath) && h.status === 'ok'));
    assert.deepEqual(section.errors, []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('collect never throws and reports errors when no rtk history.db exists', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-rtk-empty-'));
  try {
    const section = await collect({ home, env: emptyEnv(home), days: 7 });
    assert.equal(section.id, 'rtk');
    assert.equal(typeof section.title, 'string');
    assert.ok(section.title.length > 0);
    assert.ok(Array.isArray(section.health));
    assert.ok(Array.isArray(section.metrics));
    assert.ok(Array.isArray(section.rows));
    assert.ok(Array.isArray(section.errors));
    assert.ok(
      section.errors.length > 0,
      'missing sources must surface as non-empty errors, not silence',
    );
    assert.ok(
      section.health.some((h) => h.status === 'fail'),
      'missing history.db must produce health status fail',
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('collect marks a readable live db ok and a path-in-timestamp db malformed', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-rtk-mixed-'));
  try {
    const env = emptyEnv(home);
    const livePath = path.join(home, '.local', 'state', 'rtk', 'history.db');
    const deadPath = path.join(env.LOCALAPPDATA, 'rtk', 'history.db');
    fs.mkdirSync(path.dirname(livePath), { recursive: true });
    fs.mkdirSync(path.dirname(deadPath), { recursive: true });

    const live = new DatabaseSync(livePath);
    live.exec(`
      CREATE TABLE commands (
        id INTEGER PRIMARY KEY,
        timestamp TEXT,
        original_cmd TEXT,
        rtk_cmd TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        saved_tokens INTEGER,
        savings_pct REAL,
        exec_time_ms INTEGER,
        project_path TEXT
      );
      CREATE TABLE parse_failures (
        id INTEGER PRIMARY KEY,
        timestamp TEXT,
        raw_command TEXT,
        error_message TEXT,
        fallback_succeeded INTEGER
      );
      INSERT INTO commands (timestamp, original_cmd, rtk_cmd, input_tokens, output_tokens, saved_tokens, savings_pct, exec_time_ms, project_path)
      VALUES
        ('2026-08-01T10:00:00.000Z', 'git status', 'rtk git status', 10, 4, 6, 60, 5, '/proj'),
        ('2026-08-01T12:00:00.000Z', 'sed -n 1p f', 'rtk fallback: sed -n 1p f', 0, 0, 0, 0, 3, '/proj'),
        ('2026-08-02T08:00:00.000Z', 'rg foo', 'rtk rg foo', 20, 5, 15, 75, 8, '/proj');
      INSERT INTO parse_failures (timestamp, raw_command, error_message, fallback_succeeded)
      VALUES
        ('2026-08-01T12:00:00.000Z', 'sed -n 1p f', 'unrecognized subcommand', 1);
    `);
    live.close();

    const dead = new DatabaseSync(deadPath);
    dead.exec(`
      CREATE TABLE commands (
        id INTEGER PRIMARY KEY,
        timestamp TEXT,
        original_cmd TEXT,
        rtk_cmd TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        saved_tokens INTEGER,
        savings_pct REAL,
        exec_time_ms INTEGER,
        project_path TEXT
      );
      CREATE TABLE parse_failures (
        id INTEGER PRIMARY KEY,
        timestamp TEXT,
        raw_command TEXT,
        error_message TEXT,
        fallback_succeeded INTEGER
      );
      INSERT INTO commands (timestamp, original_cmd, rtk_cmd, input_tokens, output_tokens, saved_tokens, savings_pct, exec_time_ms, project_path)
      VALUES
        ('2026-07-28T11:00:00.000Z', 'git status', 'rtk git status', 1, 1, 0, 0, 1, '/old'),
        ('\\\\?\\D:\\bad\\path', 'node x', 'rtk node x', 1, 1, 0, 0, 1, '/old');
    `);
    dead.close();

    const section = await collect({
      home,
      env,
      days: 7,
      now: Date.parse('2026-08-02T12:00:00.000Z'),
    });

    assert.equal(section.id, 'rtk');
    assert.ok(section.health.some((h) => h.status === 'ok' && /live|readable|ok/i.test(h.label + h.detail)));
    assert.ok(
      section.health.some((h) => h.status === 'fail' && /malformed/i.test(h.label + h.detail)),
      'path-in-timestamp candidate must be health fail/malformed',
    );
    assert.ok(
      section.errors.some((e) => /malformed/i.test(e)),
      'malformed candidate must appear in errors',
    );

    const total = section.metrics.find((m) => /total commands|commands in window/i.test(m.label));
    assert.ok(total, 'must report total commands in window');
    assert.equal(total.value, 3);

    const pf = section.metrics.find((m) => /parse_failures/i.test(m.label) && !/share|rate|%|top/i.test(m.label));
    assert.ok(pf, 'must report parse_failures count');
    assert.equal(pf.value, 1);

    assert.ok(section.rows.length >= 1, 'must include verb breakdown table');
    const table = section.rows[0];
    assert.deepEqual(table.columns, ['verb', 'bare', 'via rtk', 'parse_failures']);
    const byVerb = Object.fromEntries(table.values.map((row) => [row[0], row]));
    assert.ok(byVerb.git, 'git verb present');
    assert.equal(byVerb.git[1], '0');
    assert.equal(byVerb.git[2], '1');
    assert.ok(byVerb.sed, 'sed verb present');
    assert.equal(byVerb.sed[1], '1');
    assert.equal(byVerb.sed[3], '1');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('collect warns when live data window is shorter than requested days', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-rtk-short-'));
  try {
    const env = emptyEnv(home);
    // Only unix-style candidate so dual-db noise does not mask the short-window warn.
    delete env.LOCALAPPDATA;
    const livePath = path.join(home, '.local', 'state', 'rtk', 'history.db');
    fs.mkdirSync(path.dirname(livePath), { recursive: true });
    const live = new DatabaseSync(livePath);
    live.exec(`
      CREATE TABLE commands (
        id INTEGER PRIMARY KEY,
        timestamp TEXT,
        original_cmd TEXT,
        rtk_cmd TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        saved_tokens INTEGER,
        savings_pct REAL,
        exec_time_ms INTEGER,
        project_path TEXT
      );
      CREATE TABLE parse_failures (
        id INTEGER PRIMARY KEY,
        timestamp TEXT,
        raw_command TEXT,
        error_message TEXT,
        fallback_succeeded INTEGER
      );
      INSERT INTO commands (timestamp, original_cmd, rtk_cmd, input_tokens, output_tokens, saved_tokens, savings_pct, exec_time_ms, project_path)
      VALUES
        ('2026-08-01T10:00:00.000Z', 'git status', 'rtk git status', 1, 1, 0, 0, 1, '/p'),
        ('2026-08-02T10:00:00.000Z', 'git log', 'rtk git log', 1, 1, 0, 0, 1, '/p');
    `);
    live.close();

    const section = await collect({
      home,
      env,
      days: 7,
      now: Date.parse('2026-08-02T12:00:00.000Z'),
    });

    assert.ok(
      section.health.some(
        (h) =>
          h.status === 'warn' &&
          /shorter|less than|covers|window/i.test(`${h.label} ${h.detail}`),
      ),
      'short data window must warn that metrics cover less than requested days',
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
