use std::{
    env, fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::Value;

use crate::{
    models::{PiBunStatus, PiPackageDiagnostics, PiPackageSourceEntry, SessionModel},
    services::{
        orchestra_paths::{default_orchestra_root, orchestra_pi_settings_path, pi_agent_dir},
        pi_runtime, pi_sessions,
    },
};

pub struct PiAvailableModelsProbe {
    pub models: Vec<SessionModel>,
    pub package_diagnostics: PiPackageDiagnostics,
}

pub fn resolve_available_models_with_package_diagnostics() -> Result<PiAvailableModelsProbe, String>
{
    let orchestra_root = default_orchestra_root()?;
    let runtime = pi_runtime::resolve_pi_runtime(None).ok();
    let bun = resolve_bun_status(runtime.as_ref());
    resolve_available_models_with_query_and_bun(
        &orchestra_root,
        pi_runtime::legacy_pi_agent_dir()
            .as_ref()
            .map(|path| path.join("settings.json")),
        bun,
        |agent_dir| pi_sessions::list_available_models_for_agent_dir(agent_dir),
    )
}

fn resolve_available_models_with_query_and_bun<F>(
    orchestra_root: &Path,
    legacy_settings_path: Option<PathBuf>,
    bun: PiBunStatus,
    query_models: F,
) -> Result<PiAvailableModelsProbe, String>
where
    F: Fn(&Path) -> Result<Vec<SessionModel>, String>,
{
    let managed_agent_dir = pi_agent_dir(orchestra_root);
    let sources = collect_package_sources_in(orchestra_root, legacy_settings_path.as_deref())?;
    let mut diagnostics = PiPackageDiagnostics {
        bun,
        sources,
        blocking: false,
        package_free_probe_succeeded: false,
        package_free_model_count: 0,
        message: String::new(),
    };

    let active_sources = diagnostics
        .sources
        .iter()
        .filter(|source| source.active)
        .cloned()
        .collect::<Vec<_>>();

    if active_sources.is_empty() {
        diagnostics.message = if diagnostics.sources.is_empty() {
            "No package-based Pi sources were detected in Orchestra-managed or legacy Pi settings."
                .into()
        } else {
            "Package-based Pi sources were detected only in legacy Pi settings, so Orchestra is not using them for current model discovery."
                .into()
        };
        return Ok(PiAvailableModelsProbe {
            models: query_models(&managed_agent_dir)?,
            package_diagnostics: diagnostics,
        });
    }

    if diagnostics.bun.available {
        diagnostics.message = format!(
            "Package-based Pi sources are configured in Orchestra-managed settings and Bun is available{}.{}",
            diagnostics
                .bun
                .path
                .as_deref()
                .map(|path| format!(" at {}", path))
                .unwrap_or_default(),
            format_active_source_sentence(&active_sources)
        );
        return Ok(PiAvailableModelsProbe {
            models: query_models(&managed_agent_dir)?,
            package_diagnostics: diagnostics,
        });
    }

    let package_free_agent_dir = create_package_free_agent_dir(orchestra_root)?;
    let fallback = query_models(&package_free_agent_dir);
    let _ = fs::remove_dir_all(&package_free_agent_dir);

    match fallback {
        Ok(models) if !models.is_empty() => {
            diagnostics.package_free_probe_succeeded = true;
            diagnostics.package_free_model_count = models.len();
            diagnostics.message = format!(
                "Package-based Pi sources were detected in Orchestra-managed settings, but Orchestra still loaded {} package-free model{} after ignoring those sources because Bun is unavailable. Review Settings → Harness to remove stale package entries or install Bun for package-based sources.{}",
                models.len(),
                if models.len() == 1 { "" } else { "s" },
                format_active_source_sentence(&active_sources)
            );
            tracing::warn!(
                source_count = active_sources.len(),
                model_count = models.len(),
                "package-free Pi model probe succeeded after Bun was unavailable for Orchestra-managed package sources"
            );
            Ok(PiAvailableModelsProbe {
                models,
                package_diagnostics: diagnostics,
            })
        }
        Ok(models) => {
            diagnostics.blocking = true;
            diagnostics.package_free_model_count = models.len();
            diagnostics.message = format!(
                "Harness could not load package-based model sources because Bun is not available on PATH used for Orchestra subprocesses. Install Bun or remove those package sources in Settings → Harness.{}",
                format_active_source_sentence(&active_sources)
            );
            tracing::warn!(
                source_count = active_sources.len(),
                "Bun is unavailable and Orchestra-managed package sources blocked Pi model discovery"
            );
            Ok(PiAvailableModelsProbe {
                models: Vec::new(),
                package_diagnostics: diagnostics,
            })
        }
        Err(error) => {
            diagnostics.blocking = true;
            diagnostics.message = format!(
                "Harness could not load package-based model sources because Bun is not available on PATH used for Orchestra subprocesses. Install Bun or remove those package sources in Settings → Harness. Package-free fallback also failed: {error}.{}",
                format_active_source_sentence(&active_sources)
            );
            tracing::warn!(
                source_count = active_sources.len(),
                fallback_error = %error,
                "Bun is unavailable and the package-free Pi model probe also failed"
            );
            Ok(PiAvailableModelsProbe {
                models: Vec::new(),
                package_diagnostics: diagnostics,
            })
        }
    }
}

pub fn resolve_bun_status(runtime: Option<&pi_runtime::ResolvedPiRuntime>) -> PiBunStatus {
    let bundled_bun_path = runtime.and_then(|resolved| resolved.bundled_bun_path.as_ref());
    let path_value = pi_runtime::resolve_effective_subprocess_path(runtime)
        .or_else(|| pi_runtime::resolve_user_shell_path())
        .or_else(|| env::var("PATH").ok())
        .unwrap_or_default();

    for directory in env::split_paths(&path_value) {
        for candidate in bun_candidates_for_directory(&directory) {
            if candidate.is_file() {
                let message = if bundled_bun_path == Some(&candidate) {
                    format!(
                        "Bundled Bun is available at {} and Orchestra will use it for Pi subprocesses.",
                        candidate.display()
                    )
                } else {
                    format!("Bun is available at {}.", candidate.display())
                };
                return PiBunStatus {
                    available: true,
                    path: Some(candidate.display().to_string()),
                    message,
                };
            }
        }
    }

    PiBunStatus {
        available: false,
        path: None,
        message: "Bun is not available on the PATH Orchestra uses for runtime subprocesses.".into(),
    }
}

fn bun_candidates_for_directory(directory: &Path) -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        vec![directory.join("bun.exe"), directory.join("bun.cmd")]
    }

    #[cfg(not(windows))]
    {
        vec![directory.join("bun")]
    }
}

