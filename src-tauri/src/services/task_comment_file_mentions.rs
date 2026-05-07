use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    process::Command,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use rusqlite::Connection;

use crate::{
    models::{
        TaskCommentFileMentionCandidate, TaskFileReference, TaskFileReferenceInput, TaskRepository,
    },
    services::{task_file_references, task_repositories, task_runtime, tasks},
};

const CACHE_TTL: Duration = Duration::from_secs(10);
const MAX_INDEXED_FILES: usize = 50_000;
const MAX_RESULTS: usize = 20;
const MAX_TRIE_SUGGESTIONS: usize = 32;

static FILE_INDEX_CACHE: OnceLock<Mutex<HashMap<String, CachedRepositoryIndex>>> = OnceLock::new();

#[derive(Clone)]
struct RepositorySearchRoot {
    repository_id: String,
    repository_name: String,
    repository_slug: String,
    root_path: String,
}

#[derive(Default, Clone)]
struct TrieNode {
    children: HashMap<char, TrieNode>,
    top_indices: Vec<usize>,
}

#[derive(Clone)]
struct IndexedFile {
    relative_path: String,
    lower_relative_path: String,
    lower_basename: String,
}

#[derive(Clone)]
struct CachedRepositoryIndex {
    built_at: Instant,
    path_trie: TrieNode,
    basename_trie: TrieNode,
    files: Vec<IndexedFile>,
    exact_paths: HashMap<String, usize>,
}

#[derive(Clone)]
struct ResolvedMention {
    repository_id: String,
    relative_path: String,
}

pub fn search_task_comment_file_mentions(
    connection: &Connection,
    task_id: &str,
    query: &str,
    limit: Option<usize>,
) -> Result<Vec<TaskCommentFileMentionCandidate>, String> {
    let repositories = mention_search_repositories(connection, task_id)?;
    let repository_count = repositories.len();
    if repository_count == 0 {
        return Ok(Vec::new());
    }

    let (repository_slug_filter, needle) = parse_query(query);
    let normalized_needle = normalize_relative_query(&needle);

    let result_limit = limit.unwrap_or(MAX_RESULTS).min(MAX_RESULTS.max(1));
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();

    for repository in repositories.iter().filter(|entry| {
        repository_slug_filter
            .as_deref()
            .map(|slug| slug == entry.repository_slug)
            .unwrap_or(true)
    }) {
        let index = repository_index(&repository.root_path)?;
        for file in search_repository_index(&index, &normalized_needle, result_limit) {
            if !seen.insert((repository.repository_id.clone(), file.relative_path.clone())) {
                continue;
            }
            candidates.push(TaskCommentFileMentionCandidate {
                repository_id: repository.repository_id.clone(),
                repository_name: repository.repository_name.clone(),
                repository_slug: repository.repository_slug.clone(),
                relative_path: file.relative_path.clone(),
                display_text: if repository_count > 1 {
                    format!("{} — {}", file.relative_path, repository.repository_name)
                } else {
                    file.relative_path.clone()
                },
                insert_text: build_insert_text(repository, &file.relative_path, repository_count),
            });
            if candidates.len() >= result_limit {
                return Ok(candidates);
            }
        }
    }

    Ok(candidates)
}

pub fn add_file_references_for_comment_mentions(
    connection: &mut Connection,
    task_id: &str,
    message: &str,
) -> Result<Vec<TaskFileReference>, String> {
    let repositories = mention_search_repositories(connection, task_id)?;
    if repositories.is_empty() {
        return Ok(Vec::new());
    }

    let task_workspace_cwd = current_task_workspace_cwd(connection, task_id)?;
    let existing = task_file_references::load_task_file_references(
        connection,
        task_id,
        task_workspace_cwd.as_deref(),
    )?;
    let mut existing_paths = existing
        .into_iter()
        .map(|reference| (reference.repository_id, reference.relative_path))
        .collect::<HashSet<_>>();
    let mut added = Vec::new();
    let mut processed = HashSet::new();

    for token in extract_file_mentions(message) {
        let Some(resolved) = resolve_exact_mention(&repositories, &token)? else {
            continue;
        };
        if !processed.insert((
            resolved.repository_id.clone(),
            resolved.relative_path.clone(),
        )) {
            continue;
        }
        if existing_paths.contains(&(
            resolved.repository_id.clone(),
            resolved.relative_path.clone(),
        )) {
            continue;
        }

        if let Ok(reference) = task_file_references::add_task_file_reference(
            connection,
            task_id,
            TaskFileReferenceInput {
                repository_id: resolved.repository_id.clone(),
                relative_path: resolved.relative_path.clone(),
            },
        ) {
            existing_paths.insert((resolved.repository_id, resolved.relative_path));
            added.push(reference);
        }
    }

    Ok(added)
}

