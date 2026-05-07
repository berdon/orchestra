use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use chrono::Utc;
use rusqlite::Connection;

use crate::{
    models::{TaskPullRequestDetail, TaskPullRequestFile, TaskPullRequestRepository},
    services::{task_repositories, task_runtime},
};

const EMPTY_TREE_HASH: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

#[derive(Debug, Clone)]
struct ReviewRepositoryTarget {
    repository_id: String,
    repository_name: String,
    repository_slug: String,
    managed_repository_path: Option<String>,
    task_worktree_path: Option<String>,
    default_branch: Option<String>,
}

#[derive(Debug, Clone)]
struct NameStatusEntry {
    change_type: String,
    old_path: Option<String>,
    new_path: Option<String>,
}

#[derive(Debug, Clone)]
struct ParsedPatchSegment {
    old_path: Option<String>,
    new_path: Option<String>,
    change_type: String,
    display_path: String,
    additions: i64,
    deletions: i64,
    is_binary: bool,
    patch: Option<String>,
}

impl NameStatusEntry {
    fn key(&self) -> String {
        file_key(self.old_path.as_deref(), self.new_path.as_deref())
    }

    fn display_path(&self) -> String {
        self.new_path
            .clone()
            .or_else(|| self.old_path.clone())
            .unwrap_or_default()
    }
}

pub fn get_task_pull_request(
    connection: &Connection,
    task_id: &str,
) -> Result<TaskPullRequestDetail, String> {
    let review_targets = load_review_targets(connection, task_id)?;
    let repositories = review_targets
        .into_iter()
        .map(
            |target| match build_repository_pull_request_detail(target.clone()) {
                Ok(detail) => detail,
                Err(error) => build_unavailable_repository(
                    target,
                    format!("Unable to inspect PR changes for this repo: {error}"),
                ),
            },
        )
        .collect::<Vec<_>>();

    Ok(TaskPullRequestDetail {
        task_id: task_id.to_string(),
        generated_at: Utc::now().to_rfc3339(),
        repositories,
    })
}

