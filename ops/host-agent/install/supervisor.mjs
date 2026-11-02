import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LABEL = 'com.harness.orch-host-agent';
const TASK = 'HarnessOrchHostAgent';

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function quoteWindows(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

function plist({ root, nodePath, servicePath }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(nodePath)}</string><string>${xml(path.join(root, 'launcher.mjs'))}</string><string>--root</string><string>${xml(root)}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(path.join(root, 'agent.out.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(root, 'agent.err.log'))}</string>
</dict></plist>\n`;
}

function systemdArgument(value) {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
}

function systemd({ root, nodePath }) {
  const args = [nodePath, path.join(root, 'launcher.mjs'), '--root', root].map(systemdArgument).join(' ');
  return `[Unit]\nDescription=Orch host agent\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=${args}\nWorkingDirectory=${systemdArgument(root)}\nRestart=always\nRestartSec=10\nKillMode=process\nNoNewPrivileges=true\nPrivateTmp=true\n\n[Install]\nWantedBy=default.target\n`;
}

function taskXml({ root, nodePath, user }) {
  const args = [quoteWindows(nodePath), quoteWindows(path.win32.join(root, 'launcher.mjs')), '--root', quoteWindows(root)].join(' ');
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<RegistrationInfo><URI>\\${TASK}</URI><Description>Orch host agent</Description></RegistrationInfo>
<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(user)}</UserId></LogonTrigger></Triggers>
<Principals><Principal id="Author"><UserId>${xml(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><Enabled>true</Enabled><Hidden>true</Hidden><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure></Settings>
<Actions Context="Author"><Exec><Command>%SystemRoot%\\System32\\conhost.exe</Command><Arguments>${xml(`--headless ${args}`)}</Arguments><WorkingDirectory>${xml(root)}</WorkingDirectory></Exec></Actions>
</Task>\n`;
}

function command(file, args) {
  const result = spawnSync(file, args, { encoding: 'utf8', shell: false, windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(`${file} ${args[0] ?? ''} failed (${result.status ?? result.error?.code}): ${`${result.stdout ?? ''}${result.stderr ?? ''}`.trim()}`);
  }
}

function optionalCommand(file, args, allowedStatuses = []) {
  const result = spawnSync(file, args, { encoding: 'utf8', shell: false, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowedStatuses.includes(result.status)) {
    throw new Error(`${file} ${args[0] ?? ''} failed (${result.status}): ${`${result.stdout ?? ''}${result.stderr ?? ''}`.trim()}`);
  }
}

function pause(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function currentSid() {
  const root = process.env.SystemRoot ?? 'C:\\Windows';
  const whoami = path.win32.join(root, 'System32', 'whoami.exe');
  const result = spawnSync(whoami, ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', shell: false, windowsHide: true });
  const sid = /"(S-1-[\d-]+)"/.exec(`${result.stdout ?? ''}`)?.[1];
  if (result.status !== 0 || !sid) throw new Error('whoami could not determine the current user SID');
  return sid;
}

function serviceDefinition({ platform, home, root, nodePath }) {
  if (platform === 'darwin') return { file: path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`), content: plist({ root, nodePath }) };
  if (platform === 'linux') return { file: path.join(home, '.config', 'systemd', 'user', 'orch-host-agent.service'), content: systemd({ root, nodePath }) };
  const user = currentSid();
  const content = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskXml({ root, nodePath, user }), 'utf16le')]);
  return { file: path.join(root, 'scheduled-task.xml'), content };
}

function stopLaunchd() {
  const domain = `gui/${process.getuid()}`;
  optionalCommand('launchctl', ['bootout', `${domain}/${LABEL}`], [3]);
  for (let waited = 0; waited < 10_000; waited += 100) {
    const loaded = spawnSync('launchctl', ['print', `${domain}/${LABEL}`], { shell: false, stdio: 'ignore' });
    if (loaded.status !== 0) return;
    pause(100);
  }
  throw new Error(`launchd did not unload ${LABEL} within 10 seconds`);
}

function ownsWindowsAgent({ root, nodePath }, pid) {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($null -eq $p) { exit 128 }; `
    + '[Console]::Out.Write(($p | Select-Object ExecutablePath,CommandLine | ConvertTo-Json -Compress))';
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', shell: false, windowsHide: true });
  if (result.status === 128) return false;
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`could not verify agent process ${pid}`);
  const inspected = JSON.parse(result.stdout);
  if (typeof inspected.ExecutablePath !== 'string' || typeof inspected.CommandLine !== 'string') return false;
  if (realpathSync(inspected.ExecutablePath).toLowerCase() !== realpathSync(nodePath).toLowerCase()) return false;
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const launcher = escape(path.win32.join(root, 'launcher.mjs'));
  const expectedRoot = escape(path.win32.resolve(root));
  return new RegExp(`(?:^|\\s)"?${launcher}"?\\s+--root\\s+"?${expectedRoot}"?(?:\\s|$)`, 'i').test(inspected.CommandLine);
}

function stopWindows(context) {
  const { root } = context;
  try {
    const ready = JSON.parse(readFileSync(path.join(root, 'ready.json'), 'utf8'));
    if (Number.isSafeInteger(ready.pid) && ready.pid > 0 && ownsWindowsAgent(context, ready.pid)) {
      optionalCommand('taskkill', ['/F', '/PID', String(ready.pid)], [128]);
    }
  } catch (error) {
    if (!(error instanceof SyntaxError) && error.code !== 'ENOENT') throw error;
  }
  optionalCommand('schtasks', ['/End', '/TN', TASK], [1]);
}

function stopService(context) {
  const { platform, root } = context;
  if (platform === 'darwin') stopLaunchd();
  else if (platform === 'linux') optionalCommand('systemctl', ['--user', 'stop', 'orch-host-agent.service'], [5]);
  else stopWindows(context);
  rmSync(path.join(root, 'ready.json'), { force: true });
}

function startService(context) {
  if (context.platform === 'darwin') {
    const target = serviceDefinition(context);
    command('launchctl', ['bootstrap', `gui/${process.getuid()}`, target.file]);
  } else if (context.platform === 'linux') {
    command('systemctl', ['--user', 'start', 'orch-host-agent.service']);
  } else command('schtasks', ['/Run', '/TN', TASK]);
}

function waitReady(root, version) {
  const file = path.join(root, 'ready.json');
  for (let waited = 0; waited < 10_000; waited += 100) {
    try {
      const ready = JSON.parse(readFileSync(file, 'utf8'));
      if (ready.version === version && ready.pid > 0) return;
    } catch { /* not written yet */ }
    pause(100);
  }
  throw new Error(`agent ${version} did not report a successful start within 10 seconds`);
}

function installService(context) {
  const target = serviceDefinition(context);
  mkdirSync(path.dirname(target.file), { recursive: true, mode: 0o700 });
  writeFileSync(target.file, target.content, { mode: 0o600 });
  if (context.platform === 'linux') {
    command('systemctl', ['--user', 'daemon-reload']);
    command('systemctl', ['--user', 'enable', 'orch-host-agent.service']);
  } else if (context.platform === 'win32') command('schtasks', ['/Create', '/TN', TASK, '/XML', target.file, '/F']);
}

function uninstallService(context) {
  stopService(context);
  const target = serviceDefinition(context);
  if (context.platform === 'linux') {
    optionalCommand('systemctl', ['--user', 'disable', 'orch-host-agent.service'], [5]);
    command('systemctl', ['--user', 'daemon-reload']);
  } else if (context.platform === 'win32') optionalCommand('schtasks', ['/Delete', '/TN', TASK, '/F'], [1]);
  rmSync(target.file, { force: true });
}

export function createSupervisor({ home, platform = process.platform, root, nodePath = process.execPath }) {
  if (!['darwin', 'linux', 'win32'].includes(platform)) throw new Error(`unsupported install platform ${platform}`);
  if (platform !== process.platform) throw new Error(`cannot activate a ${platform} supervisor on ${process.platform}`);
  const context = { home, platform, root, nodePath };
  return {
    install: () => installService(context),
    restart(version) {
      stopService(context);
      startService(context);
      waitReady(root, version);
    },
    uninstall: () => uninstallService(context),
  };
}