fn mention_search_repositories(
    connection: &Connection,
    task_id: &str,
) -> Result<Vec<RepositorySearchRoot>, String> {
    let task_workspace_cwd = current_task_workspace_cwd(connection, task_id)?;
    let repositories = task_repositories::load_task_repositories(
        connection,
        task_id,
        task_workspace_cwd.as_deref(),
    )?;
    Ok(repositories
        .into_iter()
        .filter_map(resolve_repository_search_root)
        .collect())
}

fn current_task_workspace_cwd(
    connection: &Connection,
    task_id: &str,
) -> Result<Option<String>, String> {
    let task = tasks::get_task(connection, task_id)?;
    Ok(task
        .active_lane_assignment
        .as_ref()
        .map(|assignment| {
            task_runtime::resolve_assignment_workspace_cwd(
                connection,
                assignment,
                task_id,
                &task.project_id,
            )
        })
        .transpose()?
        .flatten())
}

fn resolve_repository_search_root(repository: TaskRepository) -> Option<RepositorySearchRoot> {
    let preferred_root = repository
        .task_worktree_path
        .as_deref()
        .map(PathBuf::from)
        .filter(|path| path.exists() && path.is_dir())
        .or_else(|| {
            repository
                .managed_repository_path
                .as_deref()
                .map(PathBuf::from)
                .filter(|path| path.exists() && path.is_dir())
        })
        .or_else(|| {
            (repository.source_kind.as_deref() == Some("local"))
                .then_some(repository.source_path.as_deref())
                .flatten()
                .map(PathBuf::from)
                .filter(|path| path.exists() && path.is_dir())
        })?;

    Some(RepositorySearchRoot {
        repository_id: repository.repository_id,
        repository_name: repository.repository_name,
        repository_slug: repository.repository_slug,
        root_path: preferred_root.display().to_string(),
    })
}

fn build_insert_text(
    repository: &RepositorySearchRoot,
    relative_path: &str,
    repository_count: usize,
) -> String {
    if repository_count > 1 {
        format!("${}:{}", repository.repository_slug, relative_path)
    } else {
        format!("${}", relative_path)
    }
}

fn repository_index(root_path: &str) -> Result<CachedRepositoryIndex, String> {
    let cache = FILE_INDEX_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = cache
        .lock()
        .map_err(|_| "Unable to lock task comment file index cache".to_string())?;

    if let Some(entry) = guard.get(root_path) {
        if entry.built_at.elapsed() <= CACHE_TTL {
            return Ok(entry.clone());
        }
    }

    let rebuilt = build_repository_index(root_path)?;
    guard.insert(root_path.to_string(), rebuilt.clone());
    Ok(rebuilt)
}

fn build_repository_index(root_path: &str) -> Result<CachedRepositoryIndex, String> {
    let output = Command::new("git")
        .args([
            "-C",
            root_path,
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
        ])
        .output()
        .map_err(|error| format!("Unable to enumerate repository files at {root_path}: {error}"))?;

    if !output.status.success() {
        return Ok(CachedRepositoryIndex {
            built_at: Instant::now(),
            path_trie: TrieNode::default(),
            basename_trie: TrieNode::default(),
            files: Vec::new(),
            exact_paths: HashMap::new(),
        });
    }

    let mut paths = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(normalize_relative_query)
        .filter(|path| !path.is_empty())
        .collect::<Vec<_>>();
    paths.sort();
    paths.dedup();
    paths.truncate(MAX_INDEXED_FILES);

    let files = paths
        .into_iter()
        .map(|relative_path| {
            let lower_relative_path = relative_path.to_lowercase();
            let lower_basename = Path::new(&relative_path)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .to_lowercase();
            IndexedFile {
                relative_path,
                lower_relative_path,
                lower_basename,
            }
        })
        .collect::<Vec<_>>();

    let mut path_trie = TrieNode::default();
    let mut basename_trie = TrieNode::default();
    let mut exact_paths = HashMap::new();

    for (index, file) in files.iter().enumerate() {
        path_trie.insert(&file.lower_relative_path, index);
        basename_trie.insert(&file.lower_basename, index);
        exact_paths.insert(file.lower_relative_path.clone(), index);
    }

    Ok(CachedRepositoryIndex {
        built_at: Instant::now(),
        path_trie,
        basename_trie,
        files,
        exact_paths,
    })
}

