use std::{
    collections::{HashMap, HashSet},
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    sync::OnceLock,
};

use serde::Deserialize;
use tauri::{path::BaseDirectory, AppHandle, Manager};

use crate::{
    models::PiRuntimeHealth,
    services::orchestra_paths::{default_orchestra_root, pi_agent_dir},
};

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

#[derive(Debug, Clone)]
pub struct ResolvedPiRuntime {
    pub source: String,
    pub mode: String,
    pub executable_path: PathBuf,
    pub package_dir: Option<PathBuf>,
    pub agent_dir: PathBuf,
    pub version: Option<String>,
    pub built_at: Option<String>,
    pub manifest_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuntimeMode {
    Development,
    Packaged,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BundledPiRuntimeManifest {
    schema_version: u32,
    source: String,
    platform: String,
    arch: String,
    package_name: String,
    package_version: String,
    runtime_version: Option<String>,
    orchestra_pack_version: u32,
    executable_relative_path: String,
    package_dir_relative_path: String,
    built_at: Option<String>,
    notes: Option<String>,
}

pub fn register_app_handle(app: AppHandle) {
    let _ = APP_HANDLE.set(app);
}

pub fn current_pi_runtime_health() -> PiRuntimeHealth {
    match resolve_pi_runtime_internal(None) {
        Ok(runtime) => runtime.health(),
        Err(health) => health,
    }
}

pub fn resolve_pi_runtime(preferred: Option<&Path>) -> Result<ResolvedPiRuntime, String> {
    resolve_pi_runtime_internal(preferred).map_err(|health| {
        health
            .error_message
            .unwrap_or_else(|| "Unable to resolve a usable Pi runtime".into())
    })
}

pub fn apply_runtime_environment(
    command: &mut Command,
    runtime: &ResolvedPiRuntime,
    agent_dir_override: Option<&Path>,
) {
    for (key, value) in runtime_environment_variables(runtime, agent_dir_override) {
        command.env(key, value);
    }
}

pub fn runtime_environment_variables(
    runtime: &ResolvedPiRuntime,
    agent_dir_override: Option<&Path>,
) -> Vec<(String, String)> {
    let agent_dir = agent_dir_override.unwrap_or(&runtime.agent_dir);
    let mut environment = vec![(
        "PI_CODING_AGENT_DIR".to_string(),
        agent_dir.display().to_string(),
    )];

    if runtime.source == "bundled" {
        if let Some(package_dir) = runtime.package_dir.as_ref() {
            environment.push((
                "PI_PACKAGE_DIR".to_string(),
                package_dir.display().to_string(),
            ));
        }
    }

    environment
}

pub fn user_shell() -> Result<PathBuf, String> {
    user_shell_candidates().into_iter().next().ok_or_else(|| {
        "Unable to locate a usable login shell for Orchestra subprocesses".to_string()
    })
}

pub fn resolve_user_shell_environment() -> Option<HashMap<String, String>> {
    for shell in user_shell_candidates() {
        let Ok(output) = run_shell_command(&shell, "env -0") else {
            continue;
        };
        if !output.status.success() {
            continue;
        }
        let parsed = parse_shell_environment(&output.stdout);
        if !parsed.is_empty() {
            return Some(parsed);
        }
    }

    None
}

pub fn resolve_user_shell_path() -> Option<String> {
    resolve_user_shell_environment().and_then(|environment| environment.get("PATH").cloned())
}

pub fn apply_user_shell_environment(command: &mut Command) {
    if let Some(environment) = resolve_user_shell_environment() {
        command.env_clear();
        for (key, value) in environment {
            command.env(key, value);
        }
    }
}

fn resolve_pi_runtime_internal(
    preferred: Option<&Path>,
) -> Result<ResolvedPiRuntime, PiRuntimeHealth> {
    let mode = runtime_mode();
    let mode_label = mode.as_str().to_string();
    let agent_dir = ensure_orchestra_pi_agent_dir().map_err(|error| {
        runtime_error(
            mode,
            "system",
            "runtime_storage_unavailable",
            error,
            None,
            None,
            None,
            Some(mode_label.clone()),
            None,
        )
    })?;

    if let Ok(value) = env::var("ORCHESTRA_PI_EXECUTABLE") {
        let candidate = PathBuf::from(value);
        if let Some(executable_path) = resolve_pi_candidate(&candidate) {
            return Ok(ResolvedPiRuntime {
                source: "override".into(),
                mode: mode_label,
                executable_path,
                package_dir: None,
                agent_dir,
                version: None,
                built_at: None,
                manifest_path: None,
            });
        }

        return Err(runtime_error(
            mode,
            "override",
            "override_not_found",
            format!(
                "The ORCHESTRA_PI_EXECUTABLE override points to a missing Pi executable: {}",
                candidate.display()
            ),
            None,
            None,
            Some(&agent_dir),
            Some(mode.as_str().to_string()),
            None,
        ));
    }

    match resolve_bundled_runtime(mode, &agent_dir) {
        Ok(Some(runtime)) => return Ok(runtime),
        Ok(None) => {}
        Err(error) => {
            if mode == RuntimeMode::Packaged {
                return Err(error);
            }
        }
    }

    if mode == RuntimeMode::Packaged {
        return Err(runtime_error(
            mode,
            "bundled",
            "bundled_runtime_missing",
            "Packaged Orchestra could not find its bundled Pi runtime in app resources.".into(),
            None,
            None,
            Some(&agent_dir),
            Some(mode.as_str().to_string()),
            None,
        ));
    }

    let executable_path = match resolve_system_pi(preferred) {
        Ok(path) => path,
        Err(searched) => {
            return Err(runtime_error(
                mode,
                "system",
                "system_runtime_not_found",
                format!(
                    "Unable to locate the pi executable in development mode. Checked: {}. Set ORCHESTRA_PI_EXECUTABLE to an explicit path if needed.",
                    searched_paths_summary(&searched)
                ),
                None,
                None,
                Some(&agent_dir),
                Some(mode_label),
                None,
            ));
        }
    };

    Ok(ResolvedPiRuntime {
        source: "system".into(),
        mode: mode.as_str().into(),
        executable_path,
        package_dir: None,
        agent_dir,
        version: None,
        built_at: None,
        manifest_path: None,
    })
}

fn resolve_bundled_runtime(
    mode: RuntimeMode,
    agent_dir: &Path,
) -> Result<Option<ResolvedPiRuntime>, PiRuntimeHealth> {
    let Some(root) = bundled_runtime_root() else {
        return if mode == RuntimeMode::Packaged {
            Err(runtime_error(
                mode,
                "bundled",
                "bundled_runtime_missing",
                "Packaged Orchestra could not resolve the bundled Pi runtime resource directory."
                    .into(),
                None,
                None,
                Some(agent_dir),
                Some(mode.as_str().to_string()),
                None,
            ))
        } else {
            Ok(None)
        };
    };

    validate_bundled_runtime_root(&root, mode, agent_dir).map(Some)
}

fn validate_bundled_runtime_root(
    root: &Path,
    mode: RuntimeMode,
    agent_dir: &Path,
) -> Result<ResolvedPiRuntime, PiRuntimeHealth> {
    let manifest_path = root.join("manifest.json");
    if !manifest_path.exists() {
        return Err(runtime_error(
            mode,
            "bundled",
            "bundled_runtime_missing",
            format!(
                "Bundled Pi runtime manifest is missing: {}",
                manifest_path.display()
            ),
            None,
            Some(&manifest_path),
            Some(agent_dir),
            Some(mode.as_str().to_string()),
            None,
        ));
    }

    let manifest: BundledPiRuntimeManifest =
        serde_json::from_slice(&fs::read(&manifest_path).map_err(|error| {
            runtime_error(
                mode,
                "bundled",
                "bundled_runtime_invalid",
                format!(
                    "Unable to read bundled Pi runtime manifest {}: {error}",
                    manifest_path.display()
                ),
                None,
                Some(&manifest_path),
                Some(agent_dir),
                Some(mode.as_str().to_string()),
                None,
            )
        })?)
        .map_err(|error| {
            runtime_error(
                mode,
                "bundled",
                "bundled_runtime_invalid",
                format!(
                    "Unable to parse bundled Pi runtime manifest {}: {error}",
                    manifest_path.display()
                ),
                None,
                Some(&manifest_path),
                Some(agent_dir),
                Some(mode.as_str().to_string()),
                None,
            )
        })?;

    if manifest.schema_version != 1 {
        return Err(runtime_error(
            mode,
            "bundled",
            "bundled_runtime_invalid",
            format!(
                "Bundled Pi runtime manifest schema {} is unsupported (expected 1).",
                manifest.schema_version
            ),
            None,
            Some(&manifest_path),
            Some(agent_dir),
            Some(mode.as_str().to_string()),
            None,
        ));
    }

    if manifest.platform != expected_manifest_platform()
        || manifest.arch != expected_manifest_arch()
    {
        return Err(runtime_error(
            mode,
            "bundled",
            "bundled_runtime_incompatible",
            format!(
                "Bundled Pi runtime targets {}/{} but Orchestra is running on {}/{}.",
                manifest.platform,
                manifest.arch,
                expected_manifest_platform(),
                expected_manifest_arch()
            ),
            None,
            Some(&manifest_path),
            Some(agent_dir),
            Some(mode.as_str().to_string()),
            Some(manifest.package_version.clone()),
        ));
    }

    let executable_path = root.join(&manifest.executable_relative_path);
    if !executable_path.exists() {
        return Err(runtime_error(
            mode,
            "bundled",
            "bundled_runtime_missing",
            format!(
                "Bundled Pi runtime executable is missing: {}",
                executable_path.display()
            ),
            None,
            Some(&manifest_path),
            Some(agent_dir),
            Some(mode.as_str().to_string()),
            Some(manifest.package_version.clone()),
        ));
    }

    if !is_executable(&executable_path) {
        return Err(runtime_error(
            mode,
            "bundled",
            "bundled_runtime_unexecutable",
            format!(
                "Bundled Pi runtime executable is not runnable: {}",
                executable_path.display()
            ),
            Some(&executable_path),
            Some(&manifest_path),
            Some(agent_dir),
            Some(mode.as_str().to_string()),
            Some(manifest.package_version.clone()),
        ));
    }

    let package_dir = root.join(&manifest.package_dir_relative_path);
    if !package_dir.exists() || !package_dir.is_dir() {
        return Err(runtime_error(
            mode,
            "bundled",
            "bundled_runtime_invalid",
            format!(
                "Bundled Pi runtime package directory is missing: {}",
                package_dir.display()
            ),
            None,
            Some(&manifest_path),
            Some(agent_dir),
            Some(mode.as_str().to_string()),
            Some(manifest.package_version.clone()),
        ));
    }

    let version = manifest
        .runtime_version
        .clone()
        .or_else(|| Some(manifest.package_version.clone()));
    let built_at = manifest.built_at.clone().or_else(|| {
        Some(format!(
            "pack:{} source:{}{}",
            manifest.orchestra_pack_version,
            manifest.source,
            manifest
                .notes
                .as_ref()
                .map(|value| format!(" ({value})"))
                .unwrap_or_default()
        ))
    });
    let _ = &manifest.package_name;

    Ok(ResolvedPiRuntime {
        source: "bundled".into(),
        mode: mode.as_str().into(),
        executable_path,
        package_dir: Some(package_dir),
        agent_dir: agent_dir.to_path_buf(),
        version,
        built_at,
        manifest_path: Some(manifest_path),
    })
}

fn bundled_runtime_root() -> Option<PathBuf> {
    APP_HANDLE.get().and_then(|app| {
        app.path()
            .resolve("pi-runtime", BaseDirectory::Resource)
            .ok()
    })
}

fn resolve_system_pi(preferred: Option<&Path>) -> Result<PathBuf, Vec<String>> {
    let mut searched = Vec::new();

    if let Some(candidate) = preferred {
        if let Some(resolved) = resolve_pi_candidate(candidate) {
            return Ok(resolved);
        }
        searched.push(candidate.display().to_string());
    }

    if let Some(home) = env::var_os("HOME").map(PathBuf::from) {
        for candidate in [
            home.join(".npm-global/bin/pi"),
            home.join(".local/bin/pi"),
            home.join(".volta/bin/pi"),
            home.join(".pi/agent/bin/pi"),
            PathBuf::from("/opt/homebrew/bin/pi"),
        ] {
            if let Some(resolved) = resolve_pi_candidate(&candidate) {
                return Ok(resolved);
            }
            searched.push(candidate.display().to_string());
        }
    }

    if let Some(resolved) = resolve_pi_via_user_shell(&mut searched) {
        return Ok(resolved);
    }

    Err(searched)
}

fn resolve_pi_via_user_shell(searched: &mut Vec<String>) -> Option<PathBuf> {
    for shell in user_shell_candidates() {
        searched.push(format!("{} -lc 'command -v pi'", shell.display()));
        let Ok(output) = run_shell_command(&shell, "command -v pi") else {
            continue;
        };
        if !output.status.success() {
            continue;
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        for candidate in stdout
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
        {
            if let Some(resolved) = resolve_pi_candidate(Path::new(candidate)) {
                return Some(resolved);
            }
        }
    }

    None
}

fn user_shell_candidates() -> Vec<PathBuf> {
    let mut shells = Vec::new();
    if let Ok(shell) = env::var("SHELL") {
        shells.push(PathBuf::from(shell));
    }
    shells.push(PathBuf::from("/bin/bash"));
    shells.push(PathBuf::from("/bin/zsh"));
    shells.push(PathBuf::from("/bin/sh"));

    let mut seen = HashSet::new();
    shells
        .into_iter()
        .filter(|shell| {
            let key = shell.display().to_string();
            seen.insert(key) && shell.exists()
        })
        .collect()
}

fn run_shell_command(shell: &Path, command: &str) -> Result<std::process::Output, std::io::Error> {
    if shell.file_name().and_then(|name| name.to_str()) == Some("fish") {
        Command::new(shell)
            .arg("-l")
            .arg("-c")
            .arg(command)
            .output()
    } else {
        Command::new(shell).arg("-lc").arg(command).output()
    }
}

fn parse_shell_environment(output: &[u8]) -> HashMap<String, String> {
    let mut environment = HashMap::new();
    for chunk in output.split(|byte| *byte == 0) {
        if chunk.is_empty() {
            continue;
        }
        let text = String::from_utf8_lossy(chunk);
        for line in text.lines() {
            if let Some((key, value)) = line.split_once('=') {
                if is_environment_key(key) {
                    environment.insert(key.to_string(), value.to_string());
                }
            }
        }
    }
    environment
}

fn is_environment_key(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

fn resolve_pi_candidate(candidate: &Path) -> Option<PathBuf> {
    if candidate.components().count() > 1 || candidate.is_absolute() {
        return candidate.exists().then(|| candidate.to_path_buf());
    }

    env::var_os("PATH").and_then(|path| {
        env::split_paths(&path)
            .map(|entry| entry.join(candidate))
            .find(|entry| entry.exists())
    })
}

fn ensure_orchestra_pi_agent_dir() -> Result<PathBuf, String> {
    let orchestra_root = default_orchestra_root()?;
    let agent_dir = pi_agent_dir(&orchestra_root);
    fs::create_dir_all(&agent_dir).map_err(|error| {
        format!(
            "Unable to create Orchestra Pi agent directory {}: {error}",
            agent_dir.display()
        )
    })?;

    if directory_is_empty(&agent_dir) {
        migrate_legacy_agent_dir(&agent_dir)?;
    }

    Ok(agent_dir)
}

fn migrate_legacy_agent_dir(destination: &Path) -> Result<(), String> {
    let Some(home) = env::var_os("HOME").map(PathBuf::from) else {
        return Ok(());
    };
    let legacy_agent_dir = home.join(".pi").join("agent");
    if !legacy_agent_dir.exists() {
        return Ok(());
    }

    for file_name in ["auth.json", "models.json", "settings.json"] {
        let source = legacy_agent_dir.join(file_name);
        let target = destination.join(file_name);
        if source.exists() && !target.exists() {
            fs::copy(&source, &target).map_err(|error| {
                format!(
                    "Unable to migrate legacy Pi agent file {} to {}: {error}",
                    source.display(),
                    target.display()
                )
            })?;
        }
    }

    Ok(())
}

fn directory_is_empty(path: &Path) -> bool {
    fs::read_dir(path)
        .map(|mut entries| entries.next().is_none())
        .unwrap_or(true)
}

fn expected_manifest_platform() -> &'static str {
    match env::consts::OS {
        "macos" => "darwin",
        "windows" => "windows",
        other => other,
    }
}

fn expected_manifest_arch() -> &'static str {
    match env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    }
}

fn runtime_mode() -> RuntimeMode {
    match option_env!("ORCHESTRA_TAURI_IS_DEV") {
        Some("false") => RuntimeMode::Packaged,
        _ => RuntimeMode::Development,
    }
}

fn is_executable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        fs::metadata(path)
            .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }

    #[cfg(not(unix))]
    {
        true
    }
}

