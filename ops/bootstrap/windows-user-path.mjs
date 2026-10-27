import { spawnSync } from 'node:child_process';
import path from 'node:path';

/** Persist only for the current Windows user; a scratch --home is not that user. */
export function persistWindowsUserPath(ctx) {
  const directory = path.join(ctx.home, '.local', 'bin');
  const target = 'HKCU\\Environment\\Path';
  if (process.platform !== 'win32' || !process.env.USERPROFILE ||
      path.resolve(ctx.home).toLowerCase() !== path.resolve(process.env.USERPROFILE).toLowerCase()) {
    return { state: 'skipped', target, directory, reason: 'target home is not the current Windows user profile' };
  }
  // Read the unexpanded registry bytes and retain their kind. setx truncates
  // long values and expands %variables%; neither is safe for an existing Path.
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
try {
  $value = $key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
  if ($null -ne $value) {
    $kind = $key.GetValueKind('Path')
    if ($kind -ne 'String' -and $kind -ne 'ExpandString') { throw 'User Path must be REG_SZ or REG_EXPAND_SZ; left unchanged' }
  }
  $before = [string]$value
  $directory = $env:HARNESS_PATH_DIRECTORY
  $normalize = { param($entry) [Environment]::ExpandEnvironmentVariables($entry.Trim().Trim('"')).TrimEnd('\\', '/') }
  $present = @($before.Split(';') | Where-Object { (& $normalize $_) -ieq (& $normalize $directory) }).Count -gt 0
  $state = 'already_installed'
  if (-not $present) {
    $separator = if ($before.Length -eq 0 -or $before.EndsWith(';')) { '' } else { ';' }
    $value = $before + $separator + $directory
    $key.SetValue('Path', $value, $kind)
    $state = 'installed'
  } else { $value = $before }
} finally { $key.Dispose() }
if ($state -eq 'installed') {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HarnessEnvironmentChange {
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);
}
'@
  $result = [UIntPtr]::Zero
  $notified = [HarnessEnvironmentChange]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result) -ne [IntPtr]::Zero
} else { $notified = $null }
@{ state = $state; target = 'HKCU\\Environment\\Path'; directory = $directory; value = $value; notified = $notified; note = 'Open a new terminal/session to use the updated user Path' } | ConvertTo-Json -Compress
`;
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', shell: false, windowsHide: true, timeout: 30_000,
    env: { ...process.env, HARNESS_PATH_DIRECTORY: directory },
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Cannot persist Windows user Path: ${result.error?.message || result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
}
