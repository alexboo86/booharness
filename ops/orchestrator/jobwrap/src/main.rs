//! orch-jobwrap: run one command inside a Windows Job Object with
//! JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (task 1838). remote-exec spawns every
//! win32 remote command through this helper; when the helper dies by any path
//! (taskkill, TerminateProcess of its parent, its own parent watch) the last
//! job handle closes and Windows kills every process ever started in the job,
//! including branches whose intermediate parent already exited — exactly the
//! npm -> cmd -> node orphans `taskkill /T` cannot find. Exits with the
//! command's exit code; stdio is inherited verbatim.

#[cfg(not(windows))]
compile_error!("orch-jobwrap is a Windows-only helper; remote-exec never builds or runs it elsewhere");

#[cfg(windows)]
use std::ffi::OsStr;
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;
#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0};
#[cfg(windows)]
use windows_sys::Win32::System::Console::{GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE};
#[cfg(windows)]
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
#[cfg(windows)]
use windows_sys::Win32::System::Threading::{
    CreateProcessW, GetCurrentProcess, GetCurrentProcessId, GetExitCodeProcess, OpenProcess, WaitForMultipleObjects,
    CREATE_UNICODE_ENVIRONMENT, INFINITE, PROCESS_INFORMATION, PROCESS_SYNCHRONIZE, STARTF_USESTDHANDLES, STARTUPINFOW,
};

/// Append one argument to a CreateProcessW command line, following the MSVCRT
/// quoting rules the child's CommandLineToArgvW will parse back.
#[cfg(windows)]
fn push_quoted(command: &mut Vec<u16>, argument: &OsStr) {
    let wide: Vec<u16> = argument.encode_wide().collect();
    let bare = !wide.is_empty()
        && !wide.iter().any(|&c| c == b' ' as u16 || c == b'\t' as u16 || c == b'"' as u16);
    if bare {
        command.extend_from_slice(&wide);
        return;
    }
    command.push(b'"' as u16);
    let mut backslashes = 0usize;
    for &c in &wide {
        if c == b'\\' as u16 {
            backslashes += 1;
        } else if c == b'"' as u16 {
            command.resize(command.len() + 2 * backslashes + 1, b'\\' as u16);
            backslashes = 0;
            command.push(b'"' as u16);
        } else {
            command.resize(command.len() + backslashes, b'\\' as u16);
            backslashes = 0;
            command.push(c);
        }
    }
    command.resize(command.len() + 2 * backslashes, b'\\' as u16);
    command.push(b'"' as u16);
}

/// The helper's own parent pid (remote-exec); the job must not outlive it.
#[cfg(windows)]
fn parent_pid() -> Option<u32> {
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let own = GetCurrentProcessId();
        let mut found = None;
        if Process32FirstW(snapshot, &mut entry) != 0 {
            loop {
                if entry.th32ProcessID == own {
                    found = Some(entry.th32ParentProcessID);
                    break;
                }
                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snapshot);
        found
    }
}

#[cfg(windows)]
fn main() {
    let mut arguments = std::env::args_os().skip(1);
    let Some(program) = arguments.next() else {
        eprintln!("usage: orch-jobwrap <program> [args...]");
        std::process::exit(2);
    };
    let mut command_line: Vec<u16> = Vec::new();
    push_quoted(&mut command_line, &program);
    for argument in arguments {
        command_line.push(b' ' as u16);
        push_quoted(&mut command_line, &argument);
    }
    command_line.push(0);

    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            eprintln!("orch-jobwrap: CreateJobObjectW failed: {}", GetLastError());
            std::process::exit(1);
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ) == 0
        {
            eprintln!("orch-jobwrap: SetInformationJobObject failed: {}", GetLastError());
            std::process::exit(1);
        }
        // Self first: every process spawned from here on lands in the job, with no
        // window where an unassigned child could start a grandchild.
        if AssignProcessToJobObject(job, GetCurrentProcess()) == 0 {
            eprintln!("orch-jobwrap: AssignProcessToJobObject failed: {}", GetLastError());
            std::process::exit(1);
        }

        // When remote-exec dies (sshd teardown, TerminateProcess), this handle signals
        // and the helper exits, closing the job on the whole command branch.
        let Some(ppid) = parent_pid() else {
            eprintln!("orch-jobwrap: could not find the parent process id");
            std::process::exit(1);
        };
        let parent = OpenProcess(PROCESS_SYNCHRONIZE, 0, ppid);
        if parent.is_null() {
            eprintln!("orch-jobwrap: parent process {ppid} is already gone or inaccessible: {}", GetLastError());
            std::process::exit(1);
        }

        let mut startup: STARTUPINFOW = std::mem::zeroed();
        startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
        startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
        startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
        let mut information: PROCESS_INFORMATION = std::mem::zeroed();
        if CreateProcessW(
            // Null application name: the quoted first token of the command line is the
            // program (remote-exec already resolved it against the seat's PATH), and a
            // bare name still gets the standard PATH search.
            std::ptr::null(),
            command_line.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1, // inherit the pipe handles remote-exec reads and writes
            CREATE_UNICODE_ENVIRONMENT,
            std::ptr::null(),
            std::ptr::null(),
            &startup,
            &mut information,
        ) == 0
        {
            eprintln!("orch-jobwrap: CreateProcessW failed: {}", GetLastError());
            std::process::exit(1);
        }
        CloseHandle(information.hThread);

        let waits: [HANDLE; 2] = [information.hProcess, parent];
        let signaled = WaitForMultipleObjects(2, waits.as_ptr(), 0, INFINITE);
        let mut code = 1u32;
        if signaled == WAIT_OBJECT_0 {
            GetExitCodeProcess(information.hProcess, &mut code);
        }
        CloseHandle(information.hProcess);
        CloseHandle(parent);
        // Exiting closes this process's job handle — the last one — so the job is
        // torn down and every surviving process in it is killed.
        std::process::exit(code as i32);
    }
}
