use std::{
    env, fs, io,
    path::{Path, PathBuf},
    process::Command,
};

fn copy_dir_all(source: &Path, destination: &Path) -> io::Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let entry_type = entry.file_type()?;
        let destination_path = destination.join(entry.file_name());
        if entry_type.is_dir() {
            copy_dir_all(&entry.path(), &destination_path)?;
        } else {
            fs::copy(entry.path(), destination_path)?;
        }
    }
    Ok(())
}

fn ensure_mobile_web_assets() {
    let manifest_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is not set"));
    let repo_root = manifest_dir
        .parent()
        .expect("src-tauri should have a repository parent");
    let fallback_mobile_dist_web = repo_root.join("mobile/dist-web");
    let desktop_dist = repo_root.join("dist");

    println!("cargo:rerun-if-changed={}", desktop_dist.display());
    println!(
        "cargo:rerun-if-changed={}",
        fallback_mobile_dist_web.display()
    );

    if fs::symlink_metadata(&fallback_mobile_dist_web).is_ok() {
        return;
    }

    if !desktop_dist.exists() {
        panic!(
            "missing {} and {}. Run `npm run build` before `cargo build`, or generate the Expo bundle with `cd mobile && npm install && npm run web:build`.",
            fallback_mobile_dist_web.display(),
            desktop_dist.display()
        );
    }

    if let Some(parent) = fallback_mobile_dist_web.parent() {
        fs::create_dir_all(parent)
            .expect("failed to create mobile directory for fallback web assets");
    }

    let symlink_result = {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&desktop_dist, &fallback_mobile_dist_web)
        }
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_dir(&desktop_dist, &fallback_mobile_dist_web)
        }
    };

    match symlink_result {
        Ok(()) => {
            println!(
                "cargo:warning=mobile/dist-web was missing; using the existing web dist as a local fallback for this Tauri build"
            );
        }
        Err(_) => {
            copy_dir_all(&desktop_dist, &fallback_mobile_dist_web)
                .expect("failed to copy fallback web dist into mobile/dist-web");
            println!(
                "cargo:warning=mobile/dist-web was missing; copied the existing web dist into mobile/dist-web as a local fallback for this Tauri build"
            );
        }
    }
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

    ensure_mobile_web_assets();
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
