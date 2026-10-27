// Shared per-user Windows Task Scheduler primitives; callers own lifecycle order.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: false });
  return { status: result.status, out: `${result.stdout || ''}${result.stderr || ''}`.trim(), error: result.error };
}

export function currentUserSid({ systemRoot }) {
  // Git Bash puts GNU coreutils whoami first on PATH, and it rejects /user: name the system one.
  if (!systemRoot) throw new Error('SystemRoot is not set; cannot locate whoami.exe');
  const who = run(path.win32.join(systemRoot, 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
  const sid = /"(S-1-[\d-]+)"/.exec(who.out)?.[1];
  if (who.status !== 0 || !sid) throw new Error(`whoami /user gave no SID (exit ${who.status}): ${who.out}`);
  return sid;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// The per-minute TimeTrigger is the Windows KeepAlive: RestartOnFailure covers
// only launch failures, and a killed daemon leaves conhost exiting 0. While the
// daemon runs, IgnoreNew drops the tick. Keep the measured orch template settings.
// args is an already-quoted Windows command line; XML escaping happens here.
export function renderTaskXml({ taskName, command, args, workdir, description, user }) {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xmlEscape(description)}</Description>
    <URI>\\${xmlEscape(taskName)}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEscape(user)}</UserId>
    </LogonTrigger>
    <TimeTrigger>
      <Enabled>true</Enabled>
      <StartBoundary>2026-01-01T00:00:00</StartBoundary>
      <Repetition>
        <Interval>PT1M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(command)}</Command>
      <Arguments>${xmlEscape(args)}</Arguments>
      <WorkingDirectory>${xmlEscape(workdir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

export function queryTask({ taskName }) {
  return run('schtasks', ['/Query', '/TN', taskName]);
}

export function endTask({ taskName }) {
  return run('schtasks', ['/End', '/TN', taskName]);
}

export function createTask({ taskName, xmlPath }) {
  return run('schtasks', ['/Create', '/TN', taskName, '/XML', xmlPath, '/F']);
}

export function runTask({ taskName }) {
  return run('schtasks', ['/Run', '/TN', taskName]);
}

export function deleteTask({ taskName }) {
  return run('schtasks', ['/Delete', '/TN', taskName, '/F']);
}
