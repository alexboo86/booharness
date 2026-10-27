#!/usr/bin/env node
// Run a command, or take a screenshot, in the logged-on user's interactive desktop session on Windows.
// An ssh process lives in session 0 (no desktop, a fake 1024x768 screen), so the command is handed to a
// one-shot Task Scheduler task with an interactive token (/IT), which starts it in the user's own session.
//
//   node desktop-run.mjs run [--timeout s] [--detach] -- <command...>
//   node desktop-run.mjs screenshot <out.png>
//   node desktop-run.mjs sweep
//
// The command travels as a JSON file (no cmd.exe quoting); stdout/stderr come back through files.
//
// Run it under remote-exec (ops/orchestrator/remote-exec.mjs) or another caller that stays attached:
// when the connection drops, remote-exec sees stdin EOF and kills its tree with taskkill /T /F, which
// ends this controller without running any handler. Cleanup therefore does not depend on the controller:
// each run lives in %TEMP%\desktop-run-XXXXXX, and its task has the same name. The runner inside the task
// kills the command at the deadline and tears the run down once the controller pid is gone; every
// invocation, and `sweep`, removes runs whose controller is gone or whose deadline has passed.
//
// A bare `ssh windows-host node desktop-run.mjs ...` whose client dies is not covered beyond the deadline: Windows
// sshd keeps that session's processes, this controller included, alive, so no process check can tell the
// caller is gone. The runner's deadline (--timeout, default 600 s) is the only bound there.
//
// --detach takes no deadline: the app is meant to outlive the call, and the caller owns it through the
// printed pid. The run directory and the task are still removed as soon as the pid is known.
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
const PREFIX = 'desktop-run-';
const START_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEOUT_S = 600;
const SCREENSHOT_TIMEOUT_S = 120;
const TIMEOUT_EXIT = 124;
// A run directory still without controller.json after this long was abandoned during setup.
const SETUP_GRACE_MS = 60_000;
const WATCH_INTERVAL_MS = 1_000;

