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

    ensure_mobile_web_assets();

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
