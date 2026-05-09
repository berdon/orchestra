use std::env;
use std::path::{Path, PathBuf};

use tauri::{path::BaseDirectory, AppHandle, Manager};

const ORCHESTRA_EXTENSION_RELATIVE_PATH: &str = "extensions/orchestra-tools.ts";

#[derive(Debug, Clone)]
struct OrchestraExtensionCandidates {
    explicit_override: Option<PathBuf>,
    project_root: Option<PathBuf>,
    dev_checkout_root: Option<PathBuf>,
    runtime_checkout_root: Option<PathBuf>,
    packaged_resource: Option<PathBuf>,
    packaged_resource_error: Option<String>,
}

fn non_empty_candidate_path(path: Option<PathBuf>) -> Option<PathBuf> {
    path.filter(|path| !path.as_os_str().is_empty())
}

fn source_checkout_orchestra_extension_path(root: &Path) -> PathBuf {
    root.join(ORCHESTRA_EXTENSION_RELATIVE_PATH)
}

fn resolve_orchestra_extension_path_from(
    candidates: OrchestraExtensionCandidates,
) -> Result<PathBuf, String> {
    let OrchestraExtensionCandidates {
        explicit_override,
        project_root,
        dev_checkout_root,
        runtime_checkout_root,
        packaged_resource,
        packaged_resource_error,
    } = candidates;

    let mut checked_paths = Vec::new();

    if let Some(path) = explicit_override {
        checked_paths.push(format!("ORCHESTRA_EXTENSION_PATH={}", path.display()));
        if path.exists() {
            return Ok(path);
        }
    }

    if let Some(project_root) = project_root {
        let path = source_checkout_orchestra_extension_path(&project_root);
        checked_paths.push(format!(
            "ORCHESTRA_PROJECT_ROOT/extensions/orchestra-tools.ts={}",
            path.display()
        ));
        if path.exists() {
            return Ok(path);
        }
    }

    if let Some(dev_checkout_root) = dev_checkout_root {
        let path = source_checkout_orchestra_extension_path(&dev_checkout_root);
        checked_paths.push(format!(
            "dev_checkout/extensions/orchestra-tools.ts={}",
            path.display()
        ));
        if path.exists() {
            return Ok(path);
        }
    }

    if let Some(path) = packaged_resource {
        checked_paths.push(format!("packaged_resource={}", path.display()));
        if path.exists() {
            return Ok(path);
        }
    }

    if let Some(runtime_checkout_root) = runtime_checkout_root {
        let path = source_checkout_orchestra_extension_path(&runtime_checkout_root);
        checked_paths.push(format!(
            "runtime_checkout/extensions/orchestra-tools.ts={}",
            path.display()
        ));
        if path.exists() {
            return Ok(path);
        }
    }

    let mut message = format!(
        "Unable to resolve Orchestra extension path. Checked {}",
        checked_paths.join(", ")
    );
    if let Some(error) = packaged_resource_error {
        message.push_str(&format!("; packaged resource resolver error: {error}"));
    }
    Err(message)
}

pub fn resolve_packaged_orchestra_extension_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .resolve(ORCHESTRA_EXTENSION_RELATIVE_PATH, BaseDirectory::Resource)
        .map_err(|error| format!("Unable to resolve packaged Orchestra extension path: {error}"))
}

pub fn resolve_orchestra_extension_path(app: Option<&AppHandle>) -> Result<PathBuf, String> {
    let (packaged_resource, packaged_resource_error) = match app {
        Some(app) => match resolve_packaged_orchestra_extension_path(app) {
            Ok(path) => (Some(path), None),
            Err(error) => (None, Some(error)),
        },
        None => (None, None),
    };

    resolve_orchestra_extension_path_from(OrchestraExtensionCandidates {
        explicit_override: non_empty_candidate_path(
            env::var_os("ORCHESTRA_EXTENSION_PATH").map(PathBuf::from),
        ),
        project_root: configured_project_root(),
        dev_checkout_root: discover_dev_checkout_root(),
        runtime_checkout_root: current_orchestra_checkout_root(),
        packaged_resource,
        packaged_resource_error,
    })
}

