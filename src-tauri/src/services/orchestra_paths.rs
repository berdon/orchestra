use std::env;
use std::path::{Path, PathBuf};

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

pub fn pi_runtime_root(root: &Path) -> PathBuf {
    orchestra_runtime_root(root).join("pi")
}

pub fn pi_agent_dir(root: &Path) -> PathBuf {
    pi_runtime_root(root).join("agent")
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
}