fn load_review_targets(
    connection: &Connection,
    task_id: &str,
) -> Result<Vec<ReviewRepositoryTarget>, String> {
    let project_id: String = connection
        .query_row(
            "SELECT project_id FROM tasks WHERE id = ?1",
            [task_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Unable to resolve project for task {task_id}: {error}"))?;
    let task_workspace_root = task_runtime::get_active_lane_assignment(connection, task_id)?
        .as_ref()
        .map(|assignment| {
            task_runtime::resolve_assignment_workspace_cwd(
                connection,
                assignment,
                task_id,
                &project_id,
            )
        })
        .transpose()?
        .flatten();

    let mut statement = connection
        .prepare(
            r#"
            SELECT repo.id, repo.name, repo.slug, repo.local_path, repo.default_branch
            FROM task_repositories tr
            JOIN repositories repo ON repo.id = tr.repository_id
            WHERE tr.task_id = ?1
            ORDER BY tr.created_at ASC, repo.name ASC, repo.id ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare task PR repository query: {error}"))?;

    let rows = statement
        .query_map([task_id], |row| {
            Ok(ReviewRepositoryTarget {
                repository_id: row.get(0)?,
                repository_name: row.get(1)?,
                repository_slug: row.get(2)?,
                managed_repository_path: row.get(3)?,
                task_worktree_path: task_workspace_root.as_deref().map(|workspace_root| {
                    task_repositories::task_repository_worktree_path(
                        workspace_root,
                        row.get::<_, String>(2)
                            .expect("slug should decode")
                            .as_str(),
                    )
                }),
                default_branch: row.get(4)?,
            })
        })
        .map_err(|error| format!("Unable to query task PR repositories for {task_id}: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to collect task PR repositories for {task_id}: {error}"))
}

fn build_repository_pull_request_detail(
    target: ReviewRepositoryTarget,
) -> Result<TaskPullRequestRepository, String> {
    let review_root = select_review_root(&target);
    let Some((review_root_path, review_root_kind)) = review_root else {
        return Ok(build_unavailable_repository(
            target,
            "Neither the task worktree nor the managed repository path is available as a git checkout.",
        ));
    };

    let review_root = PathBuf::from(&review_root_path);
    let head_commit = git_optional_trimmed_stdout(&review_root, &["rev-parse", "HEAD"])?;
    let default_branch = target
        .default_branch
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "main".into());

    let (base_commit_hash, worktree_only) = match head_commit.as_deref() {
        Some(head) => match resolve_merge_base_commit(&review_root, head, &default_branch)? {
            Some(base_commit_hash) => (Some(base_commit_hash), false),
            None => (Some(head.to_string()), true),
        },
        None => (Some(EMPTY_TREE_HASH.into()), false),
    };

    let committed_entries = if let (Some(base_commit_hash), Some(head_commit)) =
        (base_commit_hash.as_deref(), head_commit.as_deref())
    {
        if base_commit_hash == head_commit {
            Vec::new()
        } else {
            parse_name_status_entries(&git_stdout(
                &review_root,
                &[
                    "diff",
                    "--name-status",
                    "--find-renames",
                    &format!("{base_commit_hash}..{head_commit}"),
                ],
            )?)?
        }
    } else {
        Vec::new()
    };

    let mut uncommitted_entries = if head_commit.is_some() {
        parse_name_status_entries(&git_stdout(
            &review_root,
            &["diff", "--name-status", "--find-renames", "HEAD"],
        )?)?
    } else {
        let mut staged = parse_name_status_entries(&git_stdout(
            &review_root,
            &[
                "diff",
                "--cached",
                "--name-status",
                "--find-renames",
                "--root",
            ],
        )?)?;
        let unstaged = parse_name_status_entries(&git_stdout(
            &review_root,
            &["diff", "--name-status", "--find-renames"],
        )?)?;
        staged.extend(unstaged);
        dedupe_name_status_entries(staged)
    };

    let untracked_files = list_untracked_files(&review_root)?;
    for relative_path in &untracked_files {
        uncommitted_entries.push(NameStatusEntry {
            change_type: "added".into(),
            old_path: None,
            new_path: Some(relative_path.clone()),
        });
    }
    uncommitted_entries = dedupe_name_status_entries(uncommitted_entries);

    let tracked_patch_output = if let Some(base_commit_hash) = base_commit_hash.as_deref() {
        if head_commit.is_some() {
            git_stdout(
                &review_root,
                &["diff", "--find-renames", "--no-ext-diff", base_commit_hash],
            )?
        } else {
            git_stdout(
                &review_root,
                &[
                    "diff",
                    "--cached",
                    "--find-renames",
                    "--no-ext-diff",
                    "--root",
                ],
            )?
        }
    } else {
        String::new()
    };

    let tracked_patch_segments = parse_patch_segments(&tracked_patch_output)?;
    let tracked_patch_by_key = tracked_patch_segments
        .into_iter()
        .map(|segment| {
            (
                file_key(segment.old_path.as_deref(), segment.new_path.as_deref()),
                segment,
            )
        })
        .collect::<HashMap<_, _>>();

    let committed_keys = committed_entries
        .iter()
        .map(NameStatusEntry::key)
        .collect::<HashSet<_>>();
    let uncommitted_keys = uncommitted_entries
        .iter()
        .map(NameStatusEntry::key)
        .collect::<HashSet<_>>();

    let mut entries_by_key = HashMap::new();
    for entry in committed_entries
        .into_iter()
        .chain(uncommitted_entries.clone().into_iter())
    {
        entries_by_key.entry(entry.key()).or_insert(entry);
    }

    let mut all_keys = entries_by_key.keys().cloned().collect::<HashSet<_>>();
    all_keys.extend(tracked_patch_by_key.keys().cloned());
    all_keys.extend(uncommitted_keys.iter().cloned());

    let mut files = Vec::new();
    for key in all_keys {
        let entry = entries_by_key.get(&key).cloned();
        if let Some(relative_path) = untracked_files
            .iter()
            .find(|path| file_key(None, Some(path.as_str())) == key)
        {
            let origin = classify_origin(&key, &committed_keys, &uncommitted_keys);
            files.push(build_untracked_file(
                &review_root,
                &target,
                relative_path,
                origin,
            )?);
            continue;
        }

        let patch_segment = tracked_patch_by_key.get(&key).cloned();
        let old_path = patch_segment
            .as_ref()
            .and_then(|segment| segment.old_path.clone())
            .or_else(|| entry.as_ref().and_then(|value| value.old_path.clone()));
        let new_path = patch_segment
            .as_ref()
            .and_then(|segment| segment.new_path.clone())
            .or_else(|| entry.as_ref().and_then(|value| value.new_path.clone()));
        let display_path = patch_segment
            .as_ref()
            .map(|segment| segment.display_path.clone())
            .or_else(|| entry.as_ref().map(NameStatusEntry::display_path))
            .unwrap_or_default();
        if display_path.is_empty() {
            continue;
        }
        let change_type = patch_segment
            .as_ref()
            .map(|segment| segment.change_type.clone())
            .or_else(|| entry.as_ref().map(|value| value.change_type.clone()))
            .unwrap_or_else(|| "modified".into());
        let origin = classify_origin(&key, &committed_keys, &uncommitted_keys);
        let additions = patch_segment
            .as_ref()
            .map(|segment| segment.additions)
            .unwrap_or(0);
        let deletions = patch_segment
            .as_ref()
            .map(|segment| segment.deletions)
            .unwrap_or(0);
        let is_binary = patch_segment
            .as_ref()
            .map(|segment| segment.is_binary)
            .unwrap_or(false);
        let patch = patch_segment.and_then(|segment| segment.patch);

        files.push(TaskPullRequestFile {
            repository_id: target.repository_id.clone(),
            repository_name: target.repository_name.clone(),
            repository_slug: target.repository_slug.clone(),
            change_type,
            old_path,
            new_path,
            display_path,
            origin,
            additions,
            deletions,
            is_binary,
            patch,
        });
    }

    files.sort_by(|left, right| left.display_path.cmp(&right.display_path));

    let committed_file_count = files
        .iter()
        .filter(|file| file.origin == "committed")
        .count() as i64;
    let uncommitted_file_count = files
        .iter()
        .filter(|file| file.origin == "uncommitted")
        .count() as i64;
    let mixed_file_count = files.iter().filter(|file| file.origin == "mixed").count() as i64;

    Ok(TaskPullRequestRepository {
        repository_id: target.repository_id,
        repository_name: target.repository_name,
        repository_slug: target.repository_slug,
        status: if files.is_empty() {
            "clean".into()
        } else {
            "changed".into()
        },
        review_root_path: Some(review_root_path),
        review_root_kind: Some(review_root_kind.into()),
        unavailable_reason: None,
        default_branch: Some(default_branch),
        base_commit_hash,
        head_commit_hash: head_commit,
        worktree_only,
        has_uncommitted_changes: !uncommitted_keys.is_empty(),
        committed_file_count,
        uncommitted_file_count,
        mixed_file_count,
        files,
    })
}

fn build_unavailable_repository(
    target: ReviewRepositoryTarget,
    reason: impl Into<String>,
) -> TaskPullRequestRepository {
    TaskPullRequestRepository {
        repository_id: target.repository_id,
        repository_name: target.repository_name,
        repository_slug: target.repository_slug,
        status: "unavailable".into(),
        review_root_path: None,
        review_root_kind: None,
        unavailable_reason: Some(reason.into()),
        default_branch: target.default_branch,
        base_commit_hash: None,
        head_commit_hash: None,
        worktree_only: false,
        has_uncommitted_changes: false,
        committed_file_count: 0,
        uncommitted_file_count: 0,
        mixed_file_count: 0,
        files: Vec::new(),
    }
}

fn select_review_root(target: &ReviewRepositoryTarget) -> Option<(String, &'static str)> {
    let candidates = [
        target
            .task_worktree_path
            .as_deref()
            .map(|path| (path.to_string(), "task_worktree")),
        target
            .managed_repository_path
            .as_deref()
            .map(|path| (path.to_string(), "managed_repository")),
    ];

    for candidate in candidates.into_iter().flatten() {
        if is_git_checkout(Path::new(&candidate.0)) {
            return Some(candidate);
        }
    }

    None
}

fn is_git_checkout(path: &Path) -> bool {
    if !path.exists() {
        return false;
    }
    Command::new("git")
        .args([
            "-C",
            path.to_string_lossy().as_ref(),
            "rev-parse",
            "--show-toplevel",
        ])
        .output()
        .ok()
        .is_some_and(|output| output.status.success())
}

fn resolve_merge_base_commit(
    review_root: &Path,
    head_commit: &str,
    default_branch: &str,
) -> Result<Option<String>, String> {
    for candidate in [
        format!("refs/heads/{default_branch}"),
        format!("refs/remotes/origin/{default_branch}"),
        default_branch.to_string(),
    ] {
        if !git_command_succeeds(
            review_root,
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("{candidate}^{{commit}}"),
            ],
        )? {
            continue;
        }
        if let Some(merge_base) =
            git_optional_trimmed_stdout(review_root, &["merge-base", head_commit, &candidate])?
        {
            return Ok(Some(merge_base));
        }
    }

    Ok(None)
}

fn git_command_succeeds(review_root: &Path, args: &[&str]) -> Result<bool, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(review_root)
        .args(args)
        .output()
        .map_err(|error| {
            format!(
                "Unable to execute git {:?} in {}: {error}",
                args,
                review_root.display()
            )
        })?;
    Ok(output.status.success())
}