pub fn configured_checkout_root() -> Option<PathBuf> {
    env::var_os("ORCHESTRA_PROJECT_ROOT")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

pub fn find_checkout_root_from(start: &Path) -> Option<PathBuf> {
    let mut current = if start.is_file() {
        start.parent()?.to_path_buf()
    } else {
        start.to_path_buf()
    };

    loop {
        if current.join("package.json").is_file()
            && current.join("src-tauri/tauri.conf.json").is_file()
        {
            return Some(current);
        }
        if !current.pop() {
            return None;
        }
    }
}

pub fn current_orchestra_checkout_root() -> Option<PathBuf> {
    configured_checkout_root()
        .or_else(|| {
            env::current_dir()
                .ok()
                .and_then(|path| find_checkout_root_from(&path))
        })
        .or_else(|| {
            env::current_exe()
                .ok()
                .and_then(|path| find_checkout_root_from(&path))
        })
}

pub fn sanitize_slug(value: &str) -> String {
    let mut slug = String::new();
    let mut last_was_dash = false;

    for ch in value.trim().chars().flat_map(|ch| ch.to_lowercase()) {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            last_was_dash = false;
        } else if !last_was_dash {
            slug.push('-');
            last_was_dash = true;
        }
    }

    let trimmed = slug.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "project".into()
    } else {
        trimmed
    }
}

pub fn orchestra_root_from_home(home_dir: &Path) -> PathBuf {
    home_dir.join(".orchestra")
}

pub fn configured_project_root() -> Option<PathBuf> {
    env::var_os("ORCHESTRA_PROJECT_ROOT")
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

pub fn infer_project_slug(project_root: &Path) -> String {
    let file_name = project_root
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("orchestra");

    if file_name == "repository" {
        return project_root
            .parent()
            .and_then(Path::file_name)
            .and_then(|value| value.to_str())
            .map(sanitize_slug)
            .unwrap_or_else(|| "orchestra".into());
    }

    if project_root
        .parent()
        .and_then(Path::file_name)
        .and_then(|value| value.to_str())
        == Some("worktrees")
    {
        return project_root
            .parent()
            .and_then(Path::parent)
            .and_then(Path::file_name)
            .and_then(|value| value.to_str())
            .map(sanitize_slug)
            .unwrap_or_else(|| "orchestra".into());
    }

    sanitize_slug(file_name)
}

pub fn is_dev_checkout_root(path: &Path) -> bool {
    path.join("src-tauri/Cargo.toml").is_file()
        && path.join("package.json").is_file()
        && path.join("mobile").is_dir()
}

fn discover_dev_checkout_root_from(path: &Path) -> Option<PathBuf> {
    path.ancestors()
        .find(|candidate| is_dev_checkout_root(candidate))
        .map(Path::to_path_buf)
}

pub fn discover_dev_checkout_root() -> Option<PathBuf> {
    if let Some(configured) = configured_project_root().filter(|path| is_dev_checkout_root(path)) {
        return Some(configured);
    }

    if let Ok(current_dir) = env::current_dir() {
        if let Some(found) = discover_dev_checkout_root_from(&current_dir) {
            return Some(found);
        }
    }

    if let Ok(current_exe) = env::current_exe() {
        if let Some(found) = current_exe
            .parent()
            .and_then(discover_dev_checkout_root_from)
        {
            return Some(found);
        }
    }

    None
}

pub fn default_orchestra_root() -> Result<PathBuf, String> {
    if let Some(explicit_root) = env::var_os("ORCHESTRA_STORAGE_ROOT") {
        let root = PathBuf::from(explicit_root);
        if !root.as_os_str().is_empty() {
            return Ok(root);
        }
    }

    env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| orchestra_root_from_home(&home))
        .ok_or_else(|| "HOME is not set; unable to resolve Orchestra storage root".into())
}

pub fn orchestra_database_path(root: &Path) -> PathBuf {
    root.join("orchestra.db")
}

pub fn orchestra_settings_path(root: &Path) -> PathBuf {
    root.join("settings.json")
}

pub fn orchestra_runtime_root(root: &Path) -> PathBuf {
    root.join("runtime")
}

pub fn orchestra_runtime_dir(root: &Path) -> PathBuf {
    orchestra_runtime_root(root)
}

pub fn orchestra_skills_dir(root: &Path) -> PathBuf {
    root.join("skills")
}

pub fn orchestra_local_skill_path(root: &Path, slug: &str) -> PathBuf {
    orchestra_skills_dir(root).join(format!("{}.md", sanitize_slug(slug)))
}

