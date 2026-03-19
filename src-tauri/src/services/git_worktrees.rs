use std::{
    ffi::OsStr,
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use crate::services::orchestra_paths::sanitize_slug;

pub fn ensure_role_worktree(
    project_root: &Path,
    role_slug: &str,
    instance_id: &str,
) -> Result<PathBuf, String> {
    let path = runtime_worktree_path(project_root, role_slug, instance_id);
    if path.exists() {
        return Ok(path);
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Unable to create worktree parent {}: {error}",
                parent.display()
            )
        })?;
    }

    if let Err(error) = git(
        project_root,
        vec![
            OsStr::new("worktree"),
            OsStr::new("add"),
            OsStr::new("--detach"),
            path.as_os_str(),
            OsStr::new("origin/main"),
        ],
    ) {
        git(
            project_root,
            vec![
                OsStr::new("worktree"),
                OsStr::new("add"),
                OsStr::new("--detach"),
                path.as_os_str(),
                OsStr::new("HEAD"),
            ],
        )
        .map_err(|fallback_error| {
            format!(
                "Unable to create role worktree {}. origin/main failed: {error}. HEAD fallback failed: {fallback_error}",
                path.display()
            )
        })?;
    }

    Ok(path)
}

pub fn dispose_worktree(project_root: &Path, worktree_path: &Path) -> Result<(), String> {
    if !worktree_path.exists() {
        return Ok(());
    }

    git(
        project_root,
        vec![
            OsStr::new("worktree"),
            OsStr::new("remove"),
            OsStr::new("--force"),
            worktree_path.as_os_str(),
        ],
    )
    .map_err(|error| {
        format!(
            "Unable to remove role worktree {}: {error}",
            worktree_path.display()
        )
    })
}

fn runtime_worktree_path(project_root: &Path, role_slug: &str, instance_id: &str) -> PathBuf {
    let suffix = instance_id
        .rsplit('-')
        .next()
        .unwrap_or(instance_id)
        .chars()
        .take(8)
        .collect::<String>();
    worktrees_root(project_root).join(format!("runtime-{}-{}", sanitize_slug(role_slug), suffix))
}

fn worktrees_root(project_root: &Path) -> PathBuf {
    if project_root.file_name().and_then(|value| value.to_str()) == Some("repository") {
        return project_root
            .parent()
            .map(|parent| parent.join("worktrees"))
            .unwrap_or_else(|| project_root.join("worktrees"));
    }

    if project_root
        .parent()
        .and_then(|value| value.file_name())
        .and_then(|value| value.to_str())
        == Some("worktrees")
    {
        return project_root
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| project_root.join("worktrees"));
    }

    project_root.join("worktrees")
}

fn git<I, S>(project_root: &Path, args: I) -> Result<(), String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let output = Command::new("git")
        .arg("-C")
        .arg(project_root)
        .args(args)
        .output()
        .map_err(|error| {
            format!(
                "Unable to execute git in {}: {error}",
                project_root.display()
            )
        })?;

    if output.status.success() {
        return Ok(());
    }

    Err(format!(
        "{}",
        String::from_utf8_lossy(&output.stderr).trim().to_string()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        env,
        fs::File,
        io::Write,
        process::Command,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn unique_temp_dir(label: &str) -> PathBuf {
        let suffix = format!(
            "{}-{}-{}",
            label,
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time should move forward")
                .as_millis()
        );
        env::temp_dir().join(suffix)
    }

    fn init_test_repo(label: &str) -> PathBuf {
        let root = unique_temp_dir(label);
        fs::create_dir_all(root.join("repository")).expect("repository dir should create");
        let repo = root.join("repository");

        Command::new("git")
            .arg("-C")
            .arg(&repo)
            .arg("init")
            .arg("-b")
            .arg("main")
            .status()
            .expect("git init should run");
        Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["config", "user.email", "test@example.com"])
            .status()
            .expect("git config email should run");
        Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["config", "user.name", "Test User"])
            .status()
            .expect("git config name should run");

        let mut file = File::create(repo.join("README.md")).expect("README should create");
        writeln!(file, "test repo").expect("README should write");

        Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["add", "README.md"])
            .status()
            .expect("git add should run");
        Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["commit", "-m", "init"])
            .status()
            .expect("git commit should run");

        repo
    }

    #[test]
    fn creates_and_disposes_runtime_worktrees() {
        let repo = init_test_repo("runtime-worktree");
        let worktree_path = ensure_role_worktree(&repo, "Reviewer", "instance-12345678")
            .expect("worktree should create");

        assert!(worktree_path.exists());
        assert!(worktree_path.ends_with("runtime-reviewer-12345678"));

        dispose_worktree(&repo, &worktree_path).expect("worktree should dispose");
        assert!(!worktree_path.exists());
    }
}