fn collect_package_sources_in(
    orchestra_root: &Path,
    legacy_settings_path: Option<&Path>,
) -> Result<Vec<PiPackageSourceEntry>, String> {
    let mut sources = Vec::new();

    maybe_push_packages_entry(
        &mut sources,
        &orchestra_pi_settings_path(orchestra_root),
        "runtime_settings_packages",
        "runtime_owned",
        true,
    )?;

    if let Some(path) = legacy_settings_path {
        maybe_push_packages_entry(
            &mut sources,
            path,
            "legacy_settings_packages",
            "legacy",
            false,
        )?;
    }

    Ok(sources)
}

fn maybe_push_packages_entry(
    sources: &mut Vec<PiPackageSourceEntry>,
    path: &Path,
    source_kind: &str,
    source_scope: &str,
    active: bool,
) -> Result<(), String> {
    let Some(entries) = read_settings_packages(path)? else {
        return Ok(());
    };
    if entries.is_empty() {
        return Ok(());
    }
    sources.push(PiPackageSourceEntry {
        source_kind: source_kind.into(),
        source_scope: source_scope.into(),
        source_path: path.display().to_string(),
        entries,
        active,
    });
    Ok(())
}

fn read_settings_packages(path: &Path) -> Result<Option<Vec<String>>, String> {
    if !path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(path)
        .map_err(|error| format!("Unable to read {}: {error}", path.display()))?;
    let parsed: Value = serde_json::from_str(&content)
        .map_err(|error| format!("Unable to parse {}: {error}", path.display()))?;
    let Some(object) = parsed.as_object() else {
        return Ok(Some(Vec::new()));
    };

    let entries = object
        .get("packages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .fold(Vec::new(), |mut entries, entry| {
            if !entries.iter().any(|existing| existing == entry) {
                entries.push(entry.to_string());
            }
            entries
        });

    Ok(Some(entries))
}