fn search_repository_index<'a>(
    index: &'a CachedRepositoryIndex,
    query: &str,
    limit: usize,
) -> Vec<&'a IndexedFile> {
    let query = query.to_lowercase();
    let mut results = Vec::new();
    let mut seen = HashSet::new();

    for trie in [&index.path_trie, &index.basename_trie] {
        for file_index in trie.lookup(&query) {
            if seen.insert(file_index) {
                if let Some(file) = index.files.get(file_index) {
                    results.push(file);
                    if results.len() >= limit {
                        return results;
                    }
                }
            }
        }
    }

    results
}

fn parse_query(query: &str) -> (Option<String>, String) {
    let trimmed = query.trim();
    let normalized = trimmed.replace('\\', "/");
    if let Some((repository_slug, relative_query)) = normalized.split_once(':') {
        if !repository_slug.trim().is_empty() {
            return (
                Some(repository_slug.trim().to_lowercase()),
                relative_query.to_string(),
            );
        }
    }
    (None, normalized)
}

fn normalize_relative_query(value: &str) -> String {
    value
        .trim()
        .trim_start_matches('@')
        .trim_start_matches('$')
        .trim_start_matches("./")
        .replace('\\', "/")
}

fn extract_file_mentions(message: &str) -> Vec<String> {
    let mut mentions = Vec::new();
    let chars = message.char_indices().collect::<Vec<_>>();

    for (index, (byte_index, character)) in chars.iter().enumerate() {
        if *character != '@' && *character != '$' {
            continue;
        }
        if let Some((_, previous)) = index
            .checked_sub(1)
            .and_then(|position| chars.get(position))
        {
            if previous.is_alphanumeric() || matches!(previous, '_' | '/' | '.' | '-') {
                continue;
            }
        }

        let start = byte_index + character.len_utf8();
        let mut end = message.len();
        for (next_byte_index, next_character) in chars.iter().skip(index + 1) {
            if next_character.is_whitespace()
                || matches!(
                    next_character,
                    ')' | ']' | '}' | '>' | '"' | '\'' | ',' | ';'
                )
            {
                end = *next_byte_index;
                break;
            }
        }

        let token = message[start..end].trim_end_matches(['.', '!', '?']).trim();
        if token.is_empty() {
            continue;
        }
        if *character == '@' && !token.contains('/') && !token.contains(':') && !token.contains('.')
        {
            continue;
        }
        mentions.push(token.to_string());
    }

    mentions
}

fn resolve_exact_mention(
    repositories: &[RepositorySearchRoot],
    token: &str,
) -> Result<Option<ResolvedMention>, String> {
    let (repository_slug_filter, path_query) = parse_query(token);
    let normalized_path = normalize_relative_query(&path_query).to_lowercase();
    if normalized_path.is_empty() {
        return Ok(None);
    }

    let mut matches = Vec::new();
    for repository in repositories.iter().filter(|entry| {
        repository_slug_filter
            .as_deref()
            .map(|slug| slug == entry.repository_slug)
            .unwrap_or(true)
    }) {
        let index = repository_index(&repository.root_path)?;
        if let Some(file_index) = index.exact_paths.get(&normalized_path) {
            if let Some(file) = index.files.get(*file_index) {
                matches.push(ResolvedMention {
                    repository_id: repository.repository_id.clone(),
                    relative_path: file.relative_path.clone(),
                });
            }
        }
    }

    if repository_slug_filter.is_some() {
        return Ok(matches.into_iter().next());
    }

    Ok((matches.len() == 1).then(|| matches.remove(0)))
}

impl TrieNode {
    fn insert(&mut self, key: &str, index: usize) {
        self.push_index(index);
        let mut node = self;
        for character in key.chars() {
            node = node.children.entry(character).or_default();
            node.push_index(index);
        }
    }

    fn push_index(&mut self, index: usize) {
        if self.top_indices.len() >= MAX_TRIE_SUGGESTIONS || self.top_indices.contains(&index) {
            return;
        }
        self.top_indices.push(index);
    }

    fn lookup(&self, key: &str) -> Vec<usize> {
        let mut node = self;
        for character in key.chars() {
            let Some(next) = node.children.get(&character) else {
                return Vec::new();
            };
            node = next;
        }
        node.top_indices.clone()
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::services::{database, tasks};
    fn in_memory_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("open in-memory db");
        database::apply_migrations(&connection).expect("apply migrations");
        connection
    }

    fn temp_repo_dir(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "orchestra-{name}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&path).expect("create temp repo dir");
        path
    }