// Progress records would reach stderr as CLIXML under -EncodedCommand.
const SCREENSHOT_PS1 = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ((Get-Process -Id $PID).SessionId -eq 0) { throw 'screenshot is running in session 0, which has no desktop' }
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class DesktopRunDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'
[DesktopRunDpi]::SetProcessDPIAware() | Out-Null
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output ('{0} {1}x{2}' -f $Out, $b.Width, $b.Height)
`;

function fail(message) {
  console.error(`desktop-run: ${message}`);
  process.exit(2);
}

function usage() {
  fail('usage: desktop-run.mjs run [--timeout s] [--detach] -- <command...> | screenshot <out.png> | sweep');
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function schtasks(args) {
  const result = spawnSync('schtasks.exe', args, { encoding: 'utf8', windowsHide: true });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

// USERDOMAIN reads WORKGROUP inside an ssh session, so ask whoami for the account name.
function currentUser() {
  const result = spawnSync('whoami.exe', [], { encoding: 'utf8', windowsHide: true });
  const user = result.stdout?.trim();
  if (result.status !== 0 || !user) fail(`whoami failed: ${result.stderr || result.error?.message}`);
  return user;
}

// The task can only start in a session the user is logged on to at a desktop; explorer.exe marks one.
function interactiveSessions(user) {
  const result = spawnSync('tasklist.exe', ['/FI', 'IMAGENAME eq explorer.exe', '/FI', `USERNAME eq ${user}`, '/FO', 'CSV', '/NH'],
    { encoding: 'latin1', windowsHide: true });
  if (result.status !== 0) fail(`tasklist failed: ${result.stderr || result.stdout}`);
  return result.stdout.split(/\r?\n/)
    .map((line) => line.match(/^"explorer\.exe","\d+","[^"]*","(\d+)"/i))
    .filter(Boolean)
    .map((match) => Number(match[1]))
    .filter((session) => session !== 0);
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// The call is over when its controller is gone.
function callGone(controller) {
  return !alive(controller.pid);
}

function killTree(pid) {
  if (Number.isInteger(pid) && pid > 0) spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
}

// Ends a run whatever state it is in: the command tree, the runner, the task, the directory.
// Pids are killed only while exit.json is absent, so a finished run's recycled pid is never touched.
// The runner tears its own run down with endTask false: /End would kill the runner itself.
// Its /Delete is refused (access denied from the interactive token), so the next sweep removes the task.
function teardown(dir, { killCommand, endTask = true }) {
  if (killCommand && !existsSync(join(dir, 'exit.json'))) {
    killTree(readJson(join(dir, 'pid.json'))?.pid);
    killTree(readJson(join(dir, 'runner.json'))?.pid);
  }
  const task = basename(dir);
  if (schtasks(['/Query', '/TN', task]).status === 0) {
    if (endTask) schtasks(['/End', '/TN', task]);
    schtasks(['/Delete', '/TN', task, '/F']);
  }
  rmSync(dir, { recursive: true, force: true });
}

function isStale(dir, now = Date.now()) {
  const controller = readJson(join(dir, 'controller.json'));
  if (!controller) {
    try { return now - statSync(dir).mtimeMs > SETUP_GRACE_MS; } catch { return true; }
  }
  if (controller.pid === process.pid) return false;
  return callGone(controller) || (controller.deadline !== null && now > controller.deadline + WATCH_INTERVAL_MS * 5);
}

// Removes every run whose controller is gone or whose deadline has passed, and its task.
function sweep() {
  const swept = [];
  const listed = schtasks(['/Query', '/FO', 'CSV', '/NH']);
  const tasks = new Set([...listed.output.matchAll(/^"\\(desktop-run-[^"\\]+)"/gm)].map((match) => match[1]));
  const dirs = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith(PREFIX)));
  for (const name of new Set([...tasks, ...dirs])) {
    const dir = join(tmpdir(), name);
    if (dirs.has(name) && !isStale(dir)) continue;
    const job = readJson(join(dir, 'job.json'));
    teardown(dir, { killCommand: !job?.detach });
    swept.push(name);
  }
  return swept;
}

// Runs inside the interactive session, started by the task: spawn the job, record pid and exit,
// kill it at the deadline, and tear the run down if the controller dies.
function runner(dir) {
  const job = readJson(join(dir, 'job.json'));
  const controller = readJson(join(dir, 'controller.json'));
  const write = (name, value) => writeFileSync(join(dir, name), JSON.stringify(value));
  if (!job || !controller) return write('exit.json', { error: 'job.json or controller.json is missing or invalid' });
  write('runner.json', { pid: process.pid });
  let proc;
  try {
    if (job.detach) {
      proc = spawn(job.command, job.args, { cwd: job.cwd, detached: true, stdio: 'ignore' });
    } else {
      const out = openSync(join(dir, 'stdout'), 'w');
      const err = openSync(join(dir, 'stderr'), 'w');
      proc = spawn(job.command, job.args, { cwd: job.cwd, stdio: ['ignore', out, err] });
      closeSync(out);
      closeSync(err);
    }
  } catch (error) {
    return write('exit.json', { error: error.message });
  }
  proc.on('error', (error) => write('exit.json', { error: error.message }));
  proc.on('spawn', () => {
    write('pid.json', { pid: proc.pid });
    if (job.detach) {
      proc.unref();
      write('exit.json', { code: 0 });
    }
  });
  if (job.detach) return;

  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    killTree(proc.pid);
  }, Math.max(0, controller.deadline - Date.now()));
  const watch = setInterval(() => {
    if (!callGone(controller)) return;
    clearInterval(watch);
    clearTimeout(deadline);
    killTree(proc.pid);
    teardown(dir, { killCommand: false, endTask: false });
    process.exit(1);
  }, WATCH_INTERVAL_MS);
  proc.on('exit', (code, signal) => {
    clearTimeout(deadline);
    clearInterval(watch);
    write('exit.json', timedOut ? { timedOut: true } : { code, signal });
  });
}

async function runInSession(job, timeoutS) {
  if (process.platform !== 'win32') fail('desktop-run works only on Windows');
  sweep();
  const user = currentUser();
  const sessions = interactiveSessions(user);
  if (sessions.length === 0) {
    fail(`no interactive desktop session for ${user} (no explorer.exe outside session 0); refusing to run in session 0`);
  }

  const dir = mkdtempSync(join(tmpdir(), PREFIX));
  const task = basename(dir);
  const deadline = job.detach ? null : Date.now() + timeoutS * 1000;
  let pid = null;
  let done = false;
  const cleanup = (killCommand) => {
    if (done) return;
    done = true;
    teardown(dir, { killCommand });
  };
  const abort = (signal) => {
    cleanup(!job.detach);
    process.exit(128 + (signal === 'SIGINT' ? 2 : 15));
  };
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  process.on('SIGHUP', abort);

  try {
    writeFileSync(join(dir, 'job.json'), JSON.stringify(job));
    writeFileSync(join(dir, 'controller.json'), JSON.stringify({ pid: process.pid, deadline }));
    // conhost --headless keeps node's console window off the operator's desktop.
    const action = `conhost.exe --headless "${process.execPath}" "${SCRIPT}" _runner "${dir}"`;
    if (action.length > 261) throw new Error(`task action is ${action.length} characters, schtasks allows 261: ${action}`);
    const created = schtasks(['/Create', '/TN', task, '/TR', action, '/SC', 'ONCE', '/ST', '00:00', '/IT', '/RU', user, '/F']);
    if (created.status !== 0) throw new Error(`schtasks /Create failed: ${created.output}`);
    const started = schtasks(['/Run', '/TN', task]);
    if (started.status !== 0) throw new Error(`schtasks /Run failed: ${started.output}`);

    const startDeadline = Date.now() + START_TIMEOUT_MS;
    let exit = null;
    for (;;) {
      exit = readJson(join(dir, 'exit.json'));
      pid ??= readJson(join(dir, 'pid.json'))?.pid ?? null;
      if (exit) break;
      if (!pid && Date.now() > startDeadline) {
        const query = schtasks(['/Query', '/TN', task, '/V', '/FO', 'LIST']);
        throw new Error(`task did not start the command within ${START_TIMEOUT_MS / 1000}s in session ${sessions.join(',')}:\n${query.output}`);
      }
      // The runner kills the command at the deadline; this is the backstop if the runner is gone.
      if (deadline !== null && Date.now() > deadline + WATCH_INTERVAL_MS * 5) {
        exit = { timedOut: true };
        break;
      }
      await sleep(200);
    }
    if (exit.error) throw new Error(`command did not start: ${exit.error}`);
    if (job.detach) {
      console.log(pid);
      return 0;
    }
    relay(dir);
    if (exit.timedOut) {
      console.error(`desktop-run: timed out after ${timeoutS}s; killed pid ${pid}`);
      return TIMEOUT_EXIT;
    }
    if (exit.signal) {
      console.error(`desktop-run: command ended by ${exit.signal}`);
      return 1;
    }
    return exit.code ?? 1;
  } finally {
    cleanup(!job.detach);
  }
}

function relay(dir) {
  for (const [name, stream] of [['stdout', process.stdout], ['stderr', process.stderr]]) {
    const path = join(dir, name);
    if (existsSync(path)) stream.write(readFileSync(path));
  }
}

async function main(argv) {
  const [verb, ...rest] = argv;
  if (verb === '_runner') return runner(rest[0]);
  if (verb === 'sweep') {
    if (process.platform !== 'win32') fail('desktop-run works only on Windows');
    for (const name of sweep()) console.log(`swept ${name}`);
    return;
  }
  if (verb === 'run') {
    let timeoutS = DEFAULT_TIMEOUT_S;
    let timeoutGiven = false;
    let detach = false;
    let i = 0;
    for (; i < rest.length && rest[i] !== '--'; i++) {
      if (rest[i] === '--detach') detach = true;
      else if (rest[i] === '--timeout') {
        timeoutS = Number(rest[++i]);
        timeoutGiven = true;
        if (!Number.isFinite(timeoutS) || timeoutS <= 0) fail('--timeout needs a positive number of seconds');
      } else usage();
    }
    const command = rest.slice(i + 1);
    if (rest[i] !== '--' || command.length === 0) usage();
    if (detach && timeoutGiven) fail('--detach takes no --timeout: the app outlives the call; kill it by the printed pid');
    process.exitCode = await runInSession({ command: command[0], args: command.slice(1), cwd: process.cwd(), detach }, timeoutS);
    return;
  }
  if (verb === 'screenshot') {
    if (rest.length !== 1) usage();
    const out = resolve(rest[0]);
    const script = `$Out = '${out.replaceAll("'", "''")}'\n${SCREENSHOT_PS1}`;
    process.exitCode = await runInSession({
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      cwd: process.cwd(),
      detach: false,
    }, SCREENSHOT_TIMEOUT_S);
    return;
  }
  usage();
}

main(process.argv.slice(2)).catch((error) => fail(error.message));