fn git_stdout(review_root: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(review_root)
        .args(args)
        .output()
        .map_err(|error| {
            format!(
                "Unable to execute git {:?} in {}: {error}",
                args,
                review_root.display()
            )
        })?;
    if !output.status.success() {
        return Err(format!(
            "Git command {:?} failed in {}: {}",
            args,
            review_root.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn git_optional_trimmed_stdout(
    review_root: &Path,
    args: &[&str],
) -> Result<Option<String>, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(review_root)
        .args(args)
        .output()
        .map_err(|error| {
            format!(
                "Unable to execute git {:?} in {}: {error}",
                args,
                review_root.display()
            )
        })?;
    if !output.status.success() {
        return Ok(None);
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if value.is_empty() {
        Ok(None)
    } else {
        Ok(Some(value))
    }
}

fn parse_name_status_entries(output: &str) -> Result<Vec<NameStatusEntry>, String> {
    output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let parts = line.split('\t').collect::<Vec<_>>();
            let status = parts.first().copied().unwrap_or_default();
            let code = status.chars().next().unwrap_or('M');
            match code {
                'A' | 'M' | 'D' | 'T' => {
                    let path = parts.get(1).copied().unwrap_or_default();
                    let normalized = normalize_repo_relative_path(path);
                    Ok(NameStatusEntry {
                        change_type: match code {
                            'A' => "added",
                            'D' => "deleted",
                            _ => "modified",
                        }
                        .into(),
                        old_path: if code == 'D' {
                            Some(normalized.clone())
                        } else {
                            None
                        },
                        new_path: if code == 'D' { None } else { Some(normalized) },
                    })
                }
                'R' | 'C' => {
                    if parts.len() < 3 {
                        return Err(format!("Unable to parse rename/copy diff entry: {line}"));
                    }
                    Ok(NameStatusEntry {
                        change_type: "renamed".into(),
                        old_path: Some(normalize_repo_relative_path(parts[1])),
                        new_path: Some(normalize_repo_relative_path(parts[2])),
                    })
                }
                _ => Err(format!("Unsupported git diff status entry: {line}")),
            }
        })
        .collect()
}

fn dedupe_name_status_entries(entries: Vec<NameStatusEntry>) -> Vec<NameStatusEntry> {
    let mut seen = HashSet::new();
    let mut deduped = Vec::new();
    for entry in entries {
        if seen.insert(entry.key()) {
            deduped.push(entry);
        }
    }
    deduped
}

fn list_untracked_files(review_root: &Path) -> Result<Vec<String>, String> {
    let output = git_stdout(
        review_root,
        &["ls-files", "--others", "--exclude-standard", "-z"],
    )?;
    Ok(output
        .split('\0')
        .filter(|value| !value.trim().is_empty())
        .map(normalize_repo_relative_path)
        .collect())
}

fn parse_patch_segments(output: &str) -> Result<Vec<ParsedPatchSegment>, String> {
    let mut segments = Vec::new();
    let mut current = Vec::new();
    for line in output.lines() {
        if line.starts_with("diff --git ") && !current.is_empty() {
            segments.push(parse_patch_segment(&current.join("\n"))?);
            current.clear();
        }
        current.push(line.to_string());
    }
    if !current.is_empty() {
        segments.push(parse_patch_segment(&current.join("\n"))?);
    }
    Ok(segments)
}

fn parse_patch_segment(segment: &str) -> Result<ParsedPatchSegment, String> {
    let mut old_path = None;
    let mut new_path = None;
    let mut rename_from = None;
    let mut rename_to = None;
    let mut is_binary = false;
    let mut additions = 0;
    let mut deletions = 0;

    for line in segment.lines() {
        if let Some(rest) = line.strip_prefix("diff --git ") {
            let parts = rest.split_whitespace().collect::<Vec<_>>();
            if parts.len() >= 2 {
                old_path = Some(normalize_repo_relative_path(strip_git_prefix(parts[0])));
                new_path = Some(normalize_repo_relative_path(strip_git_prefix(parts[1])));
            }
        } else if let Some(rest) = line.strip_prefix("rename from ") {
            rename_from = Some(normalize_repo_relative_path(rest));
        } else if let Some(rest) = line.strip_prefix("rename to ") {
            rename_to = Some(normalize_repo_relative_path(rest));
        } else if let Some(rest) = line.strip_prefix("--- ") {
            old_path = normalize_patch_side_path(rest);
        } else if let Some(rest) = line.strip_prefix("+++ ") {
            new_path = normalize_patch_side_path(rest);
        } else if line.starts_with("Binary files ") || line == "GIT binary patch" {
            is_binary = true;
        } else if line.starts_with('+') && !line.starts_with("+++") {
            additions += 1;
        } else if line.starts_with('-') && !line.starts_with("---") {
            deletions += 1;
        }
    }

    if let Some(rename_from) = rename_from {
        old_path = Some(rename_from);
    }
    if let Some(rename_to) = rename_to {
        new_path = Some(rename_to);
    }

    let display_path = new_path
        .clone()
        .or_else(|| old_path.clone())
        .unwrap_or_default();
    if display_path.is_empty() {
        return Err("Unable to determine diff path for PR file segment.".into());
    }

    let change_type = if old_path.is_none() {
        "added"
    } else if new_path.is_none() {
        "deleted"
    } else if segment.contains("rename from ") || segment.contains("rename to ") {
        "renamed"
    } else {
        "modified"
    };

    Ok(ParsedPatchSegment {
        old_path,
        new_path,
        change_type: change_type.into(),
        display_path,
        additions,
        deletions,
        is_binary,
        patch: Some(segment.to_string()),
    })
}

fn build_untracked_file(
    review_root: &Path,
    target: &ReviewRepositoryTarget,
    relative_path: &str,
    origin: String,
) -> Result<TaskPullRequestFile, String> {
    let absolute_path = review_root.join(relative_path);
    let contents = fs::read(&absolute_path).map_err(|error| {
        format!(
            "Unable to read untracked file {}: {error}",
            absolute_path.display()
        )
    })?;
    let (patch, additions, is_binary) = match String::from_utf8(contents) {
        Ok(text) => {
            let mut line_count = 0_i64;
            let mut body = String::new();
            for line in text.lines() {
                line_count += 1;
                body.push('+');
                body.push_str(line);
                body.push('\n');
            }
            let patch = if line_count == 0 {
                format!(
                    "diff --git a/{0} b/{0}\nnew file mode 100644\n--- /dev/null\n+++ b/{0}\n",
                    relative_path
                )
            } else {
                format!(
                    "diff --git a/{0} b/{0}\nnew file mode 100644\n--- /dev/null\n+++ b/{0}\n@@ -0,0 +1,{1} @@\n{2}",
                    relative_path, line_count, body
                )
            };
            (Some(patch), line_count, false)
        }
        Err(_) => (None, 0, true),
    };

    Ok(TaskPullRequestFile {
        repository_id: target.repository_id.clone(),
        repository_name: target.repository_name.clone(),
        repository_slug: target.repository_slug.clone(),
        change_type: "added".into(),
        old_path: None,
        new_path: Some(relative_path.into()),
        display_path: relative_path.into(),
        origin,
        additions,
        deletions: 0,
        is_binary,
        patch,
    })
}

fn normalize_patch_side_path(value: &str) -> Option<String> {
    if value.trim() == "/dev/null" {
        None
    } else {
        Some(normalize_repo_relative_path(strip_git_prefix(value)))
    }
}

fn strip_git_prefix(value: &str) -> &str {
    value
        .strip_prefix("a/")
        .or_else(|| value.strip_prefix("b/"))
        .unwrap_or(value)
}

fn normalize_repo_relative_path(value: &str) -> String {
    value.trim_start_matches("./").trim().to_string()
}

fn file_key(old_path: Option<&str>, new_path: Option<&str>) -> String {
    match (old_path, new_path) {
        (Some(old_path), Some(new_path)) if old_path != new_path => {
            format!("{old_path}\u{0}{new_path}")
        }
        (_, Some(new_path)) => new_path.to_string(),
        (Some(old_path), None) => old_path.to_string(),
        (None, None) => String::new(),
    }
}

fn classify_origin(
    key: &str,
    committed_keys: &HashSet<String>,
    uncommitted_keys: &HashSet<String>,
) -> String {
    let committed = committed_keys.contains(key);
    let uncommitted = uncommitted_keys.contains(key);
    match (committed, uncommitted) {
        (true, true) => "mixed",
        (true, false) => "committed",
        (false, true) => "uncommitted",
        (false, false) => "committed",
    }
    .into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use std::process::Command;
    use uuid::Uuid;

    use crate::services::database;

    fn now_iso() -> String {
        Utc::now().to_rfc3339()
    }

    fn in_memory_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("open in-memory db");
        database::apply_migrations(&connection).expect("apply migrations");
        let now = now_iso();
        connection
            .execute(
                "INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('orchestra', 'orchestra', 'Orchestra', NULL, 'ORC', NULL, ?1, ?1)",
                [now],
            )
            .expect("project should insert");
        connection
    }

    fn seed_task(connection: &Connection, task_id: &str) {
        let now = now_iso();
        connection
            .execute(
                "INSERT INTO workflows (id, slug, name, archived, created_at, updated_at) VALUES ('workflow-dev', 'development', 'Development', 0, ?1, ?1)",
                [now.clone()],
            )
            .expect("workflow should insert");
        connection
            .execute(
                "INSERT INTO workflow_lanes (id, workflow_id, lane_key, name, lane_order, assigned_entity_type, success_transition_type, failure_transition_type, created_at, updated_at) VALUES ('lane-implementation', 'workflow-dev', 'implementation', 'Implementation', 0, 'role', 'end', 'end', ?1, ?1)",
                [now.clone()],
            )
            .expect("lane should insert");
        connection
            .execute(
                "INSERT INTO tasks (id, project_id, sequence_number, number, title, description, task_type, status, priority, workflow_id, current_lane_id, assignee_type, assignee_id, archived, created_at, updated_at) VALUES (?1, 'orchestra', 259, 'ORC-259', 'PR test', NULL, 'feature', 'in_progress', 'P2', 'workflow-dev', 'lane-implementation', 'role', 'developer', 0, ?2, ?2)",
                params![task_id, now.clone()],
            )
            .expect("task should insert");
    }

    fn init_git_repo(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("task-pr-{name}-{}", Uuid::new_v4().simple()));
        fs::create_dir_all(&root).expect("repo dir should create");
        assert!(Command::new("git")
            .args(["init", "-b", "main"])
            .current_dir(&root)
            .status()
            .expect("git init should run")
            .success());
        assert!(Command::new("git")
            .args(["config", "user.email", "tests@example.invalid"])
            .current_dir(&root)
            .status()
            .expect("git config email should run")
            .success());
        assert!(Command::new("git")
            .args(["config", "user.name", "Tests"])
            .current_dir(&root)
            .status()
            .expect("git config name should run")
            .success());
        root
    }

    fn git(repo_root: &Path, args: &[&str]) {
        assert!(Command::new("git")
            .args(args)
            .current_dir(repo_root)
            .status()
            .expect("git command should run")
            .success());
    }

    fn git_stdout_trimmed(repo_root: &Path, args: &[&str]) -> String {
        String::from_utf8(
            Command::new("git")
                .args(args)
                .current_dir(repo_root)
                .output()
                .expect("git command should run")
                .stdout,
        )
        .expect("git stdout should decode")
        .trim()
        .to_string()
    }

    #[test]
    fn prefers_task_worktree_and_classifies_mixed_changes_from_merge_base() {
        let connection = in_memory_connection();
        seed_task(&connection, "task-pr-1");
        let repo_root = init_git_repo("mixed");
        fs::write(repo_root.join("file.txt"), "base\n").expect("base file should write");
        git(&repo_root, &["add", "."]);
        git(&repo_root, &["commit", "-m", "base"]);
        let base_commit = git_stdout_trimmed(&repo_root, &["rev-parse", "HEAD"]);
        git(&repo_root, &["checkout", "-b", "feature"]);
        fs::write(repo_root.join("file.txt"), "base\ncommitted\n")
            .expect("feature file should write");
        git(&repo_root, &["add", "."]);
        git(&repo_root, &["commit", "-m", "feature"]);
        let feature_commit = git_stdout_trimmed(&repo_root, &["rev-parse", "HEAD"]);
        git(&repo_root, &["checkout", "main"]);
        let workspace_root = repo_root
            .parent()
            .expect("repo parent should exist")
            .join(format!("task-workspace-{}", Uuid::new_v4().simple()));
        let worktree_root = workspace_root.join("repos").join("repo-1");
        fs::create_dir_all(
            worktree_root
                .parent()
                .expect("worktree parent should exist"),
        )
        .expect("worktree parent should create");
        git(
            &repo_root,
            &[
                "worktree",
                "add",
                "--detach",
                worktree_root.to_string_lossy().as_ref(),
                &feature_commit,
            ],
        );
        fs::write(
            worktree_root.join("file.txt"),
            "base\ncommitted\nuncommitted\n",
        )
        .expect("worktree file should write");

        let now = now_iso();
        connection
            .execute(
                "INSERT INTO repositories (id, project_id, slug, name, local_path, remote_url, default_branch, created_at, updated_at) VALUES ('repo-1', 'orchestra', 'repo-1', 'Repo 1', ?1, NULL, 'main', ?2, ?2)",
                params![repo_root.display().to_string(), now.clone()],
            )
            .expect("repository should insert");
        connection
            .execute(
                "INSERT INTO task_repositories (task_id, repository_id, created_at) VALUES ('task-pr-1', 'repo-1', ?1)",
                [now.clone()],
            )
            .expect("task repository link should insert");
        connection
            .execute(
                "INSERT INTO task_lane_assignments (id, task_id, workflow_id, lane_id, worker_type, worker_id, status, session_id, runtime_cwd, role_queue_entry_id, role_instance_id, prompt, whip_count, last_whip_at, started_at, completed_at, created_at, updated_at) VALUES ('assignment-1', 'task-pr-1', 'workflow-dev', 'lane-implementation', 'role', 'developer', 'active', 'session-1', ?1, NULL, NULL, NULL, 0, NULL, ?2, NULL, ?2, ?2)",
                params![workspace_root.display().to_string(), now.clone()],
            )
            .expect("assignment should insert");

        let detail =
            get_task_pull_request(&connection, "task-pr-1").expect("PR detail should load");
        let repo = &detail.repositories[0];
        assert_eq!(repo.review_root_kind.as_deref(), Some("task_worktree"));
        assert_eq!(repo.base_commit_hash.as_deref(), Some(base_commit.as_str()));
        assert_eq!(
            repo.head_commit_hash.as_deref(),
            Some(feature_commit.as_str())
        );
        assert_eq!(repo.status, "changed");
        assert_eq!(repo.files.len(), 1);
        assert_eq!(repo.files[0].origin, "mixed");
    }

    #[test]
    fn falls_back_to_local_default_branch_when_remote_tracking_ref_has_no_merge_base() {
        let connection = in_memory_connection();
        seed_task(&connection, "task-pr-local-fallback");
        let repo_root = init_git_repo("local-fallback");
        fs::write(repo_root.join("file.txt"), "base\n").expect("base file should write");
        git(&repo_root, &["add", "."]);
        git(&repo_root, &["commit", "-m", "base"]);
        let base_commit = git_stdout_trimmed(&repo_root, &["rev-parse", "HEAD"]);
        git(&repo_root, &["checkout", "-b", "feature"]);
        fs::write(repo_root.join("file.txt"), "base\ncommitted\n")
            .expect("feature file should write");
        git(&repo_root, &["add", "."]);
        git(&repo_root, &["commit", "-m", "feature"]);
        let feature_commit = git_stdout_trimmed(&repo_root, &["rev-parse", "HEAD"]);
        git(&repo_root, &["checkout", "main"]);

        git(&repo_root, &["checkout", "--orphan", "rewritten-main"]);
        fs::write(repo_root.join("rewritten.txt"), "rewritten\n")
            .expect("rewritten file should write");
        git(&repo_root, &["add", "."]);
        git(&repo_root, &["commit", "-m", "rewritten"]);
        let rewritten_commit = git_stdout_trimmed(&repo_root, &["rev-parse", "HEAD"]);
        git(
            &repo_root,
            &["update-ref", "refs/remotes/origin/main", &rewritten_commit],
        );
        git(&repo_root, &["checkout", "main"]);

        let workspace_root = repo_root
            .parent()
            .expect("repo parent should exist")
            .join(format!("task-workspace-{}", Uuid::new_v4().simple()));
        let worktree_root = workspace_root.join("repos").join("repo-local-fallback");
        fs::create_dir_all(
            worktree_root
                .parent()
                .expect("worktree parent should exist"),
        )
        .expect("worktree parent should create");
        git(
            &repo_root,
            &[
                "worktree",
                "add",
                "--detach",
                worktree_root.to_string_lossy().as_ref(),
                &feature_commit,
            ],
        );

        let now = now_iso();
        connection
            .execute(
                "INSERT INTO repositories (id, project_id, slug, name, local_path, remote_url, default_branch, created_at, updated_at) VALUES ('repo-local-fallback', 'orchestra', 'repo-local-fallback', 'Repo Local Fallback', ?1, NULL, 'main', ?2, ?2)",
                params![repo_root.display().to_string(), now.clone()],
            )
            .expect("repository should insert");
        connection
            .execute(
                "INSERT INTO task_repositories (task_id, repository_id, created_at) VALUES ('task-pr-local-fallback', 'repo-local-fallback', ?1)",
                [now.clone()],
            )
            .expect("task repository link should insert");
        connection
            .execute(
                "INSERT INTO task_lane_assignments (id, task_id, workflow_id, lane_id, worker_type, worker_id, status, session_id, runtime_cwd, role_queue_entry_id, role_instance_id, prompt, whip_count, last_whip_at, started_at, completed_at, created_at, updated_at) VALUES ('assignment-local-fallback', 'task-pr-local-fallback', 'workflow-dev', 'lane-implementation', 'role', 'developer', 'active', 'session-local-fallback', ?1, NULL, NULL, NULL, 0, NULL, ?2, NULL, ?2, ?2)",
                params![workspace_root.display().to_string(), now.clone()],
            )
            .expect("assignment should insert");

        let detail = get_task_pull_request(&connection, "task-pr-local-fallback")
            .expect("PR detail should load");
        let repo = &detail.repositories[0];
        assert_eq!(repo.base_commit_hash.as_deref(), Some(base_commit.as_str()));
        assert_eq!(
            repo.head_commit_hash.as_deref(),
            Some(feature_commit.as_str())
        );
        assert!(!repo.worktree_only);
        assert_eq!(repo.status, "changed");
        assert_eq!(repo.files.len(), 1);
        assert_eq!(repo.files[0].origin, "committed");
    }

    #[test]
    fn marks_repo_clean_when_no_relevant_changes_exist() {
        let connection = in_memory_connection();
        seed_task(&connection, "task-pr-clean");
        let repo_root = init_git_repo("clean");
        fs::write(repo_root.join("file.txt"), "base\n").expect("base file should write");
        git(&repo_root, &["add", "."]);
        git(&repo_root, &["commit", "-m", "base"]);

        let now = now_iso();
        connection
            .execute(
                "INSERT INTO repositories (id, project_id, slug, name, local_path, remote_url, default_branch, created_at, updated_at) VALUES ('repo-clean', 'orchestra', 'repo-clean', 'Repo Clean', ?1, NULL, 'main', ?2, ?2)",
                params![repo_root.display().to_string(), now.clone()],
            )
            .expect("repository should insert");
        connection
            .execute(
                "INSERT INTO task_repositories (task_id, repository_id, created_at) VALUES ('task-pr-clean', 'repo-clean', ?1)",
                [now],
            )
            .expect("task repository link should insert");

        let detail =
            get_task_pull_request(&connection, "task-pr-clean").expect("PR detail should load");
        let repo = &detail.repositories[0];
        assert_eq!(repo.status, "clean");
        assert!(repo.files.is_empty());
    }

    #[test]
    fn marks_repo_unavailable_when_no_git_checkout_can_be_resolved() {
        let connection = in_memory_connection();
        seed_task(&connection, "task-pr-missing");

        let now = now_iso();
        connection
            .execute(
                "INSERT INTO repositories (id, project_id, slug, name, local_path, remote_url, default_branch, created_at, updated_at) VALUES ('repo-missing', 'orchestra', 'repo-missing', 'Repo Missing', '/tmp/definitely-missing-repo', NULL, 'main', ?1, ?1)",
                [now.clone()],
            )
            .expect("repository should insert");
        connection
            .execute(
                "INSERT INTO task_repositories (task_id, repository_id, created_at) VALUES ('task-pr-missing', 'repo-missing', ?1)",
                [now],
            )
            .expect("task repository link should insert");

        let detail =
            get_task_pull_request(&connection, "task-pr-missing").expect("PR detail should load");
        let repo = &detail.repositories[0];
        assert_eq!(repo.status, "unavailable");
        assert!(repo.unavailable_reason.is_some());
    }
}