    fn git_init(path: &Path) {
        Command::new("git")
            .args(["init", "-b", "main"])
            .current_dir(path)
            .output()
            .expect("git init");
        Command::new("git")
            .args(["config", "user.email", "test@example.invalid"])
            .current_dir(path)
            .output()
            .expect("git config email");
        Command::new("git")
            .args(["config", "user.name", "Test User"])
            .current_dir(path)
            .output()
            .expect("git config name");
        Command::new("git")
            .args(["add", "."])
            .current_dir(path)
            .output()
            .expect("git add");
        Command::new("git")
            .args(["commit", "-m", "init"])
            .current_dir(path)
            .output()
            .expect("git commit");
    }

    fn seed_project_repo_task(connection: &mut Connection, repository_root: &Path) -> String {
        let now = crate::services::task_repositories::now_iso();
        connection
            .execute(
                "INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('project-1', 'project', 'Project', NULL, 'PRJ', 'repo-1', ?1, ?1)",
                [now.as_str()],
            )
            .expect("insert project");
        connection
            .execute(
                "INSERT INTO repositories (id, project_id, slug, name, remote_url, default_branch, local_path, created_at, updated_at) VALUES ('repo-1', 'project-1', 'app', 'App', NULL, 'main', ?1, ?2, ?2)",
                [repository_root.display().to_string(), now.clone()],
            )
            .expect("insert repository");
        connection
            .execute(
                "INSERT INTO tasks (id, project_id, sequence_number, number, title, description, task_type, status, priority, workflow_id, current_lane_id, assignee_type, assignee_id, repository_id, parent_task_id, whip_max_attempts, archived, created_at, updated_at) VALUES ('task-1', 'project-1', 1, 'ORC-1', 'Task', NULL, 'task', 'ready', 'P2', NULL, NULL, 'unassigned', NULL, 'repo-1', NULL, 10, 0, ?1, ?1)",
                [now.as_str()],
            )
            .expect("insert task");
        connection
            .execute(
                "INSERT INTO task_repositories (task_id, repository_id, created_at) VALUES ('task-1', 'repo-1', ?1)",
                [now.as_str()],
            )
            .expect("insert task repository");
        "task-1".to_string()
    }

    fn attach_second_repository(connection: &Connection, repository_root: &Path) {
        let now = crate::services::task_repositories::now_iso();
        connection
            .execute(
                "INSERT INTO repositories (id, project_id, slug, name, remote_url, default_branch, local_path, created_at, updated_at) VALUES ('repo-2', 'project-1', 'docs', 'Docs', NULL, 'main', ?1, ?2, ?2)",
                [repository_root.display().to_string(), now.clone()],
            )
            .expect("insert second repository");
        connection
            .execute(
                "INSERT INTO task_repositories (task_id, repository_id, created_at) VALUES ('task-1', 'repo-2', ?1)",
                [now.as_str()],
            )
            .expect("insert second task repository");
    }

    #[test]
    fn searches_git_tracked_and_untracked_files_while_respecting_gitignore() {
        let repo_root = temp_repo_dir("comment-mention-search");
        fs::create_dir_all(repo_root.join("docs")).expect("create docs");
        fs::write(repo_root.join("docs/design.md"), "design\n").expect("write tracked file");
        fs::write(repo_root.join(".gitignore"), "ignored.txt\n").expect("write gitignore");
        git_init(&repo_root);
        fs::write(repo_root.join("docs/plan.md"), "plan\n").expect("write untracked file");
        fs::write(repo_root.join("ignored.txt"), "ignored\n").expect("write ignored file");

        let mut connection = in_memory_connection();
        let task_id = seed_project_repo_task(&mut connection, &repo_root);

        let results = search_task_comment_file_mentions(&connection, &task_id, "docs/", Some(10))
            .expect("search mentions should succeed");
        assert!(results
            .iter()
            .any(|entry| entry.relative_path == "docs/design.md"));
        assert!(results
            .iter()
            .any(|entry| entry.relative_path == "docs/plan.md"));
        assert!(!results
            .iter()
            .any(|entry| entry.relative_path == "ignored.txt"));
    }

