use std::process::Command;

fn main() {
    if let Ok(output) = Command::new("git").args(["rev-parse", "--short=8", "HEAD"]).output() {
        if output.status.success() {
            if let Ok(hash) = String::from_utf8(output.stdout) {
                println!("cargo:rustc-env=ORCHESTRA_GIT_HASH={}", hash.trim());
            }
        }
    }
    println!("cargo:rerun-if-changed=.git/HEAD");
    println!("cargo:rerun-if-changed=.git/refs");
    tauri_build::build()
}
