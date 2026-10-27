// Windows CreateProcess-compatible seat shim. The tool name comes from this executable's
// filename; rustc embeds the checkout's gate path when the shims are installed.
use std::{env, process::{self, Command}};

fn main() {
    let tool = env::current_exe()
        .ok()
        .and_then(|exe| exe.file_stem().map(|stem| stem.to_os_string()))
        .expect("build-gate: cannot determine tool from launcher filename");
    let status = Command::new("node")
        .arg(env!("ORCH_BUILD_GATE_SCRIPT"))
        .arg(tool)
        .args(env::args_os().skip(1))
        .status();
    match status {
        Ok(status) => process::exit(status.code().unwrap_or(1)),
        Err(error) => {
            eprintln!("build-gate: cannot launch node: {error}");
            process::exit(1);
        }
    }
}
