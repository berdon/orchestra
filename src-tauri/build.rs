use std::process::Command;

fn main() {
    if let Ok(output) = Command::new("git")
        .args(["rev-parse", "--short=8", "HEAD"])
        .output()
    {
        if output.status.success() {
            if let Ok(hash) = String::from_utf8(output.stdout) {
                println!("cargo:rustc-env=ORCHESTRA_GIT_HASH={}", hash.trim());
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        cc::Build::new()
            .file("src/native/macos_notifications.m")
            .flag("-fobjc-arc")
            .compile("orchestra_macos_notifications");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=framework=UserNotifications");
        println!("cargo:rerun-if-changed=src/native/macos_notifications.m");
    }

    println!("cargo:rerun-if-changed=.git/HEAD");
    println!("cargo:rerun-if-changed=.git/refs");
    tauri_build::build()
}