    #[test]
    fn empty_queries_return_initial_suggestions() {
        let repo_root = temp_repo_dir("comment-mention-empty-query");
        fs::create_dir_all(repo_root.join("docs")).expect("create docs");
        fs::create_dir_all(repo_root.join("src")).expect("create src");
        fs::write(repo_root.join("docs/design.md"), "design\n").expect("write docs file");
        fs::write(repo_root.join("src/main.ts"), "console.log('hello');\n")
            .expect("write src file");
        git_init(&repo_root);

        let mut connection = in_memory_connection();
        let task_id = seed_project_repo_task(&mut connection, &repo_root);

        let empty_results = search_task_comment_file_mentions(&connection, &task_id, "", Some(10))
            .expect("empty-query mentions should succeed");
        assert!(!empty_results.is_empty());
        assert!(empty_results
            .iter()
            .any(|entry| entry.relative_path == "docs/design.md"));
        assert!(empty_results
            .iter()
            .any(|entry| entry.relative_path == "src/main.ts"));

        let bare_trigger_results =
            search_task_comment_file_mentions(&connection, &task_id, "$", Some(10))
                .expect("bare-trigger mentions should succeed");
        assert_eq!(
            empty_results
                .iter()
                .map(|entry| entry.relative_path.as_str())
                .collect::<Vec<_>>(),
            bare_trigger_results
                .iter()
                .map(|entry| entry.relative_path.as_str())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn auto_adds_file_references_for_matching_mentions() {
        let repo_root = temp_repo_dir("comment-mention-auto-ref");
        fs::create_dir_all(repo_root.join("docs")).expect("create docs");
        fs::write(repo_root.join("docs/design.md"), "design\n").expect("write tracked file");
        git_init(&repo_root);

        let mut connection = in_memory_connection();
        let task_id = seed_project_repo_task(&mut connection, &repo_root);

        let comment = tasks::add_task_comment(
            &mut connection,
            &task_id,
            crate::models::TaskCommentInput {
                author: "User".into(),
                origin_type: None,
                origin_id: None,
                message: "Please review $docs/design.md before merging.".into(),
                interrupt_agent: false,
                parent_comment_id: None,
                repository_id: None,
                relative_path: None,
                absolute_path: None,
                line_start: None,
                line_end: None,
                column_start: None,
                column_end: None,
                selected_text: None,
                anchor: None,
            },
        )
        .expect("comment should insert");
        assert!(!comment.id.is_empty());

        let references =
            task_file_references::load_task_file_references(&connection, &task_id, None)
                .expect("file references should load");
        assert_eq!(references.len(), 1);
        assert_eq!(references[0].relative_path, "docs/design.md");
    }

    #[test]
    fn bare_mentions_stay_ambiguous_across_repositories_but_prefixed_mentions_resolve() {
        let repo_root_one = temp_repo_dir("comment-mention-app-repo");
        let repo_root_two = temp_repo_dir("comment-mention-docs-repo");
        fs::create_dir_all(repo_root_one.join("docs")).expect("create docs one");
        fs::create_dir_all(repo_root_two.join("docs")).expect("create docs two");
        fs::write(repo_root_one.join("docs/shared.md"), "app copy\n").expect("write app file");
        fs::write(repo_root_two.join("docs/shared.md"), "docs copy\n").expect("write docs file");
        git_init(&repo_root_one);
        git_init(&repo_root_two);

        let mut connection = in_memory_connection();
        let task_id = seed_project_repo_task(&mut connection, &repo_root_one);
        attach_second_repository(&connection, &repo_root_two);

        tasks::add_task_comment(
            &mut connection,
            &task_id,
            crate::models::TaskCommentInput {
                author: "User".into(),
                origin_type: None,
                origin_id: None,
                message: "This bare mention stays ambiguous: $docs/shared.md".into(),
                interrupt_agent: false,
                parent_comment_id: None,
                repository_id: None,
                relative_path: None,
                absolute_path: None,
                line_start: None,
                line_end: None,
                column_start: None,
                column_end: None,
                selected_text: None,
                anchor: None,
            },
        )
        .expect("ambiguous comment should insert");

        let references_after_ambiguous =
            task_file_references::load_task_file_references(&connection, &task_id, None)
                .expect("file references should load");
        assert!(references_after_ambiguous.is_empty());

        tasks::add_task_comment(
            &mut connection,
            &task_id,
            crate::models::TaskCommentInput {
                author: "User".into(),
                origin_type: None,
                origin_id: None,
                message: "This one is explicit: $docs:docs/shared.md".into(),
                interrupt_agent: false,
                parent_comment_id: None,
                repository_id: None,
                relative_path: None,
                absolute_path: None,
                line_start: None,
                line_end: None,
                column_start: None,
                column_end: None,
                selected_text: None,
                anchor: None,
            },
        )
        .expect("prefixed comment should insert");

        let references =
            task_file_references::load_task_file_references(&connection, &task_id, None)
                .expect("file references should load");
        assert_eq!(references.len(), 1);
        assert_eq!(references[0].repository_slug, "docs");
        assert_eq!(references[0].relative_path, "docs/shared.md");
    }
}
