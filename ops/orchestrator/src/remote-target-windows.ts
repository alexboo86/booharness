import { BUILDERS, RECENT_BUILD_RULE } from './target-sweep-rules.ts';

// Native Windows probes: PEB cwd for builders, sharing and byte-range locks for targets.
// PowerShell compiles this in its own bounded child; no host package installation.
export const windowsTargetLiveness = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Diagnostics;
using System.ComponentModel;
using System.Text;
using System.Text.RegularExpressions;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class TargetLiveness {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadProcessMemory(IntPtr handle, IntPtr address, byte[] bytes, int length, out IntPtr read);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr handle, int kind, IntPtr buffer, int length, out int returned);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFile(string file, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  static byte[] Read(IntPtr handle, long address, int length) {
    byte[] bytes = new byte[length]; IntPtr read;
    if (!ReadProcessMemory(handle, new IntPtr(address), bytes, length, out read) || read.ToInt64() != length)
      throw new Win32Exception(Marshal.GetLastWin32Error(), "builder cwd liveness unproved");
    return bytes;
  }
  static long Pointer(byte[] bytes, int offset, bool wide) {
    return wide ? BitConverter.ToInt64(bytes, offset) : BitConverter.ToUInt32(bytes, offset);
  }
  static string Cwd(Process process) {
    if (!Environment.Is64BitProcess) throw new Exception("builder cwd liveness requires 64-bit PowerShell");
    IntPtr handle = OpenProcess(0x410, false, process.Id);
    if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "builder cwd liveness unproved");
    IntPtr info = Marshal.AllocHGlobal(48);
    try {
      int returned;
      if (NtQueryInformationProcess(handle, 0, info, 48, out returned) != 0) throw new Exception("builder PEB liveness unproved");
      long peb = Marshal.ReadIntPtr(info, 8).ToInt64();
      if (NtQueryInformationProcess(handle, 26, info, 8, out returned) != 0) throw new Exception("builder architecture liveness unproved");
      long wow = Marshal.ReadIntPtr(info).ToInt64(); bool wide = wow == 0;
      if (!wide) peb = wow;
      long parameters = Pointer(Read(handle, peb + (wide ? 0x20 : 0x10), wide ? 8 : 4), 0, wide);
      byte[] directory = Read(handle, parameters + (wide ? 0x38 : 0x24), wide ? 16 : 8);
      int length = BitConverter.ToUInt16(directory, 0);
      return Encoding.Unicode.GetString(Read(handle, Pointer(directory, wide ? 8 : 4, wide), length));
    } finally { Marshal.FreeHGlobal(info); CloseHandle(handle); }
  }
  static bool Inside(string root, string value) {
    root = Path.GetFullPath(root).TrimEnd('\\'); value = Path.GetFullPath(value).TrimEnd('\\');
    return value.Equals(root, StringComparison.OrdinalIgnoreCase) || value.StartsWith(root + "\\", StringComparison.OrdinalIgnoreCase);
  }
  static void Builders(string root) {
    foreach (Process process in Process.GetProcesses()) using (process) {
      if (!Regex.IsMatch(process.ProcessName, @"${BUILDERS.source}", ${BUILDERS.ignoreCase ? 'RegexOptions.IgnoreCase' : 'RegexOptions.None'})) continue;
      try { if (Inside(root, Cwd(process))) throw new IOException(process.ProcessName + " working in the checkout"); }
      catch { if (!process.HasExited) throw; }
    }
  }
  static void Files(string target) {
    foreach (string file in Directory.GetFileSystemEntries(target)) {
      FileAttributes attributes = File.GetAttributes(file);
      if ((attributes & FileAttributes.ReparsePoint) != 0) continue;
      if ((attributes & FileAttributes.Directory) != 0) { Files(file); continue; }
      bool cargoLock = Path.GetFileName(file) == ".cargo-lock";
      try {
        using (FileStream stream = File.Open(file, FileMode.Open, cargoLock ? FileAccess.ReadWrite : FileAccess.Read, FileShare.None)) {
          if (cargoLock) { stream.Lock(0, long.MaxValue); stream.Unlock(0, long.MaxValue); }
        }
      } catch (IOException) { throw new IOException(cargoLock ? "cargo lock held or open" : "open file or executable inside the target"); }
    }
    // A process cwd holds a directory without FILE_SHARE_DELETE, even without open files.
    using (SafeFileHandle handle = CreateFile(target, 0x10000, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
      if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "directory in use or liveness unproved");
    }
  }
  static void Locks(string target) {
    foreach (string profile in new string[] { ${RECENT_BUILD_RULE.profiles.map(profile => JSON.stringify(profile)).join(', ')} }) {
      string file = Path.Combine(target, profile, ".cargo-lock");
      if (!File.Exists(file)) continue;
      if ((File.GetAttributes(file) & FileAttributes.ReparsePoint) != 0) throw new IOException("linked cargo lock");
      try {
        using (FileStream stream = File.Open(file, FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite | FileShare.Delete)) {
          stream.Lock(0, long.MaxValue); stream.Unlock(0, long.MaxValue);
        }
      } catch (IOException) { throw new IOException("cargo lock held or liveness unproved"); }
    }
  }
  public static void Check(string root, string target) { Files(target); Builders(root); Locks(target); }
}
'@
try { [TargetLiveness]::Check($env:ORCH_TARGET_ROOT, $env:ORCH_TARGET_DIR); [Console]::Write('free') }
catch { [Console]::Write($_.Exception.GetBaseException().Message) }
`;