fn create_package_free_agent_dir(orchestra_root: &Path) -> Result<PathBuf, String> {
    let source_agent_dir = pi_agent_dir(orchestra_root);
    let temp_root = env::temp_dir().join(format!(
        "orchestra-package-free-agent-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    fs::create_dir_all(&temp_root).map_err(|error| {
        format!(
            "Unable to create temporary package-free Pi agent directory {}: {error}",
            temp_root.display()
        )
    })?;

    copy_if_exists(
        &source_agent_dir.join("auth.json"),
        &temp_root.join("auth.json"),
    )?;
    copy_if_exists(
        &source_agent_dir.join("models.json"),
        &temp_root.join("models.json"),
    )?;
    copy_filtered_settings(
        &source_agent_dir.join("settings.json"),
        &temp_root.join("settings.json"),
    )?;
    Ok(temp_root)
}

fn copy_if_exists(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }
    fs::copy(source, destination).map(|_| ()).map_err(|error| {
        format!(
            "Unable to copy {} to {}: {error}",
            source.display(),
            destination.display()
        )
    })
}

fn copy_filtered_settings(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }

    let mut settings: Value = serde_json::from_slice(
        &fs::read(source)
            .map_err(|error| format!("Unable to read {}: {error}", source.display()))?,
    )
    .map_err(|error| format!("Unable to parse {}: {error}", source.display()))?;

    if let Some(object) = settings.as_object_mut() {
        object.remove("packages");
    }

    fs::write(
        destination,
        serde_json::to_vec_pretty(&settings)
            .map_err(|error| format!("Unable to serialize filtered settings: {error}"))?,
    )
    .map_err(|error| format!("Unable to write {}: {error}", destination.display()))
}