pub fn pi_runtime_root(root: &Path) -> PathBuf {
    orchestra_runtime_root(root).join("pi")
}

pub fn pi_agent_dir(root: &Path) -> PathBuf {
    pi_runtime_root(root).join("agent")
}

pub fn orchestra_pi_agent_skills_dir(root: &Path) -> PathBuf {
    orchestra_pi_agent_dir(root).join("skills")
}

pub fn orchestra_pi_skill_snapshots_dir(root: &Path) -> PathBuf {
    orchestra_pi_root(root).join("skill-snapshots")
}

pub fn orchestra_pi_root(root: &Path) -> PathBuf {
    pi_runtime_root(root)
}

pub fn orchestra_pi_agent_dir(root: &Path) -> PathBuf {
    pi_agent_dir(root)
}

pub fn orchestra_pi_auth_path(root: &Path) -> PathBuf {
    orchestra_pi_agent_dir(root).join("auth.json")
}

pub fn orchestra_pi_models_path(root: &Path) -> PathBuf {
    orchestra_pi_agent_dir(root).join("models.json")
}

pub fn orchestra_pi_settings_path(root: &Path) -> PathBuf {
    orchestra_pi_agent_dir(root).join("settings.json")
}

pub fn legacy_pi_agent_dir_from_home(home_dir: &Path) -> PathBuf {
    home_dir.join(".pi").join("agent")
}

pub fn legacy_pi_agent_dir() -> Result<PathBuf, String> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| legacy_pi_agent_dir_from_home(&home))
        .ok_or_else(|| "HOME is not set; unable to resolve legacy Pi agent directory".into())
}

pub fn project_root(root: &Path, project_slug: &str) -> PathBuf {
    root.join("projects").join(sanitize_slug(project_slug))
}

pub fn project_session_dir(root: &Path, project_slug: &str) -> PathBuf {
    project_root(root, project_slug).join("sessions")
}

pub fn project_settings_path(root: &Path, project_slug: &str) -> PathBuf {
    project_root(root, project_slug).join("settings.json")
}

pub fn project_repositories_dir(root: &Path, project_slug: &str) -> PathBuf {
    project_root(root, project_slug).join("repositories")
}

pub fn managed_repository_root(root: &Path, project_slug: &str, repository_slug: &str) -> PathBuf {
    project_repositories_dir(root, project_slug).join(sanitize_slug(repository_slug))
}

pub fn managed_repository_checkout_dir(
    root: &Path,
    project_slug: &str,
    repository_slug: &str,
) -> PathBuf {
    managed_repository_root(root, project_slug, repository_slug).join("repository")
}

pub fn project_attachments_dir(root: &Path, project_slug: &str) -> PathBuf {
    project_root(root, project_slug).join("attachments")
}