fn runtime_error(
    mode: RuntimeMode,
    source: &str,
    error_kind: &str,
    error_message: String,
    resolved_path: Option<&Path>,
    manifest_path: Option<&Path>,
    agent_dir: Option<&Path>,
    mode_override: Option<String>,
    version: Option<String>,
) -> PiRuntimeHealth {
    PiRuntimeHealth {
        source: source.into(),
        mode: mode_override.unwrap_or_else(|| mode.as_str().into()),
        status: "runtime_error".into(),
        resolved_path: resolved_path.map(|path| path.display().to_string()),
        package_dir: None,
        agent_dir: agent_dir.map(|path| path.display().to_string()),
        version,
        built_at: None,
        manifest_path: manifest_path.map(|path| path.display().to_string()),
        error_kind: Some(error_kind.into()),
        error_message: Some(error_message),
    }
}

fn searched_paths_summary(paths: &[String]) -> String {
    if paths.is_empty() {
        "<none>".into()
    } else {
        paths.join(", ")
    }
}

impl RuntimeMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Development => "development",
            Self::Packaged => "packaged",
        }
    }
}

impl ResolvedPiRuntime {
    pub fn health(&self) -> PiRuntimeHealth {
        PiRuntimeHealth {
            source: self.source.clone(),
            mode: self.mode.clone(),
            status: "healthy".into(),
            resolved_path: Some(self.executable_path.display().to_string()),
            package_dir: self
                .package_dir
                .as_ref()
                .map(|path| path.display().to_string()),
            agent_dir: Some(self.agent_dir.display().to_string()),
            version: self.version.clone(),
            built_at: self.built_at.clone(),
            manifest_path: self
                .manifest_path
                .as_ref()
                .map(|path| path.display().to_string()),
            error_kind: None,
            error_message: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn make_temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("orchestra-pi-runtime-{name}-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("temp dir should be created");
        dir
    }

    fn write_file(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("parent should exist");
        }
        fs::write(path, content).expect("file should be written");
    }

    fn write_fake_executable(path: &Path) {
        write_file(path, "#!/bin/sh\necho pi\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = fs::metadata(path).expect("metadata").permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(path, permissions).expect("permissions");
        }
    }

    fn write_manifest(root: &Path, platform: &str, arch: &str) {
        write_file(
            &root.join("manifest.json"),
            &format!(
                "{{\n  \"schemaVersion\": 1,\n  \"source\": \"test\",\n  \"platform\": \"{platform}\",\n  \"arch\": \"{arch}\",\n  \"packageName\": \"@mariozechner/pi-coding-agent\",\n  \"packageVersion\": \"0.68.1\",\n  \"runtimeVersion\": \"0.68.1\",\n  \"orchestraPackVersion\": 1,\n  \"executableRelativePath\": \"runtime/pi\",\n  \"packageDirRelativePath\": \"runtime\",\n  \"builtAt\": \"2026-04-22T00:00:00Z\"\n}}\n"
            ),
        );
    }

    #[test]
    fn validates_bundled_runtime_manifest() {
        let root = make_temp_dir("bundled-valid");
        write_manifest(
            &root,
            expected_manifest_platform(),
            expected_manifest_arch(),
        );
        write_fake_executable(&root.join("runtime/pi"));
        let agent_dir = make_temp_dir("agent-dir");

        let runtime = validate_bundled_runtime_root(&root, RuntimeMode::Packaged, &agent_dir)
            .expect("bundled runtime should validate");

        assert_eq!(runtime.source, "bundled");
        assert_eq!(runtime.version.as_deref(), Some("0.68.1"));
        assert_eq!(
            runtime.package_dir.as_deref(),
            Some(root.join("runtime").as_path())
        );
    }

    #[test]
    fn rejects_incompatible_bundled_runtime() {
        let root = make_temp_dir("bundled-incompatible");
        write_manifest(&root, "darwin", "x64");
        write_fake_executable(&root.join("runtime/pi"));
        let agent_dir = make_temp_dir("agent-dir-incompatible");

        let error = validate_bundled_runtime_root(&root, RuntimeMode::Packaged, &agent_dir)
            .expect_err("bundled runtime should be rejected");

        assert_eq!(
            error.error_kind.as_deref(),
            Some("bundled_runtime_incompatible")
        );
    }

    #[test]
    fn runtime_environment_sets_agent_dir_and_package_dir_for_bundled_runtime() {
        let runtime = ResolvedPiRuntime {
            source: "bundled".into(),
            mode: "packaged".into(),
            executable_path: PathBuf::from("/tmp/pi-runtime/runtime/pi"),
            package_dir: Some(PathBuf::from("/tmp/pi-runtime/runtime")),
            agent_dir: PathBuf::from("/tmp/orchestra/runtime/pi/agent"),
            version: Some("0.68.1".into()),
            built_at: Some("2026-04-22T00:00:00Z".into()),
            manifest_path: Some(PathBuf::from("/tmp/pi-runtime/manifest.json")),
        };

        let environment = runtime_environment_variables(&runtime, None);
        let map = environment.into_iter().collect::<HashMap<_, _>>();
        assert_eq!(
            map.get("PI_CODING_AGENT_DIR"),
            Some(&"/tmp/orchestra/runtime/pi/agent".to_string())
        );
        assert_eq!(
            map.get("PI_PACKAGE_DIR"),
            Some(&"/tmp/pi-runtime/runtime".to_string())
        );
    }
}