fn format_active_source_sentence(sources: &[PiPackageSourceEntry]) -> String {
    if sources.is_empty() {
        return String::new();
    }

    let rendered = sources
        .iter()
        .map(|source| format!("{} [{}]", source.source_path, source.entries.join(", ")))
        .collect::<Vec<_>>()
        .join("; ");
    format!(
        " Detected source{}: {}.",
        if sources.len() == 1 { "" } else { "s" },
        rendered
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp_dir(label: &str) -> PathBuf {
        env::temp_dir().join(format!(
            "{}-{}-{}",
            label,
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time should move forward")
                .as_nanos()
        ))
    }

    fn write_json(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("parent dir should exist");
        }
        fs::write(path, content).expect("file should be written");
    }

    fn missing_bun_status() -> PiBunStatus {
        PiBunStatus {
            available: false,
            path: None,
            message: "missing".into(),
        }
    }

    #[test]
    fn resolve_bun_status_reports_bundled_bun_path() {
        let root = unique_temp_dir("orc-bundled-bun-status");
        let bundled_bun_path = if cfg!(windows) {
            root.join("bun").join("bun.exe")
        } else {
            root.join("bun").join("bun")
        };
        write_json(&bundled_bun_path, "#!/bin/sh\n");
        let runtime = pi_runtime::ResolvedPiRuntime {
            source: "bundled".into(),
            mode: "packaged".into(),
            executable_path: root.join("runtime").join("pi"),
            package_dir: Some(root.join("runtime")),
            bundled_bun_path: Some(bundled_bun_path.clone()),
            agent_dir: root.join("agent"),
            version: Some("0.68.1".into()),
            built_at: Some("test".into()),
            manifest_path: Some(root.join("manifest.json")),
        };

        let status = resolve_bun_status(Some(&runtime));
        let expected_path = bundled_bun_path.display().to_string();

        assert!(status.available);
        assert_eq!(status.path.as_deref(), Some(expected_path.as_str()));
        assert!(status.message.contains("Bundled Bun is available"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn detects_runtime_and_legacy_settings_packages() {
        let orchestra_root = unique_temp_dir("orc-package-sources");
        let legacy_settings_path = unique_temp_dir("legacy-package-sources")
            .join(".pi")
            .join("agent")
            .join("settings.json");
        write_json(
            &orchestra_pi_settings_path(&orchestra_root),
            r#"{"packages":["npm:pi-subagents","./extensions/local.ts"]}"#,
        );
        write_json(
            &legacy_settings_path,
            r#"{"packages":["npm:legacy-package"]}"#,
        );

        let sources = collect_package_sources_in(&orchestra_root, Some(&legacy_settings_path))
            .expect("package sources should load");

        assert_eq!(sources.len(), 2);
        assert!(sources.iter().any(|source| {
            source.active
                && source.source_kind == "runtime_settings_packages"
                && source.entries == vec!["npm:pi-subagents", "./extensions/local.ts"]
        }));
        assert!(sources.iter().any(|source| {
            !source.active
                && source.source_kind == "legacy_settings_packages"
                && source.entries == vec!["npm:legacy-package"]
        }));

        let _ = fs::remove_dir_all(&orchestra_root);
        let _ = fs::remove_dir_all(
            legacy_settings_path
                .parent()
                .and_then(Path::parent)
                .unwrap(),
        );
    }

    #[test]
    fn suppresses_bun_block_when_package_free_probe_finds_models() {
        let orchestra_root = unique_temp_dir("orc-package-free-success");
        write_json(
            &orchestra_pi_settings_path(&orchestra_root),
            r#"{"packages":["npm:pi-subagents"]}"#,
        );
        let managed_agent_dir = pi_agent_dir(&orchestra_root);
        let fallback_models = vec![SessionModel {
            id: "model-1".into(),
            name: "Model 1".into(),
            provider: "openai".into(),
            api: "responses".into(),
            reasoning: true,
        }];

        let result = resolve_available_models_with_query_and_bun(
            &orchestra_root,
            None,
            missing_bun_status(),
            |agent_dir| {
                if agent_dir == managed_agent_dir.as_path() {
                    return Err("Failed to run bun pm bin -g".into());
                }
                Ok(fallback_models.clone())
            },
        )
        .expect("probe should succeed");

        assert_eq!(result.models.len(), 1);
        assert!(result.package_diagnostics.package_free_probe_succeeded);
        assert!(!result.package_diagnostics.blocking);
        assert!(result
            .package_diagnostics
            .message
            .contains("Settings → Harness"));

        let _ = fs::remove_dir_all(&orchestra_root);
    }

    #[test]
    fn reports_blocking_bun_requirement_when_no_package_free_models_exist() {
        let orchestra_root = unique_temp_dir("orc-package-free-blocked");
        write_json(
            &orchestra_pi_settings_path(&orchestra_root),
            r#"{"packages":["npm:pi-subagents"]}"#,
        );
        let managed_agent_dir = pi_agent_dir(&orchestra_root);

        let result = resolve_available_models_with_query_and_bun(
            &orchestra_root,
            None,
            missing_bun_status(),
            |agent_dir| {
                if agent_dir == managed_agent_dir.as_path() {
                    return Err("Failed to run bun pm bin -g".into());
                }
                Ok(Vec::new())
            },
        )
        .expect("probe should succeed");

        assert!(result.models.is_empty());
        assert!(result.package_diagnostics.blocking);
        assert!(!result.package_diagnostics.package_free_probe_succeeded);
        assert!(result
            .package_diagnostics
            .message
            .contains("Harness could not load package-based model sources"));

        let _ = fs::remove_dir_all(&orchestra_root);
    }
}
