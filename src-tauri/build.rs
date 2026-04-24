use std::{env, fs, path::PathBuf, process::Command};

fn ensure_hosted_web_assets() {
    let manifest_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is not set"));
    let repo_root = manifest_dir
        .parent()
        .expect("src-tauri should have a repository parent");
    let hosted_web_dist = repo_root.join("dist");

    println!("cargo:rerun-if-changed={}", hosted_web_dist.display());

    if hosted_web_dist.exists() {
        return;
    }

    if tauri_build::is_dev() {
        fs::create_dir_all(&hosted_web_dist)
            .expect("failed to create dist placeholder directory for development builds");
        return;
    }

    panic!(
        "missing {}. Run `npm run build:hosted-web` before `cargo build`, or use `cargo tauri build` so Tauri's beforeBuildCommand refreshes the hosted-web bundle automatically.",
        hosted_web_dist.display()
    );
}

fn ensure_bundled_pi_runtime() {
    let manifest_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is not set"));
    let repo_root = manifest_dir
        .parent()
        .expect("src-tauri should have a repository parent");
    let generated_root = manifest_dir.join("gen/pi-runtime");
    let manifest_path = generated_root.join("manifest.json");
    let notice_path = generated_root.join("THIRD_PARTY_NOTICES.txt");
    let sbom_path = generated_root.join("sbom.cyclonedx.json");
    let executable_path = generated_root.join(if cfg!(windows) {
        "runtime/pi.exe"
    } else {
        "runtime/pi"
    });
    let script_path = repo_root.join("scripts/prepare-bundled-pi-runtime.mjs");

    println!("cargo:rerun-if-changed={}", script_path.display());
    println!("cargo:rerun-if-changed={}", generated_root.display());
    println!("cargo:rerun-if-env-changed=ORCHESTRA_PI_VERSION");
    println!("cargo:rerun-if-env-changed=ORCHESTRA_PI_PACKAGE_NAME");
    println!("cargo:rerun-if-env-changed=ORCHESTRA_NPM_BINARY");

    if tauri_build::is_dev() {
        fs::create_dir_all(&generated_root).expect("failed to create src-tauri/gen/pi-runtime placeholder directory for development builds");
        return;
    }

    if !manifest_path.exists()
        || !executable_path.exists()
        || !notice_path.exists()
        || !sbom_path.exists()
    {
        panic!(
            "missing bundled Pi runtime artifacts at {}. Expected manifest, executable, third-party notice, and CycloneDX SBOM. Run `npm run prepare:bundled-pi-runtime` first, or use `cargo tauri build` so Tauri's beforeBuildCommand refreshes the bundled runtime automatically.",
            generated_root.display()
        );
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let metadata = fs::metadata(&executable_path).unwrap_or_else(|error| {
            panic!(
                "unable to stat bundled Pi runtime executable {}: {error}",
                executable_path.display()
            )
        });
        if metadata.permissions().mode() & 0o111 == 0 {
            panic!(
                "bundled Pi runtime executable is not marked executable: {}",
                executable_path.display()
            );
        }
    }
}

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

    println!(
        "cargo:rustc-env=ORCHESTRA_TAURI_IS_DEV={}",
        tauri_build::is_dev()
    );

    ensure_hosted_web_assets();
    ensure_bundled_pi_runtime();

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
