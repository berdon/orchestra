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
            project_session_dir(&root, "Orchestra App"),
            PathBuf::from("/tmp/home/.orchestra/projects/orchestra-app/sessions")
        );
        assert_eq!(
            project_settings_path(&root, "Orchestra App"),
            PathBuf::from("/tmp/home/.orchestra/projects/orchestra-app/settings.json")
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
}