pub fn task_attachments_dir(root: &Path, project_slug: &str, task_id: &str) -> PathBuf {
    project_attachments_dir(root, project_slug).join(task_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "{}-{}-{}",
            label,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock should be after epoch")
                .as_nanos()
        ))
    }

    fn write_extension(root: &Path) -> PathBuf {
        let path = root.join(ORCHESTRA_EXTENSION_RELATIVE_PATH);
        std::fs::create_dir_all(path.parent().expect("extension path should have parent"))
            .expect("extension parent should exist");
        std::fs::write(&path, "export const tools = [];\n")
            .expect("extension path should be writable");
        path
    }

    #[test]
    fn sanitizes_project_slugs() {
        assert_eq!(sanitize_slug(" Orchestra App "), "orchestra-app");
        assert_eq!(sanitize_slug("QA / Reviewer Role"), "qa-reviewer-role");
        assert_eq!(sanitize_slug("***"), "project");
    }

    #[test]
    fn builds_project_session_dir_under_orchestra_root() {
        let root = PathBuf::from("/tmp/home/.orchestra");
        assert_eq!(
            orchestra_database_path(&root),
            PathBuf::from("/tmp/home/.orchestra/orchestra.db")
        );
        assert_eq!(
            orchestra_settings_path(&root),
            PathBuf::from("/tmp/home/.orchestra/settings.json")
        );
        assert_eq!(
            orchestra_runtime_root(&root),
            PathBuf::from("/tmp/home/.orchestra/runtime")
        );
        assert_eq!(
            orchestra_runtime_dir(&root),
            PathBuf::from("/tmp/home/.orchestra/runtime")
        );
        assert_eq!(
            orchestra_skills_dir(&root),
            PathBuf::from("/tmp/home/.orchestra/skills")
        );
        assert_eq!(
            orchestra_local_skill_path(&root, "My New Skill"),
            PathBuf::from("/tmp/home/.orchestra/skills/my-new-skill.md")
        );
        assert_eq!(
            orchestra_pi_root(&root),
            PathBuf::from("/tmp/home/.orchestra/runtime/pi")
        );
        assert_eq!(
            pi_runtime_root(&root),
            PathBuf::from("/tmp/home/.orchestra/runtime/pi")
        );
        assert_eq!(
            orchestra_pi_agent_dir(&root),
            PathBuf::from("/tmp/home/.orchestra/runtime/pi/agent")
        );
        assert_eq!(
            pi_agent_dir(&root),
            PathBuf::from("/tmp/home/.orchestra/runtime/pi/agent")
        );
        assert_eq!(
            orchestra_pi_auth_path(&root),
            PathBuf::from("/tmp/home/.orchestra/runtime/pi/agent/auth.json")
        );
        assert_eq!(
            orchestra_pi_models_path(&root),
            PathBuf::from("/tmp/home/.orchestra/runtime/pi/agent/models.json")
        );
        assert_eq!(
            orchestra_pi_settings_path(&root),
            PathBuf::from("/tmp/home/.orchestra/runtime/pi/agent/settings.json")
        );
        assert_eq!(
            orchestra_pi_agent_skills_dir(&root),
            PathBuf::from("/tmp/home/.orchestra/runtime/pi/agent/skills")
        );
        assert_eq!(
            orchestra_pi_skill_snapshots_dir(&root),
            PathBuf::from("/tmp/home/.orchestra/runtime/pi/skill-snapshots")
        );
        assert_eq!(
            project_session_dir(&root, "Orchestra App"),
            PathBuf::from("/tmp/home/.orchestra/projects/orchestra-app/sessions")
        );
        assert_eq!(
            project_settings_path(&root, "Orchestra App"),
            PathBuf::from("/tmp/home/.orchestra/projects/orchestra-app/settings.json")
        );
        assert_eq!(
            legacy_pi_agent_dir_from_home(Path::new("/tmp/home")),
            PathBuf::from("/tmp/home/.pi/agent")
        );
    }

    #[test]
    fn finds_checkout_root_from_repo_and_target_paths() {
        let temp_root = std::env::temp_dir().join(format!(
            "orchestra-paths-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time should be after unix epoch")
                .as_nanos()
        ));
        let root = temp_root.join("orchestra-checkout");
        std::fs::create_dir_all(root.join("src-tauri/src/services"))
            .expect("repo source tree should be created");
        std::fs::create_dir_all(root.join("src-tauri/target/release"))
            .expect("repo target tree should be created");
        std::fs::write(root.join("package.json"), "{}")
            .expect("package.json sentinel should be created");
        std::fs::write(root.join("src-tauri/tauri.conf.json"), "{}")
            .expect("tauri.conf sentinel should be created");
        std::fs::write(root.join("src-tauri/target/release/orchestra"), "")
            .expect("binary sentinel should be created");

        let nested_repo_path = root.join("src-tauri/src/services");
        let nested_target_binary = root.join("src-tauri/target/release/orchestra");

        assert_eq!(
            find_checkout_root_from(&nested_repo_path),
            Some(root.clone())
        );
        assert_eq!(
            find_checkout_root_from(&nested_target_binary),
            Some(root.clone())
        );

        std::fs::remove_dir_all(temp_root).expect("temp checkout should be removed");
    }

    #[test]
    fn infers_project_slug_from_repository_and_worktree_roots() {
        assert_eq!(
            infer_project_slug(Path::new(
                "/tmp/orchestra/repositories/orchestra/repository"
            )),
            "orchestra"
        );
        assert_eq!(
            infer_project_slug(Path::new(
                "/tmp/orchestra/repositories/orchestra/worktrees/feature-1"
            )),
            "orchestra"
        );
        assert_eq!(
            infer_project_slug(Path::new("/tmp/client-project")),
            "client-project"
        );
    }

    #[test]
    fn detects_dev_checkout_root_from_nested_path() {
        let root = std::env::temp_dir().join(format!(
            "orchestra-paths-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock should be after epoch")
                .as_nanos()
        ));
        let nested = root.join("src-tauri/target/debug");
        std::fs::create_dir_all(root.join("src-tauri")).expect("src-tauri should exist");
        std::fs::create_dir_all(root.join("mobile")).expect("mobile should exist");
        std::fs::create_dir_all(&nested).expect("nested path should exist");
        std::fs::write(
            root.join("src-tauri/Cargo.toml"),
            "[package]\nname = \"orchestra\"\n",
        )
        .expect("cargo manifest should write");
        std::fs::write(root.join("package.json"), "{}\n").expect("package manifest should write");

        assert!(is_dev_checkout_root(&root));
        assert_eq!(discover_dev_checkout_root_from(&nested), Some(root.clone()));

        std::fs::remove_dir_all(root).expect("temp checkout should remove");
    }

    #[test]
    fn prefers_explicit_extension_override_before_other_candidates() {
        let root = unique_temp_dir("orchestra-extension-override");
        let override_root = root.join("override");
        let project_root = root.join("project");
        let dev_root = root.join("dev");
        let packaged_root = root.join("packaged");

        let override_path = write_extension(&override_root);
        write_extension(&project_root);
        write_extension(&dev_root);
        let packaged_path = write_extension(&packaged_root);

        let resolved = resolve_orchestra_extension_path_from(OrchestraExtensionCandidates {
            explicit_override: Some(override_path.clone()),
            project_root: Some(project_root),
            dev_checkout_root: Some(dev_root),
            runtime_checkout_root: None,
            packaged_resource: Some(packaged_path),
            packaged_resource_error: None,
        })
        .expect("override path should resolve");

        assert_eq!(resolved, override_path);
        std::fs::remove_dir_all(root).expect("temp directories should remove");
    }

    #[test]
    fn prefers_dev_checkout_when_packaged_resource_is_missing() {
        let root = unique_temp_dir("orchestra-extension-dev-fallback");
        let dev_root = root.join("dev");
        let expected = write_extension(&dev_root);
        let packaged_path = root.join("target/debug/extensions/orchestra-tools.ts");

        let resolved = resolve_orchestra_extension_path_from(OrchestraExtensionCandidates {
            explicit_override: None,
            project_root: None,
            dev_checkout_root: Some(dev_root),
            runtime_checkout_root: None,
            packaged_resource: Some(packaged_path),
            packaged_resource_error: None,
        })
        .expect("dev checkout path should resolve");

        assert_eq!(resolved, expected);
        std::fs::remove_dir_all(root).expect("temp directories should remove");
    }

    #[test]
    fn falls_back_to_packaged_resource_when_it_exists() {
        let root = unique_temp_dir("orchestra-extension-packaged");
        let packaged_root = root.join("packaged");
        let expected = write_extension(&packaged_root);

        let resolved = resolve_orchestra_extension_path_from(OrchestraExtensionCandidates {
            explicit_override: None,
            project_root: None,
            dev_checkout_root: None,
            runtime_checkout_root: None,
            packaged_resource: Some(expected.clone()),
            packaged_resource_error: None,
        })
        .expect("packaged resource should resolve");

        assert_eq!(resolved, expected);
        std::fs::remove_dir_all(root).expect("temp directories should remove");
    }

    #[test]
    fn ignores_empty_candidate_paths() {
        assert_eq!(non_empty_candidate_path(Some(PathBuf::new())), None);
        assert_eq!(
            non_empty_candidate_path(Some(PathBuf::from("/tmp/orchestra-tools.ts"))),
            Some(PathBuf::from("/tmp/orchestra-tools.ts"))
        );
    }

    #[test]
    fn prefers_explicit_storage_root_override() {
        let _guard = crate::test_support::global_test_env_lock()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let explicit_root = std::env::temp_dir().join(format!(
            "orchestra-storage-root-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock should be after epoch")
                .as_nanos()
        ));
        std::env::set_var("ORCHESTRA_STORAGE_ROOT", &explicit_root);

        assert_eq!(
            default_orchestra_root().expect("storage root should resolve"),
            explicit_root
        );

        std::env::remove_var("ORCHESTRA_STORAGE_ROOT");
    }
}
