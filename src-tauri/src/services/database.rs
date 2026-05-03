use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use rusqlite::{params, Connection};

use crate::services::orchestra_paths::{
    default_orchestra_root, orchestra_database_path, sanitize_slug,
};

pub fn database_path() -> Result<PathBuf, String> {
    let root = default_orchestra_root()?;
    fs::create_dir_all(&root).map_err(|error| {
        format!(
            "Unable to create Orchestra root {}: {error}",
            root.display()
        )
    })?;
    Ok(orchestra_database_path(&root))
}

static DATABASE_INIT_PATH: OnceLock<PathBuf> = OnceLock::new();
static DATABASE_INIT_LOCK: Mutex<()> = Mutex::new(());

pub fn initialize_database() -> Result<PathBuf, String> {
    ensure_database_initialized()
}

pub fn open_connection() -> Result<Connection, String> {
    let path = ensure_database_initialized()?;
    open_configured_connection(&path)
}

pub fn open_connection_at(path: &Path) -> Result<Connection, String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Database path {} has no parent directory", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Unable to create directory {}: {error}", parent.display()))?;
    let connection = open_configured_connection(path)?;
    enable_wal_mode(&connection)?;
    apply_migrations(&connection)?;
    Ok(connection)
}

fn ensure_database_initialized() -> Result<PathBuf, String> {
    if let Some(path) = DATABASE_INIT_PATH.get() {
        return Ok(path.clone());
    }

    let _guard = DATABASE_INIT_LOCK
        .lock()
        .map_err(|_| "Unable to acquire Orchestra database initialization lock".to_string())?;
    if let Some(path) = DATABASE_INIT_PATH.get() {
        return Ok(path.clone());
    }

    let path = database_path()?;
    let connection = open_configured_connection(&path)?;
    enable_wal_mode(&connection)?;
    apply_migrations(&connection)?;
    let _ = DATABASE_INIT_PATH.set(path.clone());
    Ok(path)
}

fn open_configured_connection(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(path).map_err(|error| {
        format!(
            "Unable to open Orchestra database {}: {error}",
            path.display()
        )
    })?;
    configure_connection(&connection)?;
    Ok(connection)
}

fn configure_connection(connection: &Connection) -> Result<(), String> {
    connection
        .busy_timeout(Duration::from_secs(60))
        .map_err(|error| format!("Unable to set Orchestra database busy timeout: {error}"))?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|error| format!("Unable to enable Orchestra database foreign keys: {error}"))?;
    Ok(())
}

fn enable_wal_mode(connection: &Connection) -> Result<(), String> {
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| format!("Unable to enable Orchestra database WAL mode: {error}"))?;
    Ok(())
}

pub(crate) fn apply_migrations(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            r#"
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                slug TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                description TEXT,
                task_prefix TEXT NOT NULL,
                default_repository_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS installation_bootstrap_state (
                key TEXT PRIMARY KEY,
                version INTEGER NOT NULL,
                applied_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS repositories (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                slug TEXT NOT NULL,
                name TEXT NOT NULL,
                local_path TEXT,
                remote_url TEXT,
                default_branch TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_repositories_project_slug
                ON repositories(project_id, slug);

            CREATE INDEX IF NOT EXISTS idx_repositories_project_updated
                ON repositories(project_id, updated_at DESC);

            CREATE TABLE IF NOT EXISTS agents (
                id TEXT PRIMARY KEY,
                slug TEXT NOT NULL,
                name TEXT NOT NULL,
                description TEXT,
                system_prompt TEXT,
                provider TEXT,
                model TEXT,
                role_id TEXT,
                scope TEXT NOT NULL DEFAULT 'global',
                project_id TEXT,
                thinking_level TEXT NOT NULL DEFAULT 'off',
                compaction_window TEXT,
                direct_permissions TEXT NOT NULL DEFAULT '[]',
                system INTEGER NOT NULL DEFAULT 0,
                immutable INTEGER NOT NULL DEFAULT 0,
                archived INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS roles (
                id TEXT PRIMARY KEY,
                slug TEXT NOT NULL,
                name TEXT NOT NULL,
                description TEXT,
                system_prompt TEXT,
                provider TEXT,
                model TEXT,
                thinking_level TEXT NOT NULL DEFAULT 'off',
                capacity INTEGER NOT NULL DEFAULT 1,
                compaction_window TEXT,
                direct_permissions TEXT NOT NULL DEFAULT '[]',
                archived INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS skills (
                id TEXT PRIMARY KEY,
                slug TEXT,
                name TEXT NOT NULL,
                description TEXT,
                source_kind TEXT NOT NULL,
                source_path TEXT NOT NULL,
                content_path TEXT NOT NULL,
                relative_source_path TEXT,
                archived INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL,
                status_reason TEXT,
                shadowed_by_skill_id TEXT,
                last_seen_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(shadowed_by_skill_id) REFERENCES skills(id) ON DELETE SET NULL
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_local_slug_unique
                ON skills(slug)
                WHERE source_kind = 'local';

            CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_source_kind_source_path
                ON skills(source_kind, source_path);

            CREATE INDEX IF NOT EXISTS idx_skills_slug_source_kind
                ON skills(slug, source_kind);

            CREATE INDEX IF NOT EXISTS idx_skills_status_archived
                ON skills(status, archived, updated_at DESC);

            CREATE INDEX IF NOT EXISTS idx_skills_shadowed_by_skill_id
                ON skills(shadowed_by_skill_id);

            CREATE TABLE IF NOT EXISTS skill_scope_bindings (
                id TEXT PRIMARY KEY,
                skill_id TEXT NOT NULL,
                scope_kind TEXT NOT NULL,
                project_id TEXT,
                role_id TEXT,
                agent_id TEXT,
                workflow_id TEXT,
                workflow_lane_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(skill_id) REFERENCES skills(id) ON DELETE CASCADE
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_scope_bindings_unique_scope
                ON skill_scope_bindings(
                    skill_id,
                    scope_kind,
                    IFNULL(project_id, ''),
                    IFNULL(role_id, ''),
                    IFNULL(agent_id, ''),
                    IFNULL(workflow_id, ''),
                    IFNULL(workflow_lane_id, '')
                );

            CREATE INDEX IF NOT EXISTS idx_skill_scope_bindings_skill_id
                ON skill_scope_bindings(skill_id, scope_kind);

            CREATE INDEX IF NOT EXISTS idx_skill_scope_bindings_project_id
                ON skill_scope_bindings(project_id)
                WHERE project_id IS NOT NULL;

            CREATE INDEX IF NOT EXISTS idx_skill_scope_bindings_role_id
                ON skill_scope_bindings(role_id)
                WHERE role_id IS NOT NULL;

            CREATE INDEX IF NOT EXISTS idx_skill_scope_bindings_agent_id
                ON skill_scope_bindings(agent_id)
                WHERE agent_id IS NOT NULL;

            CREATE INDEX IF NOT EXISTS idx_skill_scope_bindings_workflow_id
                ON skill_scope_bindings(workflow_id)
                WHERE workflow_id IS NOT NULL;

            CREATE INDEX IF NOT EXISTS idx_skill_scope_bindings_workflow_lane_id
                ON skill_scope_bindings(workflow_lane_id, workflow_id)
                WHERE workflow_lane_id IS NOT NULL;

            CREATE TABLE IF NOT EXISTS policies (
                id TEXT PRIMARY KEY,
                slug TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                description TEXT,
                permissions TEXT NOT NULL DEFAULT '[]',
                system INTEGER NOT NULL DEFAULT 0,
                immutable INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS role_policy_assignments (
                role_id TEXT NOT NULL,
                policy_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (role_id, policy_id),
                FOREIGN KEY(role_id) REFERENCES roles(id) ON DELETE CASCADE,
                FOREIGN KEY(policy_id) REFERENCES policies(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS agent_policy_assignments (
                agent_id TEXT NOT NULL,
                policy_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (agent_id, policy_id),
                FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE,
                FOREIGN KEY(policy_id) REFERENCES policies(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS role_instances (
                id TEXT PRIMARY KEY,
                role_id TEXT NOT NULL,
                display_name TEXT NOT NULL,
                status TEXT NOT NULL,
                current_queue_entry_id TEXT,
                session_id TEXT,
                worktree_path TEXT,
                last_heartbeat_at TEXT,
                last_error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(role_id) REFERENCES roles(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS role_queue_entries (
                id TEXT PRIMARY KEY,
                role_id TEXT NOT NULL,
                status TEXT NOT NULL,
                source_type TEXT NOT NULL,
                source_task_id TEXT,
                source_workflow_id TEXT,
                source_lane_id TEXT,
                title TEXT NOT NULL,
                summary TEXT,
                entry_prompt TEXT,
                assigned_instance_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                started_at TEXT,
                completed_at TEXT,
                FOREIGN KEY(role_id) REFERENCES roles(id) ON DELETE CASCADE,
                FOREIGN KEY(assigned_instance_id) REFERENCES role_instances(id) ON DELETE SET NULL
            );

            CREATE INDEX IF NOT EXISTS idx_role_instances_role_id
                ON role_instances(role_id);

            CREATE INDEX IF NOT EXISTS idx_role_queue_entries_role_id
                ON role_queue_entries(role_id);

            CREATE INDEX IF NOT EXISTS idx_role_queue_entries_status
                ON role_queue_entries(status);

            CREATE INDEX IF NOT EXISTS idx_role_policy_assignments_policy_id
                ON role_policy_assignments(policy_id);

            CREATE INDEX IF NOT EXISTS idx_agent_policy_assignments_policy_id
                ON agent_policy_assignments(policy_id);

            CREATE TABLE IF NOT EXISTS agent_runtime_states (
                project_id TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                status TEXT NOT NULL,
                main_session_id TEXT,
                runtime_cwd TEXT,
                current_queue_entry_id TEXT,
                last_dispatch_at TEXT,
                last_error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (project_id, agent_id),
                FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS agent_queue_entries (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                status TEXT NOT NULL,
                source_type TEXT NOT NULL,
                source_task_id TEXT,
                source_workflow_id TEXT,
                source_lane_id TEXT,
                delivery_mode TEXT NOT NULL,
                title TEXT NOT NULL,
                message TEXT NOT NULL,
                session_id TEXT,
                run_id TEXT,
                dispatched_at TEXT,
                completed_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_agent_runtime_status
                ON agent_runtime_states(status, updated_at DESC);

            CREATE INDEX IF NOT EXISTS idx_agent_queue_agent_status
                ON agent_queue_entries(project_id, agent_id, status, created_at ASC);

            CREATE INDEX IF NOT EXISTS idx_agent_queue_status
                ON agent_queue_entries(status, created_at ASC);

            CREATE INDEX IF NOT EXISTS idx_agent_queue_session
                ON agent_queue_entries(session_id);

            CREATE TABLE IF NOT EXISTS session_list_entries (
                session_id TEXT PRIMARY KEY,
                dismissed_at TEXT,
                hidden_reason TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_session_list_entries_dismissed_at
                ON session_list_entries(dismissed_at ASC);

            CREATE TABLE IF NOT EXISTS session_catalog (
                session_id TEXT PRIMARY KEY,
                project_slug TEXT NOT NULL,
                session_path TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                title TEXT NOT NULL,
                status TEXT NOT NULL,
                file_size INTEGER NOT NULL,
                file_mtime_ms INTEGER NOT NULL,
                last_indexed_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_session_catalog_project_updated
                ON session_catalog(project_slug, updated_at DESC);

            CREATE UNIQUE INDEX IF NOT EXISTS idx_session_catalog_path
                ON session_catalog(session_path);

            CREATE INDEX IF NOT EXISTS idx_session_catalog_project_path
                ON session_catalog(project_slug, session_path);

            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                project_id TEXT,
                session_path TEXT NOT NULL UNIQUE,
                transcript_path TEXT,
                title TEXT NOT NULL,
                session_kind TEXT NOT NULL,
                session_status TEXT NOT NULL DEFAULT 'active',
                list_visibility TEXT NOT NULL DEFAULT 'active',
                hidden_reason TEXT,
                dismissed_at TEXT,
                first_seen_at TEXT NOT NULL DEFAULT '',
                last_seen_at TEXT NOT NULL DEFAULT '',
                owner_worker_type TEXT,
                owner_worker_id TEXT,
                agent_id TEXT,
                role_id TEXT,
                role_instance_id TEXT,
                task_id TEXT,
                workflow_id TEXT,
                lane_id TEXT,
                assignment_id TEXT,
                primary_task_id TEXT,
                primary_workflow_id TEXT,
                primary_lane_id TEXT,
                primary_assignment_id TEXT,
                worker_type TEXT,
                worker_id TEXT,
                runtime_cwd TEXT,
                transcript_cwd TEXT,
                transcript_exists INTEGER NOT NULL DEFAULT 1,
                file_size INTEGER,
                file_mtime_ms INTEGER,
                last_indexed_at TEXT,
                lifecycle_state TEXT NOT NULL DEFAULT 'active',
                supersedes_session_id TEXT,
                superseded_by_session_id TEXT,
                closed_at TEXT,
                archived_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL,
                FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE SET NULL,
                FOREIGN KEY(role_id) REFERENCES roles(id) ON DELETE SET NULL,
                FOREIGN KEY(role_instance_id) REFERENCES role_instances(id) ON DELETE SET NULL,
                FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE SET NULL,
                FOREIGN KEY(workflow_id) REFERENCES workflows(id) ON DELETE SET NULL,
                FOREIGN KEY(assignment_id) REFERENCES task_lane_assignments(id) ON DELETE SET NULL,
                FOREIGN KEY(workflow_id, lane_id)
                    REFERENCES workflow_lanes(workflow_id, id)
                    ON DELETE SET NULL,
                FOREIGN KEY(primary_task_id) REFERENCES tasks(id) ON DELETE SET NULL,
                FOREIGN KEY(primary_workflow_id) REFERENCES workflows(id) ON DELETE SET NULL,
                FOREIGN KEY(primary_assignment_id) REFERENCES task_lane_assignments(id) ON DELETE SET NULL,
                FOREIGN KEY(primary_workflow_id, primary_lane_id)
                    REFERENCES workflow_lanes(workflow_id, id)
                    ON DELETE SET NULL,
                FOREIGN KEY(supersedes_session_id) REFERENCES sessions(id) ON DELETE SET NULL,
                FOREIGN KEY(superseded_by_session_id) REFERENCES sessions(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS provider_usage_snapshots (
                adapter TEXT NOT NULL,
                scope_key TEXT NOT NULL,
                checked_at TEXT NOT NULL,
                status TEXT NOT NULL,
                raw_json TEXT,
                error_message TEXT,
                next_poll_after TEXT NOT NULL,
                PRIMARY KEY (adapter, scope_key)
            );

            CREATE TABLE IF NOT EXISTS model_limit_states (
                model_key TEXT PRIMARY KEY,
                provider TEXT NOT NULL,
                model_id TEXT NOT NULL,
                api TEXT,
                adapter TEXT NOT NULL,
                scope_key TEXT NOT NULL,
                is_capped INTEGER NOT NULL DEFAULT 0,
                last_checked_at TEXT,
                capped_at TEXT,
                cleared_at TEXT,
                last_error TEXT,
                reason TEXT,
                metrics_json TEXT,
                updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_model_limit_states_provider_model
                ON model_limit_states(provider, model_id, is_capped);

            CREATE TABLE IF NOT EXISTS session_model_snapshots (
                session_id TEXT PRIMARY KEY,
                provider TEXT NOT NULL,
                model_id TEXT NOT NULL,
                api TEXT,
                source TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_session_model_snapshots_provider_model
                ON session_model_snapshots(provider, model_id, updated_at DESC);

            CREATE TABLE IF NOT EXISTS worker_reminders (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                actor_type TEXT NOT NULL,
                actor_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                task_id TEXT,
                message TEXT NOT NULL,
                due_at TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_worker_reminders_due_at
                ON worker_reminders(due_at ASC, created_at ASC);

            CREATE INDEX IF NOT EXISTS idx_worker_reminders_actor
                ON worker_reminders(actor_type, actor_id, due_at ASC);

            CREATE TABLE IF NOT EXISTS remote_access_settings (
                id TEXT PRIMARY KEY,
                enabled INTEGER NOT NULL DEFAULT 0,
                use_tailscale INTEGER NOT NULL DEFAULT 0,
                bind_host TEXT NOT NULL DEFAULT '0.0.0.0',
                port INTEGER NOT NULL DEFAULT 49500,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS source_control_settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                git_user_name_template TEXT,
                git_email_template TEXT,
                updated_at TEXT
            );

            CREATE TABLE IF NOT EXISTS project_runtime_settings (
                project_id TEXT PRIMARY KEY,
                task_session_context_template TEXT,
                auto_dispatch_on_blocker_completion INTEGER NOT NULL DEFAULT 1,
                git_user_name_template TEXT,
                git_email_template TEXT,
                updated_at TEXT,
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS project_secret_metadata (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                secret_key TEXT NOT NULL,
                description TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_rotated_at TEXT NOT NULL,
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
                UNIQUE(project_id, secret_key)
            );

            CREATE INDEX IF NOT EXISTS idx_project_secret_metadata_project_key
                ON project_secret_metadata(project_id, secret_key);

            CREATE TABLE IF NOT EXISTS remote_pairing_codes (
                id TEXT PRIMARY KEY,
                code_hash TEXT NOT NULL,
                display_code TEXT NOT NULL,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                consumed_at TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_remote_pairing_codes_expires
                ON remote_pairing_codes(expires_at ASC, consumed_at ASC);

            CREATE TABLE IF NOT EXISTS remote_devices (
                id TEXT PRIMARY KEY,
                label TEXT NOT NULL,
                platform TEXT NOT NULL,
                push_token TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_seen_at TEXT,
                revoked_at TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_remote_devices_revoked
                ON remote_devices(revoked_at ASC, updated_at DESC);

            CREATE TABLE IF NOT EXISTS remote_device_tokens (
                id TEXT PRIMARY KEY,
                device_id TEXT NOT NULL,
                token_hash TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_used_at TEXT,
                revoked_at TEXT,
                FOREIGN KEY(device_id) REFERENCES remote_devices(id) ON DELETE CASCADE
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_remote_device_tokens_hash
                ON remote_device_tokens(token_hash);

            CREATE INDEX IF NOT EXISTS idx_remote_device_tokens_device
                ON remote_device_tokens(device_id, revoked_at ASC, updated_at DESC);

            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                sequence_number INTEGER NOT NULL,
                number TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT,
                task_type TEXT NOT NULL,
                status TEXT NOT NULL,
                priority TEXT NOT NULL,
                workflow_id TEXT,
                current_lane_id TEXT,
                assignee_type TEXT NOT NULL,
                assignee_id TEXT,
                repository_id TEXT,
                parent_task_id TEXT,
                whip_max_attempts INTEGER NOT NULL DEFAULT 10,
                auto_blocked_by_dependencies INTEGER NOT NULL DEFAULT 0,
                archived INTEGER NOT NULL DEFAULT 0,
                source_schedule_id TEXT,
                source_schedule_occurrence_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(workflow_id) REFERENCES workflows(id) ON DELETE SET NULL,
                FOREIGN KEY(parent_task_id) REFERENCES tasks(id) ON DELETE SET NULL
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_project_sequence
                ON tasks(project_id, sequence_number);

            CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_project_number
                ON tasks(project_id, number);

            CREATE INDEX IF NOT EXISTS idx_tasks_updated_at
                ON tasks(updated_at DESC);

            CREATE INDEX IF NOT EXISTS idx_tasks_parent
                ON tasks(parent_task_id);

            CREATE TABLE IF NOT EXISTS task_tags (
                task_id TEXT NOT NULL,
                tag TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (task_id, tag),
                FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_task_tags_tag_task_id
                ON task_tags(tag, task_id);

            CREATE TABLE IF NOT EXISTS task_comments (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                parent_comment_id TEXT,
                author TEXT NOT NULL,
                origin_type TEXT NOT NULL DEFAULT 'user',
                origin_id TEXT,
                message TEXT NOT NULL,
                interrupt_agent INTEGER NOT NULL DEFAULT 0,
                repository_id TEXT,
                relative_path TEXT,
                line_start INTEGER,
                line_end INTEGER,
                column_start INTEGER,
                column_end INTEGER,
                selected_text TEXT,
                anchor_commit_hash TEXT,
                anchor_has_uncommitted_changes INTEGER,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
                FOREIGN KEY(parent_comment_id) REFERENCES task_comments(id) ON DELETE CASCADE,
                FOREIGN KEY(repository_id) REFERENCES repositories(id) ON DELETE SET NULL
            );

            CREATE INDEX IF NOT EXISTS idx_task_comments_task_id
                ON task_comments(task_id, created_at ASC);

            CREATE TABLE IF NOT EXISTS task_comment_receipts (
                comment_id TEXT NOT NULL,
                task_id TEXT NOT NULL,
                assignment_id TEXT NOT NULL,
                worker_type TEXT NOT NULL,
                worker_id TEXT,
                role_instance_id TEXT,
                session_id TEXT NOT NULL,
                read_at TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (comment_id, session_id),
                FOREIGN KEY(comment_id) REFERENCES task_comments(id) ON DELETE CASCADE,
                FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
                FOREIGN KEY(assignment_id) REFERENCES task_lane_assignments(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_task_comment_receipts_task_id
                ON task_comment_receipts(task_id, read_at ASC);

            CREATE INDEX IF NOT EXISTS idx_task_comment_receipts_assignment_id
                ON task_comment_receipts(assignment_id, read_at ASC);

            CREATE TABLE IF NOT EXISTS task_comment_user_receipts (
                comment_id TEXT NOT NULL,
                task_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                read_at TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (comment_id, user_id),
                FOREIGN KEY(comment_id) REFERENCES task_comments(id) ON DELETE CASCADE,
                FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_task_comment_user_receipts_task_user
                ON task_comment_user_receipts(task_id, user_id, read_at ASC);

            CREATE TABLE IF NOT EXISTS mailbox_messages (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                task_id TEXT,
                sender_type TEXT NOT NULL,
                sender_id TEXT,
                sender_label TEXT NOT NULL,
                body TEXT NOT NULL,
                priority TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_mailbox_messages_project_id
                ON mailbox_messages(project_id, created_at DESC);

            CREATE INDEX IF NOT EXISTS idx_mailbox_messages_task_id
                ON mailbox_messages(task_id, created_at DESC);

            CREATE TABLE IF NOT EXISTS mailbox_message_deliveries (
                id TEXT PRIMARY KEY,
                message_id TEXT NOT NULL,
                recipient_type TEXT NOT NULL,
                recipient_id TEXT,
                recipient_label TEXT NOT NULL,
                assignment_id TEXT,
                read_at TEXT,
                read_session_id TEXT,
                archived_at TEXT,
                last_notified_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(message_id) REFERENCES mailbox_messages(id) ON DELETE CASCADE,
                FOREIGN KEY(assignment_id) REFERENCES task_lane_assignments(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_mailbox_message_deliveries_recipient
                ON mailbox_message_deliveries(recipient_type, recipient_id, read_at ASC, created_at DESC);

            CREATE INDEX IF NOT EXISTS idx_mailbox_message_deliveries_assignment
                ON mailbox_message_deliveries(assignment_id, read_at ASC, created_at DESC);

            CREATE INDEX IF NOT EXISTS idx_mailbox_message_deliveries_message
                ON mailbox_message_deliveries(message_id);

            CREATE TABLE IF NOT EXISTS channels (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                name TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL,
                target_agent_id TEXT NOT NULL,
                default_project_id TEXT,
                config_json TEXT NOT NULL DEFAULT '{}',
                state_json TEXT NOT NULL DEFAULT '{}',
                last_error TEXT,
                last_activity_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(default_project_id) REFERENCES projects(id) ON DELETE SET NULL,
                FOREIGN KEY(target_agent_id) REFERENCES agents(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS channel_secrets (
                channel_id TEXT PRIMARY KEY,
                secret_json TEXT NOT NULL DEFAULT '{}',
                updated_at TEXT NOT NULL,
                FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS channel_activity (
                id TEXT PRIMARY KEY,
                channel_id TEXT NOT NULL,
                direction TEXT NOT NULL,
                message_kind TEXT NOT NULL,
                external_message_id TEXT,
                chat_id TEXT,
                session_id TEXT,
                run_id TEXT,
                body TEXT NOT NULL,
                status TEXT NOT NULL,
                error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_channel_activity_channel_id
                ON channel_activity(channel_id, created_at DESC);

            CREATE INDEX IF NOT EXISTS idx_channel_activity_status
                ON channel_activity(channel_id, status, created_at ASC);

            CREATE TABLE IF NOT EXISTS session_run_origins (
                run_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                source_type TEXT NOT NULL,
                channel_id TEXT,
                channel_activity_id TEXT,
                project_id TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY(channel_id) REFERENCES channels(id) ON DELETE CASCADE,
                FOREIGN KEY(channel_activity_id) REFERENCES channel_activity(id) ON DELETE SET NULL,
                FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL
            );

            CREATE INDEX IF NOT EXISTS idx_session_run_origins_session_id
                ON session_run_origins(session_id, created_at DESC);

            CREATE TABLE IF NOT EXISTS task_lane_runs (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                lane_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                result TEXT NOT NULL,
                notes TEXT,
                started_at TEXT NOT NULL,
                completed_at TEXT,
                FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_task_lane_runs_task_id
                ON task_lane_runs(task_id, started_at ASC);

            CREATE TABLE IF NOT EXISTS task_dependencies (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                blocker_task_id TEXT NOT NULL,
                blocked_task_id TEXT NOT NULL,
                blocker_workflow_id TEXT,
                blocker_lane_id TEXT,
                blocker_lane_order INTEGER,
                created_at TEXT NOT NULL,
                FOREIGN KEY(blocker_task_id) REFERENCES tasks(id) ON DELETE CASCADE,
                FOREIGN KEY(blocked_task_id) REFERENCES tasks(id) ON DELETE CASCADE
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_task_dependencies_unique_edge
                ON task_dependencies(project_id, blocker_task_id, blocked_task_id);

            CREATE INDEX IF NOT EXISTS idx_task_dependencies_blocker
                ON task_dependencies(blocker_task_id);

            CREATE INDEX IF NOT EXISTS idx_task_dependencies_blocked
                ON task_dependencies(blocked_task_id);

            CREATE TABLE IF NOT EXISTS task_attachments (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                task_id TEXT NOT NULL,
                file_name TEXT NOT NULL,
                media_type TEXT NOT NULL,
                byte_size INTEGER NOT NULL,
                stored_path TEXT NOT NULL,
                caption TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_task_attachments_task_id
                ON task_attachments(task_id, created_at ASC);

            CREATE TABLE IF NOT EXISTS task_todos (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                lane_id TEXT NOT NULL,
                description TEXT NOT NULL,
                completed INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_task_todos_task_id
                ON task_todos(task_id, created_at ASC);

            CREATE INDEX IF NOT EXISTS idx_task_todos_task_lane_completed
                ON task_todos(task_id, lane_id, completed, created_at ASC);

            CREATE TABLE IF NOT EXISTS task_repositories (
                task_id TEXT NOT NULL,
                repository_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (task_id, repository_id),
                FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
                FOREIGN KEY(repository_id) REFERENCES repositories(id) ON DELETE CASCADE
            );

            INSERT OR IGNORE INTO task_repositories (task_id, repository_id, created_at)
            SELECT id, repository_id, updated_at
            FROM tasks
            WHERE repository_id IS NOT NULL;

            CREATE INDEX IF NOT EXISTS idx_task_repositories_task_id
                ON task_repositories(task_id, created_at ASC);

            CREATE TABLE IF NOT EXISTS task_file_references (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                task_id TEXT NOT NULL,
                repository_id TEXT NOT NULL,
                relative_path TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
                FOREIGN KEY(repository_id) REFERENCES repositories(id) ON DELETE CASCADE
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_task_file_references_unique
                ON task_file_references(task_id, repository_id, relative_path);

            CREATE INDEX IF NOT EXISTS idx_task_file_references_task_id
                ON task_file_references(task_id, created_at ASC);

            CREATE TABLE IF NOT EXISTS task_lane_assignments (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                workflow_id TEXT NOT NULL,
                lane_id TEXT NOT NULL,
                worker_type TEXT NOT NULL,
                worker_id TEXT,
                status TEXT NOT NULL,
                session_id TEXT,
                runtime_cwd TEXT,
                role_queue_entry_id TEXT,
                role_instance_id TEXT,
                prompt TEXT,
                pending_outcome TEXT,
                completion_notes TEXT,
                whip_count INTEGER NOT NULL DEFAULT 0,
                last_whip_at TEXT,
                started_at TEXT NOT NULL,
                completed_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_task_lane_assignments_task_id
                ON task_lane_assignments(task_id, status, updated_at DESC);

            CREATE INDEX IF NOT EXISTS idx_task_lane_assignments_session_id
                ON task_lane_assignments(session_id);

            CREATE TABLE IF NOT EXISTS workflows (
                id TEXT PRIMARY KEY,
                slug TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                description TEXT,
                archived INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS workflow_lanes (
                id TEXT NOT NULL,
                workflow_id TEXT NOT NULL,
                lane_key TEXT NOT NULL,
                name TEXT NOT NULL,
                description TEXT,
                lane_order INTEGER NOT NULL,
                assigned_entity_type TEXT NOT NULL,
                assigned_entity_id TEXT,
                entry_prompt_template TEXT,
                use_separate_worktree INTEGER NOT NULL DEFAULT 0,
                require_user_approval_on_success INTEGER NOT NULL DEFAULT 0,
                success_transition_type TEXT NOT NULL DEFAULT 'end',
                success_target_lane_id TEXT,
                failure_transition_type TEXT NOT NULL DEFAULT 'end',
                failure_target_lane_id TEXT,
                user_intervention_target_lane_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (workflow_id, id),
                FOREIGN KEY(workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_lanes_workflow_key
                ON workflow_lanes(workflow_id, lane_key);

            CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_lanes_workflow_order
                ON workflow_lanes(workflow_id, lane_order);

            CREATE TABLE IF NOT EXISTS domain_events (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                id TEXT NOT NULL UNIQUE,
                project_id TEXT,
                topic TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                entity_id TEXT,
                payload_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_domain_events_project_topic
                ON domain_events(project_id, topic, sequence ASC);

            CREATE INDEX IF NOT EXISTS idx_domain_events_topic
                ON domain_events(topic, sequence ASC);

            CREATE TABLE IF NOT EXISTS task_schedules (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT,
                task_type TEXT NOT NULL,
                priority TEXT NOT NULL,
                workflow_id TEXT,
                task_blueprint_json TEXT NOT NULL,
                trigger_type TEXT NOT NULL,
                trigger_json TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                one_shot INTEGER NOT NULL DEFAULT 0,
                overlap_policy TEXT NOT NULL DEFAULT 'skip',
                next_fire_at TEXT,
                last_fired_at TEXT,
                last_materialized_task_id TEXT,
                last_error TEXT,
                consumed_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(workflow_id) REFERENCES workflows(id) ON DELETE SET NULL
            );

            CREATE INDEX IF NOT EXISTS idx_task_schedules_project_updated
                ON task_schedules(project_id, updated_at DESC);

            CREATE INDEX IF NOT EXISTS idx_task_schedules_due
                ON task_schedules(trigger_type, enabled, consumed_at, next_fire_at ASC);

            CREATE TABLE IF NOT EXISTS task_schedule_occurrences (
                id TEXT PRIMARY KEY,
                schedule_id TEXT NOT NULL,
                occurrence_key TEXT NOT NULL,
                scheduled_at TEXT,
                event_id TEXT,
                status TEXT NOT NULL,
                task_id TEXT,
                error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(schedule_id) REFERENCES task_schedules(id) ON DELETE CASCADE
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_task_schedule_occurrences_unique
                ON task_schedule_occurrences(schedule_id, occurrence_key);

            CREATE INDEX IF NOT EXISTS idx_task_schedule_occurrences_schedule_created
                ON task_schedule_occurrences(schedule_id, created_at DESC);
            "#,
        )
        .map_err(|error| format!("Unable to initialize Orchestra database schema: {error}"))?;

    ensure_projects_table_columns(connection)?;
    backfill_missing_project_task_prefixes(connection)?;
    ensure_projects_task_prefix_index(connection)?;
    ensure_agents_table_columns(connection)?;
    backfill_missing_agent_slugs(connection)?;
    ensure_agents_slug_index(connection)?;
    ensure_repositories_table_columns(connection)?;
    ensure_roles_table_columns(connection)?;
    backfill_missing_role_slugs(connection)?;
    ensure_roles_slug_index(connection)?;
    ensure_skills_tables(connection)?;
    ensure_tasks_table_columns(connection)?;
    ensure_task_dependencies_table_columns(connection)?;
    ensure_task_tag_tables(connection)?;
    ensure_sessions_table_columns(connection)?;
    ensure_task_comments_table_columns(connection)?;
    ensure_session_list_entry_columns(connection)?;
    ensure_mailbox_tables(connection)?;
    ensure_mailbox_table_columns(connection)?;
    ensure_task_lane_assignments_table_columns(connection)?;
    ensure_task_file_references_table_columns(connection)?;
    ensure_domain_events_tables(connection)?;
    ensure_task_schedule_tables(connection)?;
    ensure_remote_access_settings_columns(connection)?;
    migrate_workflow_worker_references_to_slugs(connection)?;
    ensure_workflow_transition_columns(connection)?;
    migrate_legacy_workflow_intervention_semantics(connection)?;
    crate::services::canonical_sessions::backfill_sessions_table(connection)?;
    Ok(())
}

fn ensure_projects_table_columns(connection: &Connection) -> Result<(), String> {
    let columns = table_columns(connection, "projects")?;

    if !columns.contains("task_prefix") {
        connection
            .execute("ALTER TABLE projects ADD COLUMN task_prefix TEXT", [])
            .map_err(|error| {
                format!("Unable to add task_prefix column to projects table: {error}")
            })?;
    }

    Ok(())
}

fn backfill_missing_project_task_prefixes(connection: &Connection) -> Result<(), String> {
    let projects = connection
        .prepare(
            r#"
            SELECT id, slug, name, task_prefix
            FROM projects
            ORDER BY CASE WHEN id = 'orchestra' OR slug = 'orchestra' THEN 0 ELSE 1 END, created_at ASC, id ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare project prefix backfill query: {error}"))?
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(|error| format!("Unable to query projects for prefix backfill: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to collect projects for prefix backfill: {error}"))?;

    let mut used_prefixes = HashSet::new();

    for (project_id, project_slug, project_name, stored_prefix) in projects {
        let normalized_existing = stored_prefix
            .as_deref()
            .and_then(normalize_task_prefix_candidate)
            .filter(|prefix| !used_prefixes.contains(prefix));

        let task_prefix = if let Some(prefix) = normalized_existing {
            prefix
        } else if let Some(prefix) = infer_existing_project_task_prefix(connection, &project_id)?
            .filter(|prefix| !used_prefixes.contains(prefix))
        {
            prefix
        } else if is_default_project(&project_id, &project_slug) && !used_prefixes.contains("ORC") {
            "ORC".into()
        } else {
            next_available_project_task_prefix(&project_name, &project_slug, &used_prefixes)
        };

        used_prefixes.insert(task_prefix.clone());

        if stored_prefix.as_deref() != Some(task_prefix.as_str()) {
            connection
                .execute(
                    "UPDATE projects SET task_prefix = ?2 WHERE id = ?1",
                    params![project_id, task_prefix],
                )
                .map_err(|error| {
                    format!("Unable to backfill task prefix for project {project_id}: {error}")
                })?;
        }
    }

    Ok(())
}

fn ensure_projects_task_prefix_index(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_task_prefix_unique ON projects(UPPER(task_prefix))",
            [],
        )
        .map_err(|error| format!("Unable to create unique projects task prefix index: {error}"))?;
    Ok(())
}

fn is_default_project(project_id: &str, project_slug: &str) -> bool {
    project_id == "orchestra" || project_slug == "orchestra"
}

fn infer_existing_project_task_prefix(
    connection: &Connection,
    project_id: &str,
) -> Result<Option<String>, String> {
    let numbers = connection
        .prepare(
            "SELECT number FROM tasks WHERE project_id = ?1 ORDER BY sequence_number ASC, created_at ASC",
        )
        .map_err(|error| format!("Unable to prepare task number query for project {project_id}: {error}"))?
        .query_map([project_id], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Unable to query task numbers for project {project_id}: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to collect task numbers for project {project_id}: {error}"))?;

    let prefixes = numbers
        .into_iter()
        .filter_map(|number| task_prefix_from_number(&number))
        .filter(|prefix| prefix != "ORC")
        .collect::<HashSet<_>>();

    if prefixes.len() == 1 {
        Ok(prefixes.into_iter().next())
    } else {
        Ok(None)
    }
}

fn task_prefix_from_number(number: &str) -> Option<String> {
    let (prefix, suffix) = number.rsplit_once('-')?;
    if suffix.is_empty() || !suffix.chars().all(|character| character.is_ascii_digit()) {
        return None;
    }
    normalize_task_prefix_candidate(prefix)
}

fn normalize_task_prefix_candidate(value: &str) -> Option<String> {
    let normalized = value.trim().to_uppercase();
    if normalized.len() < 2 || normalized.len() > 8 {
        return None;
    }
    let mut characters = normalized.chars();
    let first = characters.next()?;
    if !first.is_ascii_alphabetic()
        || !characters.all(|character| character.is_ascii_alphanumeric())
    {
        return None;
    }
    Some(normalized)
}

fn next_available_project_task_prefix(
    project_name: &str,
    project_slug: &str,
    used_prefixes: &HashSet<String>,
) -> String {
    let base = project_task_prefix_base(project_name, project_slug);
    let mut candidate = base.clone();
    let mut suffix = 2;

    while used_prefixes.contains(&candidate) {
        let suffix_text = suffix.to_string();
        let base_length = (8usize.saturating_sub(suffix_text.len())).max(1);
        let trimmed_base = &base[..base.len().min(base_length)];
        candidate = format!("{trimmed_base}{suffix_text}");
        suffix += 1;
    }

    candidate
}

fn project_task_prefix_base(project_name: &str, project_slug: &str) -> String {
    let words = project_name
        .split(|character: char| !character.is_ascii_alphanumeric())
        .filter_map(|part| {
            let normalized = uppercase_ascii_alphanumeric(part);
            if normalized.is_empty() {
                None
            } else {
                Some(normalized)
            }
        })
        .collect::<Vec<_>>();

    let mut candidate = if words.len() > 1 {
        words
            .iter()
            .filter_map(|word| word.chars().next())
            .collect::<String>()
    } else {
        uppercase_ascii_alphanumeric(project_name)
            .chars()
            .take(3)
            .collect::<String>()
    };

    if candidate.len() < 2 {
        candidate = uppercase_ascii_alphanumeric(project_name);
    }
    if candidate.len() < 2 {
        candidate = uppercase_ascii_alphanumeric(project_slug);
    }
    if candidate.is_empty() {
        candidate = "PR".into();
    }
    if !candidate
        .chars()
        .next()
        .is_some_and(|character| character.is_ascii_alphabetic())
    {
        candidate = format!("P{candidate}");
    }
    if candidate.len() < 2 {
        candidate.push('X');
    }
    candidate.truncate(8);
    if candidate.len() < 2 {
        candidate = format!("{candidate}X");
        candidate.truncate(2);
    }
    candidate
}

fn uppercase_ascii_alphanumeric(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(|character| character.to_uppercase())
        .collect()
}

fn ensure_remote_access_settings_columns(connection: &Connection) -> Result<(), String> {
    let columns = table_columns(connection, "remote_access_settings")?;

    if !columns.contains("use_tailscale") {
        connection
            .execute(
                "ALTER TABLE remote_access_settings ADD COLUMN use_tailscale INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(|error| {
                format!("Unable to add use_tailscale column to remote_access_settings: {error}")
            })?;
    }

    Ok(())
}

fn ensure_repositories_table_columns(connection: &Connection) -> Result<(), String> {
    let columns = table_columns(connection, "repositories")?;

    if !columns.contains("mode") {
        connection
            .execute(
                "ALTER TABLE repositories ADD COLUMN mode TEXT NOT NULL DEFAULT 'existing'",
                [],
            )
            .map_err(|error| format!("Unable to add mode column to repositories: {error}"))?;
    }

    Ok(())
}

fn ensure_agents_table_columns(connection: &Connection) -> Result<(), String> {
    let columns = table_columns(connection, "agents")?;

    if !columns.contains("slug") {
        connection
            .execute("ALTER TABLE agents ADD COLUMN slug TEXT", [])
            .map_err(|error| format!("Unable to add slug column to agents table: {error}"))?;
    }

    if !columns.contains("description") {
        connection
            .execute("ALTER TABLE agents ADD COLUMN description TEXT", [])
            .map_err(|error| {
                format!("Unable to add description column to agents table: {error}")
            })?;
    }

    if !columns.contains("system_prompt") {
        connection
            .execute("ALTER TABLE agents ADD COLUMN system_prompt TEXT", [])
            .map_err(|error| {
                format!("Unable to add system_prompt column to agents table: {error}")
            })?;
    }

    if !columns.contains("provider") {
        connection
            .execute("ALTER TABLE agents ADD COLUMN provider TEXT", [])
            .map_err(|error| format!("Unable to add provider column to agents table: {error}"))?;
    }

    if !columns.contains("model") {
        connection
            .execute("ALTER TABLE agents ADD COLUMN model TEXT", [])
            .map_err(|error| format!("Unable to add model column to agents table: {error}"))?;
    }

    if !columns.contains("role_id") {
        connection
            .execute("ALTER TABLE agents ADD COLUMN role_id TEXT", [])
            .map_err(|error| format!("Unable to add role_id column to agents table: {error}"))?;
    }

    if !columns.contains("scope") {
        connection
            .execute(
                "ALTER TABLE agents ADD COLUMN scope TEXT NOT NULL DEFAULT 'global'",
                [],
            )
            .map_err(|error| format!("Unable to add scope column to agents table: {error}"))?;
    }

    if !columns.contains("project_id") {
        connection
            .execute("ALTER TABLE agents ADD COLUMN project_id TEXT", [])
            .map_err(|error| format!("Unable to add project_id column to agents table: {error}"))?;
    }

    if !columns.contains("thinking_level") {
        connection
            .execute(
                "ALTER TABLE agents ADD COLUMN thinking_level TEXT NOT NULL DEFAULT 'off'",
                [],
            )
            .map_err(|error| {
                format!("Unable to add thinking_level column to agents table: {error}")
            })?;
    }

    if !columns.contains("direct_permissions") {
        connection
            .execute(
                "ALTER TABLE agents ADD COLUMN direct_permissions TEXT NOT NULL DEFAULT '[]'",
                [],
            )
            .map_err(|error| {
                format!("Unable to add direct_permissions column to agents table: {error}")
            })?;
    }

    if !columns.contains("compaction_window") {
        connection
            .execute("ALTER TABLE agents ADD COLUMN compaction_window TEXT", [])
            .map_err(|error| {
                format!("Unable to add compaction_window column to agents table: {error}")
            })?;
    }

    if !columns.contains("system") {
        connection
            .execute(
                "ALTER TABLE agents ADD COLUMN system INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(|error| format!("Unable to add system column to agents table: {error}"))?;
    }

    if !columns.contains("immutable") {
        connection
            .execute(
                "ALTER TABLE agents ADD COLUMN immutable INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(|error| format!("Unable to add immutable column to agents table: {error}"))?;
    }

    connection
        .execute(
            "UPDATE agents SET direct_permissions = '[]' WHERE direct_permissions IS NULL OR trim(direct_permissions) = ''",
            [],
        )
        .map_err(|error| format!("Unable to backfill direct_permissions for agents: {error}"))?;

    connection
        .execute(
            "UPDATE agents SET scope = 'global' WHERE scope IS NULL OR trim(scope) = '' OR scope NOT IN ('global', 'project')",
            [],
        )
        .map_err(|error| format!("Unable to backfill agent scope values: {error}"))?;

    connection
        .execute(
            "UPDATE agents SET project_id = NULL WHERE scope != 'project'",
            [],
        )
        .map_err(|error| format!("Unable to clear project ids for global agents: {error}"))?;

    connection
        .execute(
            "UPDATE agents SET scope = 'global', project_id = NULL WHERE system != 0 OR immutable != 0 OR slug = 'supervisor'",
            [],
        )
        .map_err(|error| format!("Unable to enforce global supervisor agent scope: {error}"))?;

    Ok(())
}

fn backfill_missing_agent_slugs(connection: &Connection) -> Result<(), String> {
    let mut used_slugs = connection
        .prepare("SELECT slug FROM agents WHERE slug IS NOT NULL AND trim(slug) != ''")
        .map_err(|error| format!("Unable to prepare existing agent slug query: {error}"))?
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Unable to read existing agent slugs: {error}"))?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(|error| format!("Unable to collect existing agent slugs: {error}"))?;

    let missing_slugs = connection
        .prepare(
            "SELECT id, name FROM agents WHERE slug IS NULL OR trim(slug) = '' ORDER BY created_at ASC, id ASC",
        )
        .map_err(|error| format!("Unable to prepare missing agent slug query: {error}"))?
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|error| format!("Unable to query agents missing slugs: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to collect agents missing slugs: {error}"))?;

    for (id, name) in missing_slugs {
        let slug = next_available_agent_slug(&name, &mut used_slugs);
        connection
            .execute(
                "UPDATE agents SET slug = ?2 WHERE id = ?1",
                params![id, slug],
            )
            .map_err(|error| format!("Unable to backfill agent slug for {id}: {error}"))?;
    }

    Ok(())
}

fn ensure_agents_slug_index(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_slug ON agents(slug)",
            [],
        )
        .map_err(|error| format!("Unable to create unique agents slug index: {error}"))?;
    Ok(())
}

fn ensure_roles_table_columns(connection: &Connection) -> Result<(), String> {
    let columns = table_columns(connection, "roles")?;

    if !columns.contains("slug") {
        connection
            .execute("ALTER TABLE roles ADD COLUMN slug TEXT", [])
            .map_err(|error| format!("Unable to add slug column to roles table: {error}"))?;
    }

    if !columns.contains("description") {
        connection
            .execute("ALTER TABLE roles ADD COLUMN description TEXT", [])
            .map_err(|error| format!("Unable to add description column to roles table: {error}"))?;
    }

    if !columns.contains("system_prompt") {
        connection
            .execute("ALTER TABLE roles ADD COLUMN system_prompt TEXT", [])
            .map_err(|error| {
                format!("Unable to add system_prompt column to roles table: {error}")
            })?;
    }

    if !columns.contains("provider") {
        connection
            .execute("ALTER TABLE roles ADD COLUMN provider TEXT", [])
            .map_err(|error| format!("Unable to add provider column to roles table: {error}"))?;
    }

    if !columns.contains("model") {
        connection
            .execute("ALTER TABLE roles ADD COLUMN model TEXT", [])
            .map_err(|error| format!("Unable to add model column to roles table: {error}"))?;
    }

    if !columns.contains("thinking_level") {
        connection
            .execute(
                "ALTER TABLE roles ADD COLUMN thinking_level TEXT NOT NULL DEFAULT 'off'",
                [],
            )
            .map_err(|error| {
                format!("Unable to add thinking_level column to roles table: {error}")
            })?;
    }

    if !columns.contains("capacity") {
        connection
            .execute(
                "ALTER TABLE roles ADD COLUMN capacity INTEGER NOT NULL DEFAULT 1",
                [],
            )
            .map_err(|error| format!("Unable to add capacity column to roles table: {error}"))?;
    }

    if !columns.contains("direct_permissions") {
        connection
            .execute(
                "ALTER TABLE roles ADD COLUMN direct_permissions TEXT NOT NULL DEFAULT '[]'",
                [],
            )
            .map_err(|error| {
                format!("Unable to add direct_permissions column to roles table: {error}")
            })?;
    }

    if !columns.contains("compaction_window") {
        connection
            .execute("ALTER TABLE roles ADD COLUMN compaction_window TEXT", [])
            .map_err(|error| {
                format!("Unable to add compaction_window column to roles table: {error}")
            })?;
    }

    connection
        .execute(
            "UPDATE roles SET direct_permissions = '[]' WHERE direct_permissions IS NULL OR trim(direct_permissions) = ''",
            [],
        )
        .map_err(|error| format!("Unable to backfill direct_permissions for roles: {error}"))?;

    Ok(())
}

fn backfill_missing_role_slugs(connection: &Connection) -> Result<(), String> {
    let mut used_slugs = connection
        .prepare("SELECT slug FROM roles WHERE slug IS NOT NULL AND trim(slug) != ''")
        .map_err(|error| format!("Unable to prepare existing role slug query: {error}"))?
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Unable to read existing role slugs: {error}"))?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(|error| format!("Unable to collect existing role slugs: {error}"))?;

    let missing_slugs = connection
        .prepare(
            "SELECT id, name FROM roles WHERE slug IS NULL OR trim(slug) = '' ORDER BY created_at ASC, id ASC",
        )
        .map_err(|error| format!("Unable to prepare missing role slug query: {error}"))?
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|error| format!("Unable to query roles missing slugs: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to collect roles missing slugs: {error}"))?;

    for (id, name) in missing_slugs {
        let slug = next_available_role_slug(&name, &mut used_slugs);
        connection
            .execute(
                "UPDATE roles SET slug = ?2 WHERE id = ?1",
                params![id, slug],
            )
            .map_err(|error| format!("Unable to backfill role slug for {id}: {error}"))?;
    }

    Ok(())
}

fn ensure_roles_slug_index(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_slug ON roles(slug)",
            [],
        )
        .map_err(|error| format!("Unable to create unique roles slug index: {error}"))?;
    Ok(())
}

fn ensure_skills_tables(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS skills (
                id TEXT PRIMARY KEY,
                slug TEXT,
                name TEXT NOT NULL,
                description TEXT,
                source_kind TEXT NOT NULL,
                source_path TEXT NOT NULL,
                content_path TEXT NOT NULL,
                relative_source_path TEXT,
                archived INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL,
                status_reason TEXT,
                shadowed_by_skill_id TEXT,
                last_seen_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(shadowed_by_skill_id) REFERENCES skills(id) ON DELETE SET NULL
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_local_slug_unique
                ON skills(slug)
                WHERE source_kind = 'local';

            CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_source_kind_source_path
                ON skills(source_kind, source_path);

            CREATE INDEX IF NOT EXISTS idx_skills_slug_source_kind
                ON skills(slug, source_kind);

            CREATE INDEX IF NOT EXISTS idx_skills_status_archived
                ON skills(status, archived, updated_at DESC);

            CREATE INDEX IF NOT EXISTS idx_skills_shadowed_by_skill_id
                ON skills(shadowed_by_skill_id);

            CREATE TABLE IF NOT EXISTS skill_scope_bindings (
                id TEXT PRIMARY KEY,
                skill_id TEXT NOT NULL,
                scope_kind TEXT NOT NULL,
                project_id TEXT,
                role_id TEXT,
                agent_id TEXT,
                workflow_id TEXT,
                workflow_lane_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(skill_id) REFERENCES skills(id) ON DELETE CASCADE
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_scope_bindings_unique_scope
                ON skill_scope_bindings(
                    skill_id,
                    scope_kind,
                    IFNULL(project_id, ''),
                    IFNULL(role_id, ''),
                    IFNULL(agent_id, ''),
                    IFNULL(workflow_id, ''),
                    IFNULL(workflow_lane_id, '')
                );

            CREATE INDEX IF NOT EXISTS idx_skill_scope_bindings_skill_id
                ON skill_scope_bindings(skill_id, scope_kind);

            CREATE INDEX IF NOT EXISTS idx_skill_scope_bindings_project_id
                ON skill_scope_bindings(project_id)
                WHERE project_id IS NOT NULL;

            CREATE INDEX IF NOT EXISTS idx_skill_scope_bindings_role_id
                ON skill_scope_bindings(role_id)
                WHERE role_id IS NOT NULL;

            CREATE INDEX IF NOT EXISTS idx_skill_scope_bindings_agent_id
                ON skill_scope_bindings(agent_id)
                WHERE agent_id IS NOT NULL;

            CREATE INDEX IF NOT EXISTS idx_skill_scope_bindings_workflow_id
                ON skill_scope_bindings(workflow_id)
                WHERE workflow_id IS NOT NULL;

            CREATE INDEX IF NOT EXISTS idx_skill_scope_bindings_workflow_lane_id
                ON skill_scope_bindings(workflow_lane_id, workflow_id)
                WHERE workflow_lane_id IS NOT NULL;
            "#,
        )
        .map_err(|error| format!("Unable to ensure skills tables: {error}"))?;
    Ok(())
}

fn ensure_tasks_table_columns(connection: &Connection) -> Result<(), String> {
    let columns = table_columns(connection, "tasks")?;

    if !columns.contains("whip_max_attempts") {
        connection
            .execute(
                "ALTER TABLE tasks ADD COLUMN whip_max_attempts INTEGER NOT NULL DEFAULT 10",
                [],
            )
            .map_err(|error| {
                format!("Unable to add whip_max_attempts column to tasks table: {error}")
            })?;
    }

    connection
        .execute(
            "UPDATE tasks SET whip_max_attempts = 10 WHERE whip_max_attempts IS NULL OR whip_max_attempts < 0",
            [],
        )
        .map_err(|error| format!("Unable to backfill whip_max_attempts for tasks: {error}"))?;

    if !columns.contains("auto_blocked_by_dependencies") {
        connection
            .execute(
                "ALTER TABLE tasks ADD COLUMN auto_blocked_by_dependencies INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(|error| {
                format!(
                    "Unable to add auto_blocked_by_dependencies column to tasks table: {error}"
                )
            })?;
    }

    connection
        .execute(
            "UPDATE tasks SET auto_blocked_by_dependencies = 0 WHERE auto_blocked_by_dependencies IS NULL",
            [],
        )
        .map_err(|error| {
            format!(
                "Unable to backfill auto_blocked_by_dependencies for tasks: {error}"
            )
        })?;

    if !columns.contains("source_schedule_id") {
        connection
            .execute("ALTER TABLE tasks ADD COLUMN source_schedule_id TEXT", [])
            .map_err(|error| {
                format!("Unable to add source_schedule_id column to tasks table: {error}")
            })?;
    }

    if !columns.contains("source_schedule_occurrence_id") {
        connection
            .execute(
                "ALTER TABLE tasks ADD COLUMN source_schedule_occurrence_id TEXT",
                [],
            )
            .map_err(|error| {
                format!(
                    "Unable to add source_schedule_occurrence_id column to tasks table: {error}"
                )
            })?;
    }

    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS idx_tasks_source_schedule_id ON tasks(source_schedule_id, created_at DESC)",
            [],
        )
        .map_err(|error| {
            format!("Unable to create tasks source_schedule_id index: {error}")
        })?;

    Ok(())
}

fn ensure_task_dependencies_table_columns(connection: &Connection) -> Result<(), String> {
    let columns = table_columns(connection, "task_dependencies")?;

    if !columns.contains("blocker_workflow_id") {
        connection
            .execute(
                "ALTER TABLE task_dependencies ADD COLUMN blocker_workflow_id TEXT",
                [],
            )
            .map_err(|error| {
                format!(
                    "Unable to add blocker_workflow_id column to task_dependencies table: {error}"
                )
            })?;
    }

    if !columns.contains("blocker_lane_id") {
        connection
            .execute(
                "ALTER TABLE task_dependencies ADD COLUMN blocker_lane_id TEXT",
                [],
            )
            .map_err(|error| {
                format!("Unable to add blocker_lane_id column to task_dependencies table: {error}")
            })?;
    }

    if !columns.contains("blocker_lane_order") {
        connection
            .execute(
                "ALTER TABLE task_dependencies ADD COLUMN blocker_lane_order INTEGER",
                [],
            )
            .map_err(|error| {
                format!(
                    "Unable to add blocker_lane_order column to task_dependencies table: {error}"
                )
            })?;
    }

    Ok(())
}

fn ensure_task_tag_tables(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS task_tags (
                task_id TEXT NOT NULL,
                tag TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (task_id, tag),
                FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_task_tags_tag_task_id
                ON task_tags(tag, task_id);
            "#,
        )
        .map_err(|error| format!("Unable to ensure task_tags table: {error}"))?;

    Ok(())
}

fn ensure_domain_events_tables(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS domain_events (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                id TEXT NOT NULL UNIQUE,
                project_id TEXT,
                topic TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                entity_id TEXT,
                payload_json TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_domain_events_project_topic
                ON domain_events(project_id, topic, sequence ASC);

            CREATE INDEX IF NOT EXISTS idx_domain_events_topic
                ON domain_events(topic, sequence ASC);
            "#,
        )
        .map_err(|error| format!("Unable to ensure domain_events tables: {error}"))?;

    Ok(())
}

fn ensure_task_schedule_tables(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS task_schedules (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT,
                task_type TEXT NOT NULL,
                priority TEXT NOT NULL,
                workflow_id TEXT,
                task_blueprint_json TEXT NOT NULL,
                trigger_type TEXT NOT NULL,
                trigger_json TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                one_shot INTEGER NOT NULL DEFAULT 0,
                overlap_policy TEXT NOT NULL DEFAULT 'skip',
                next_fire_at TEXT,
                last_fired_at TEXT,
                last_materialized_task_id TEXT,
                last_error TEXT,
                consumed_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(workflow_id) REFERENCES workflows(id) ON DELETE SET NULL
            );

            CREATE INDEX IF NOT EXISTS idx_task_schedules_project_updated
                ON task_schedules(project_id, updated_at DESC);

            CREATE INDEX IF NOT EXISTS idx_task_schedules_due
                ON task_schedules(trigger_type, enabled, consumed_at, next_fire_at ASC);

            CREATE TABLE IF NOT EXISTS task_schedule_occurrences (
                id TEXT PRIMARY KEY,
                schedule_id TEXT NOT NULL,
                occurrence_key TEXT NOT NULL,
                scheduled_at TEXT,
                event_id TEXT,
                status TEXT NOT NULL,
                task_id TEXT,
                error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(schedule_id) REFERENCES task_schedules(id) ON DELETE CASCADE
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_task_schedule_occurrences_unique
                ON task_schedule_occurrences(schedule_id, occurrence_key);

            CREATE INDEX IF NOT EXISTS idx_task_schedule_occurrences_schedule_created
                ON task_schedule_occurrences(schedule_id, created_at DESC);
            "#,
        )
        .map_err(|error| format!("Unable to ensure task schedule tables: {error}"))?;

    Ok(())
}

fn ensure_sessions_table_columns(connection: &Connection) -> Result<(), String> {
    let columns = table_columns(connection, "sessions")?;

    let required_columns = [
        ("project_id", "TEXT"),
        ("session_path", "TEXT NOT NULL DEFAULT ''"),
        ("transcript_path", "TEXT"),
        ("title", "TEXT NOT NULL DEFAULT ''"),
        ("session_kind", "TEXT NOT NULL DEFAULT 'standalone'"),
        ("session_status", "TEXT NOT NULL DEFAULT 'active'"),
        ("list_visibility", "TEXT NOT NULL DEFAULT 'active'"),
        ("hidden_reason", "TEXT"),
        ("dismissed_at", "TEXT"),
        ("first_seen_at", "TEXT NOT NULL DEFAULT ''"),
        ("last_seen_at", "TEXT NOT NULL DEFAULT ''"),
        ("owner_worker_type", "TEXT"),
        ("owner_worker_id", "TEXT"),
        ("agent_id", "TEXT"),
        ("role_id", "TEXT"),
        ("role_instance_id", "TEXT"),
        ("task_id", "TEXT"),
        ("workflow_id", "TEXT"),
        ("lane_id", "TEXT"),
        ("assignment_id", "TEXT"),
        ("primary_task_id", "TEXT"),
        ("primary_workflow_id", "TEXT"),
        ("primary_lane_id", "TEXT"),
        ("primary_assignment_id", "TEXT"),
        ("worker_type", "TEXT"),
        ("worker_id", "TEXT"),
        ("runtime_cwd", "TEXT"),
        ("transcript_cwd", "TEXT"),
        ("transcript_exists", "INTEGER NOT NULL DEFAULT 1"),
        ("file_size", "INTEGER"),
        ("file_mtime_ms", "INTEGER"),
        ("last_indexed_at", "TEXT"),
        ("lifecycle_state", "TEXT NOT NULL DEFAULT 'active'"),
        ("supersedes_session_id", "TEXT"),
        ("superseded_by_session_id", "TEXT"),
        ("closed_at", "TEXT"),
        ("archived_at", "TEXT"),
        ("created_at", "TEXT NOT NULL DEFAULT ''"),
        ("updated_at", "TEXT NOT NULL DEFAULT ''"),
    ];

    for (column, definition) in required_columns {
        if columns.contains(column) {
            continue;
        }
        connection
            .execute(
                &format!("ALTER TABLE sessions ADD COLUMN {column} {definition}"),
                [],
            )
            .map_err(|error| {
                format!("Unable to add sessions.{column} column during migration: {error}")
            })?;
    }

    connection.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_transcript_path ON sessions(transcript_path) WHERE transcript_path IS NOT NULL",
        [],
    ).map_err(|error| format!("Unable to create sessions transcript index: {error}"))?;
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_sessions_project_updated ON sessions(project_id, updated_at DESC)",
        [],
    ).map_err(|error| format!("Unable to create sessions project index: {error}"))?;
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_sessions_project_visibility ON sessions(project_id, list_visibility, updated_at DESC)",
        [],
    ).map_err(|error| format!("Unable to create sessions project visibility index: {error}"))?;
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_sessions_task_updated ON sessions(task_id, updated_at DESC) WHERE task_id IS NOT NULL",
        [],
    ).map_err(|error| format!("Unable to create sessions task index: {error}"))?;
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_sessions_primary_task ON sessions(primary_task_id, updated_at DESC) WHERE primary_task_id IS NOT NULL",
        [],
    ).map_err(|error| format!("Unable to create sessions primary-task index: {error}"))?;
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_sessions_primary_task_lane ON sessions(primary_task_id, primary_lane_id, list_visibility, updated_at DESC) WHERE primary_task_id IS NOT NULL AND primary_lane_id IS NOT NULL",
        [],
    ).map_err(|error| format!("Unable to create sessions primary-task lane index: {error}"))?;
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_sessions_assignment ON sessions(assignment_id) WHERE assignment_id IS NOT NULL",
        [],
    ).map_err(|error| format!("Unable to create sessions assignment index: {error}"))?;
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id, updated_at DESC) WHERE agent_id IS NOT NULL",
        [],
    ).map_err(|error| format!("Unable to create sessions agent index: {error}"))?;
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_sessions_agent_main ON sessions(project_id, agent_id, updated_at DESC) WHERE agent_id IS NOT NULL",
        [],
    ).map_err(|error| format!("Unable to create sessions agent-main index: {error}"))?;
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_sessions_role_instance ON sessions(role_instance_id, updated_at DESC) WHERE role_instance_id IS NOT NULL",
        [],
    ).map_err(|error| format!("Unable to create sessions role-instance index: {error}"))?;
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_sessions_owner_worker ON sessions(owner_worker_type, owner_worker_id, updated_at DESC) WHERE owner_worker_type IS NOT NULL AND owner_worker_id IS NOT NULL",
        [],
    ).map_err(|error| format!("Unable to create sessions owner-worker index: {error}"))?;
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_sessions_lifecycle_updated ON sessions(lifecycle_state, updated_at DESC)",
        [],
    ).map_err(|error| format!("Unable to create sessions lifecycle index: {error}"))?;

    Ok(())
}

fn ensure_task_comments_table_columns(connection: &Connection) -> Result<(), String> {
    let columns = table_columns(connection, "task_comments")?;

    if !columns.contains("parent_comment_id") {
        connection
            .execute(
                "ALTER TABLE task_comments ADD COLUMN parent_comment_id TEXT",
                [],
            )
            .map_err(|error| {
                format!("Unable to add parent_comment_id column to task_comments: {error}")
            })?;
    }

    if !columns.contains("repository_id") {
        connection
            .execute(
                "ALTER TABLE task_comments ADD COLUMN repository_id TEXT",
                [],
            )
            .map_err(|error| {
                format!("Unable to add repository_id column to task_comments: {error}")
            })?;
    }

    if !columns.contains("relative_path") {
        connection
            .execute(
                "ALTER TABLE task_comments ADD COLUMN relative_path TEXT",
                [],
            )
            .map_err(|error| {
                format!("Unable to add relative_path column to task_comments: {error}")
            })?;
    }

    if !columns.contains("origin_type") {
        connection
            .execute(
                "ALTER TABLE task_comments ADD COLUMN origin_type TEXT NOT NULL DEFAULT 'user'",
                [],
            )
            .map_err(|error| {
                format!("Unable to add origin_type column to task_comments: {error}")
            })?;
    }

    if !columns.contains("origin_id") {
        connection
            .execute("ALTER TABLE task_comments ADD COLUMN origin_id TEXT", [])
            .map_err(|error| format!("Unable to add origin_id column to task_comments: {error}"))?;
    }

    if !columns.contains("line_start") {
        connection
            .execute(
                "ALTER TABLE task_comments ADD COLUMN line_start INTEGER",
                [],
            )
            .map_err(|error| {
                format!("Unable to add line_start column to task_comments: {error}")
            })?;
    }

    if !columns.contains("line_end") {
        connection
            .execute("ALTER TABLE task_comments ADD COLUMN line_end INTEGER", [])
            .map_err(|error| format!("Unable to add line_end column to task_comments: {error}"))?;
    }

    if !columns.contains("column_start") {
        connection
            .execute(
                "ALTER TABLE task_comments ADD COLUMN column_start INTEGER",
                [],
            )
            .map_err(|error| {
                format!("Unable to add column_start column to task_comments: {error}")
            })?;
    }

    if !columns.contains("column_end") {
        connection
            .execute(
                "ALTER TABLE task_comments ADD COLUMN column_end INTEGER",
                [],
            )
            .map_err(|error| {
                format!("Unable to add column_end column to task_comments: {error}")
            })?;
    }

    if !columns.contains("selected_text") {
        connection
            .execute(
                "ALTER TABLE task_comments ADD COLUMN selected_text TEXT",
                [],
            )
            .map_err(|error| {
                format!("Unable to add selected_text column to task_comments: {error}")
            })?;
    }

    if !columns.contains("anchor_commit_hash") {
        connection
            .execute(
                "ALTER TABLE task_comments ADD COLUMN anchor_commit_hash TEXT",
                [],
            )
            .map_err(|error| {
                format!("Unable to add anchor_commit_hash column to task_comments: {error}")
            })?;
    }

    if !columns.contains("anchor_has_uncommitted_changes") {
        connection
            .execute(
                "ALTER TABLE task_comments ADD COLUMN anchor_has_uncommitted_changes INTEGER",
                [],
            )
            .map_err(|error| {
                format!(
                    "Unable to add anchor_has_uncommitted_changes column to task_comments: {error}"
                )
            })?;
    }

    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS idx_task_comments_parent_comment_id ON task_comments(task_id, parent_comment_id, created_at ASC)",
            [],
        )
        .map_err(|error| {
            format!(
                "Unable to create task comment parent index after migration: {error}"
            )
        })?;

    connection
        .execute(
            "CREATE INDEX IF NOT EXISTS idx_task_comments_anchor ON task_comments(task_id, repository_id, relative_path, line_start, created_at ASC)",
            [],
        )
        .map_err(|error| {
            format!(
                "Unable to create task comment anchor index after migration: {error}"
            )
        })?;

    connection
        .execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS task_comment_user_receipts (
                comment_id TEXT NOT NULL,
                task_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                read_at TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (comment_id, user_id),
                FOREIGN KEY(comment_id) REFERENCES task_comments(id) ON DELETE CASCADE,
                FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_task_comment_user_receipts_task_user
                ON task_comment_user_receipts(task_id, user_id, read_at ASC);
            "#,
        )
        .map_err(|error| {
            format!("Unable to ensure task comment user receipt tables after migration: {error}")
        })?;

    Ok(())
}

fn ensure_mailbox_tables(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS mailbox_messages (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                task_id TEXT,
                sender_type TEXT NOT NULL,
                sender_id TEXT,
                sender_label TEXT NOT NULL,
                body TEXT NOT NULL,
                priority TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_mailbox_messages_project_id
                ON mailbox_messages(project_id, created_at DESC);

            CREATE INDEX IF NOT EXISTS idx_mailbox_messages_task_id
                ON mailbox_messages(task_id, created_at DESC);

            CREATE TABLE IF NOT EXISTS mailbox_message_deliveries (
                id TEXT PRIMARY KEY,
                message_id TEXT NOT NULL,
                recipient_type TEXT NOT NULL,
                recipient_id TEXT,
                recipient_label TEXT NOT NULL,
                assignment_id TEXT,
                read_at TEXT,
                read_session_id TEXT,
                archived_at TEXT,
                last_notified_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(message_id) REFERENCES mailbox_messages(id) ON DELETE CASCADE,
                FOREIGN KEY(assignment_id) REFERENCES task_lane_assignments(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_mailbox_message_deliveries_recipient
                ON mailbox_message_deliveries(recipient_type, recipient_id, read_at ASC, created_at DESC);

            CREATE INDEX IF NOT EXISTS idx_mailbox_message_deliveries_assignment
                ON mailbox_message_deliveries(assignment_id, read_at ASC, created_at DESC);

            CREATE INDEX IF NOT EXISTS idx_mailbox_message_deliveries_message
                ON mailbox_message_deliveries(message_id);
            "#,
        )
        .map_err(|error| format!("Unable to ensure mailbox tables: {error}"))?;
    Ok(())
}

fn ensure_session_list_entry_columns(connection: &Connection) -> Result<(), String> {
    let columns = table_columns(connection, "session_list_entries")?;

    if !columns.contains("hidden_reason") {
        connection
            .execute(
                "ALTER TABLE session_list_entries ADD COLUMN hidden_reason TEXT",
                [],
            )
            .map_err(|error| {
                format!("Unable to add hidden_reason column to session_list_entries: {error}")
            })?;
    }

    Ok(())
}

fn ensure_mailbox_table_columns(connection: &Connection) -> Result<(), String> {
    let columns = table_columns(connection, "mailbox_message_deliveries")?;

    if !columns.contains("archived_at") {
        connection
            .execute(
                "ALTER TABLE mailbox_message_deliveries ADD COLUMN archived_at TEXT",
                [],
            )
            .map_err(|error| {
                format!("Unable to add archived_at column to mailbox_message_deliveries: {error}")
            })?;
    }

    Ok(())
}

fn ensure_task_lane_assignments_table_columns(connection: &Connection) -> Result<(), String> {
    let columns = table_columns(connection, "task_lane_assignments")?;

    if !columns.contains("pending_outcome") {
        connection
            .execute(
                "ALTER TABLE task_lane_assignments ADD COLUMN pending_outcome TEXT",
                [],
            )
            .map_err(|error| {
                format!("Unable to add pending_outcome column to task_lane_assignments: {error}")
            })?;
    }

    if !columns.contains("completion_notes") {
        connection
            .execute(
                "ALTER TABLE task_lane_assignments ADD COLUMN completion_notes TEXT",
                [],
            )
            .map_err(|error| {
                format!("Unable to add completion_notes column to task_lane_assignments: {error}")
            })?;
    }

    if !columns.contains("whip_count") {
        connection
            .execute(
                "ALTER TABLE task_lane_assignments ADD COLUMN whip_count INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(|error| {
                format!("Unable to add whip_count column to task_lane_assignments: {error}")
            })?;
    }

    if !columns.contains("last_whip_at") {
        connection
            .execute(
                "ALTER TABLE task_lane_assignments ADD COLUMN last_whip_at TEXT",
                [],
            )
            .map_err(|error| {
                format!("Unable to add last_whip_at column to task_lane_assignments: {error}")
            })?;
    }

    connection
        .execute(
            "UPDATE task_lane_assignments SET whip_count = 0 WHERE whip_count IS NULL OR whip_count < 0",
            [],
        )
        .map_err(|error| format!("Unable to backfill whip_count for task_lane_assignments: {error}"))?;

    Ok(())
}

fn ensure_task_file_references_table_columns(connection: &Connection) -> Result<(), String> {
    let columns = table_columns(connection, "task_file_references")?;

    if !columns.contains("is_default") {
        connection
            .execute(
                "ALTER TABLE task_file_references ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(|error| {
                format!("Unable to add is_default column to task_file_references: {error}")
            })?;
    }

    Ok(())
}

fn migrate_workflow_worker_references_to_slugs(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            r#"
        UPDATE workflow_lanes
        SET assigned_entity_id = (
                SELECT slug FROM agents WHERE agents.id = workflow_lanes.assigned_entity_id
            )
        WHERE assigned_entity_type = 'agent'
          AND assigned_entity_id IS NOT NULL
          AND EXISTS(
                SELECT 1 FROM agents WHERE agents.id = workflow_lanes.assigned_entity_id
            );

        UPDATE workflow_lanes
        SET assigned_entity_id = (
                SELECT slug FROM roles WHERE roles.id = workflow_lanes.assigned_entity_id
            )
        WHERE assigned_entity_type = 'role'
          AND assigned_entity_id IS NOT NULL
          AND EXISTS(
                SELECT 1 FROM roles WHERE roles.id = workflow_lanes.assigned_entity_id
            );
        "#,
        )
        .map_err(|error| {
            format!("Unable to migrate workflow worker references to slugs: {error}")
        })?;

    Ok(())
}

fn ensure_workflow_transition_columns(connection: &Connection) -> Result<(), String> {
    let columns = table_columns(connection, "workflow_lanes")?;

    if !columns.contains("use_separate_worktree") {
        connection
            .execute(
                "ALTER TABLE workflow_lanes ADD COLUMN use_separate_worktree INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(|error| format!("Unable to add use_separate_worktree column: {error}"))?;
    }

    if !columns.contains("require_user_approval_on_success") {
        connection
            .execute(
                "ALTER TABLE workflow_lanes ADD COLUMN require_user_approval_on_success INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(|error| format!("Unable to add require_user_approval_on_success column: {error}"))?;
    }

    if !columns.contains("success_transition_type") {
        connection
            .execute(
                "ALTER TABLE workflow_lanes ADD COLUMN success_transition_type TEXT NOT NULL DEFAULT 'end'",
                [],
            )
            .map_err(|error| format!("Unable to add success_transition_type column: {error}"))?;
    }

    if !columns.contains("failure_transition_type") {
        connection
            .execute(
                "ALTER TABLE workflow_lanes ADD COLUMN failure_transition_type TEXT NOT NULL DEFAULT 'end'",
                [],
            )
            .map_err(|error| format!("Unable to add failure_transition_type column: {error}"))?;
    }

    Ok(())
}

fn migrate_legacy_workflow_intervention_semantics(connection: &Connection) -> Result<(), String> {
    connection.execute_batch(
        r#"
        UPDATE workflow_lanes
        SET success_transition_type = CASE
                WHEN success_target_lane_id IS NOT NULL AND trim(success_target_lane_id) != '' THEN 'lane'
                ELSE 'end'
            END
        WHERE success_transition_type IS NULL OR trim(success_transition_type) = '' OR success_transition_type = 'end';

        UPDATE workflow_lanes
        SET failure_transition_type = CASE
                WHEN user_intervention_target_lane_id IS NOT NULL AND trim(user_intervention_target_lane_id) != '' THEN 'user_intervention'
                WHEN failure_target_lane_id IS NOT NULL AND trim(failure_target_lane_id) != '' THEN 'lane'
                ELSE 'end'
            END
        WHERE failure_transition_type IS NULL OR trim(failure_transition_type) = '' OR failure_transition_type = 'end';
        "#,
    ).map_err(|error| format!("Unable to migrate legacy workflow transition semantics: {error}"))?;

    Ok(())
}

fn table_columns(connection: &Connection, table_name: &str) -> Result<HashSet<String>, String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table_name})"))
        .map_err(|error| format!("Unable to inspect {table_name} schema: {error}"))?;

    let rows = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| format!("Unable to read {table_name} schema: {error}"))?;

    rows.collect::<Result<HashSet<_>, _>>()
        .map_err(|error| format!("Unable to collect {table_name} schema: {error}"))
}

fn next_available_agent_slug(name: &str, used_slugs: &mut HashSet<String>) -> String {
    let base_slug = agent_slug_base(name);
    let mut candidate = base_slug.clone();
    let mut suffix = 2;

    while used_slugs.contains(&candidate) {
        candidate = format!("{base_slug}-{suffix}");
        suffix += 1;
    }

    used_slugs.insert(candidate.clone());
    candidate
}

fn agent_slug_base(name: &str) -> String {
    let slug = sanitize_slug(name);
    if slug == "project" {
        "agent".into()
    } else {
        slug
    }
}

fn next_available_role_slug(name: &str, used_slugs: &mut HashSet<String>) -> String {
    let base_slug = role_slug_base(name);
    let mut candidate = base_slug.clone();
    let mut suffix = 2;

    while used_slugs.contains(&candidate) {
        candidate = format!("{base_slug}-{suffix}");
        suffix += 1;
    }

    used_slugs.insert(candidate.clone());
    candidate
}

fn role_slug_base(name: &str) -> String {
    let slug = sanitize_slug(name);
    if slug == "project" {
        "role".into()
    } else {
        slug
    }
}

#[cfg(test)]
pub fn initialize_database_at(path: &std::path::Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Database path {} has no parent directory", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Unable to create directory {}: {error}", parent.display()))?;
    let connection = open_configured_connection(path)?;
    enable_wal_mode(&connection)?;
    apply_migrations(&connection)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        env,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

    fn unique_temp_db(label: &str) -> PathBuf {
        let suffix = format!(
            "{}-{}-{}",
            label,
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time should move forward")
                .as_millis()
        );
        env::temp_dir().join(suffix).join("orchestra.db")
    }

    fn write_legacy_session_file(path: &Path, session_id: &str, title: &str) {
        let parent = path.parent().expect("session file should have a parent");
        fs::create_dir_all(parent).expect("session directory should exist");
        let content = format!(
            concat!(
                "{{\"type\":\"session\",\"version\":3,\"id\":\"{}\",\"timestamp\":\"2026-04-30T00:00:00Z\",\"cwd\":\"/tmp/runtime\"}}\n",
                "{{\"type\":\"session_info\",\"id\":\"info-1\",\"parentId\":null,\"timestamp\":\"2026-04-30T00:00:01Z\",\"name\":\"{}\"}}\n",
                "{{\"type\":\"message\",\"id\":\"msg-1\",\"timestamp\":\"2026-04-30T00:00:02Z\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"text\",\"text\":\"hello\"}}],\"timestamp\":1714435202000}}}}\n"
            ),
            session_id,
            title,
        );
        fs::write(path, content).expect("legacy session file should write");
    }

    #[test]
    fn initialize_database_at_enables_wal_mode() {
        let path = unique_temp_db("wal-mode");
        initialize_database_at(&path).expect("database should initialize");
        let connection = Connection::open(&path).expect("database should open");
        let journal_mode: String = connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .expect("journal mode should query");
        assert_eq!(journal_mode.to_lowercase(), "wal");
    }

    #[test]
    fn migrates_legacy_projects_table_and_backfills_task_prefixes() {
        let path = unique_temp_db("projects-task-prefix-migration");
        let parent = path.parent().expect("temp database should have a parent");
        fs::create_dir_all(parent).expect("parent directory should exist");

        let connection = Connection::open(&path).expect("legacy database should open");
        connection
            .execute_batch(
                r#"
                CREATE TABLE projects (
                    id TEXT PRIMARY KEY,
                    slug TEXT NOT NULL UNIQUE,
                    name TEXT NOT NULL,
                    description TEXT,
                    default_repository_id TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE tasks (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    sequence_number INTEGER NOT NULL,
                    number TEXT NOT NULL,
                    title TEXT NOT NULL,
                    description TEXT,
                    task_type TEXT NOT NULL,
                    status TEXT NOT NULL,
                    priority TEXT NOT NULL,
                    workflow_id TEXT,
                    current_lane_id TEXT,
                    assignee_type TEXT NOT NULL,
                    assignee_id TEXT,
                    repository_id TEXT,
                    parent_task_id TEXT,
                    whip_max_attempts INTEGER NOT NULL DEFAULT 10,
                    archived INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                INSERT INTO projects (id, slug, name, description, default_repository_id, created_at, updated_at)
                VALUES
                    ('orchestra', 'orchestra', 'Orchestra', NULL, NULL, '2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z'),
                    ('project-client', 'client-portal', 'Client Portal', NULL, NULL, '2026-04-01T00:00:01Z', '2026-04-01T00:00:01Z'),
                    ('project-web', 'web-platform', 'Web Platform', NULL, NULL, '2026-04-01T00:00:02Z', '2026-04-01T00:00:02Z');

                INSERT INTO tasks (
                    id, project_id, sequence_number, number, title, description, task_type, status, priority,
                    workflow_id, current_lane_id, assignee_type, assignee_id, repository_id, parent_task_id,
                    whip_max_attempts, archived, created_at, updated_at
                ) VALUES
                    ('task-orc-1', 'orchestra', 1, 'ORC-1', 'Default task', NULL, 'task', 'ready', 'P2', NULL, NULL, 'user', NULL, NULL, NULL, 10, 0, '2026-04-01T00:00:10Z', '2026-04-01T00:00:10Z'),
                    ('task-client-1', 'project-client', 1, 'ORC-1', 'Legacy client task', NULL, 'task', 'ready', 'P2', NULL, NULL, 'user', NULL, NULL, NULL, 10, 0, '2026-04-01T00:00:11Z', '2026-04-01T00:00:11Z'),
                    ('task-web-1', 'project-web', 1, 'WEB2-1', 'Web task', NULL, 'task', 'ready', 'P2', NULL, NULL, 'user', NULL, NULL, NULL, 10, 0, '2026-04-01T00:00:12Z', '2026-04-01T00:00:12Z');
                "#,
            )
            .expect("legacy schema should seed");
        drop(connection);

        initialize_database_at(&path).expect("database migration should succeed");
        let connection = Connection::open(&path).expect("migrated database should open");

        let columns = table_columns(&connection, "projects").expect("projects columns should load");
        assert!(columns.contains("task_prefix"));

        let prefixes = connection
            .prepare("SELECT id, task_prefix FROM projects ORDER BY id ASC")
            .expect("prefix query should prepare")
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .expect("prefix query should execute")
            .collect::<Result<Vec<_>, _>>()
            .expect("prefix rows should collect");
        assert_eq!(
            prefixes,
            vec![
                ("orchestra".into(), "ORC".into()),
                ("project-client".into(), "CP".into()),
                ("project-web".into(), "WEB2".into()),
            ]
        );

        let task_numbers = connection
            .prepare("SELECT id, number FROM tasks ORDER BY id ASC")
            .expect("task query should prepare")
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .expect("task query should execute")
            .collect::<Result<Vec<_>, _>>()
            .expect("task numbers should collect");
        assert_eq!(
            task_numbers,
            vec![
                ("task-client-1".into(), "ORC-1".into()),
                ("task-orc-1".into(), "ORC-1".into()),
                ("task-web-1".into(), "WEB2-1".into()),
            ]
        );

        let indexes = connection
            .prepare("PRAGMA index_list('projects')")
            .expect("index query should prepare")
            .query_map([], |row| row.get::<_, String>(1))
            .expect("index query should execute")
            .collect::<Result<Vec<_>, _>>()
            .expect("indexes should collect");
        assert!(indexes
            .iter()
            .any(|name| name == "idx_projects_task_prefix_unique"));
    }

    #[test]
    fn initializes_agents_table_with_management_columns() {
        let path = unique_temp_db("agents-schema");
        initialize_database_at(&path).expect("database should initialize");
        let connection = Connection::open(&path).expect("database should open");
        let columns = table_columns(&connection, "agents").expect("agents columns should load");

        for expected in [
            "id",
            "slug",
            "name",
            "description",
            "system_prompt",
            "provider",
            "model",
            "thinking_level",
            "archived",
            "created_at",
            "updated_at",
        ] {
            assert!(
                columns.contains(expected),
                "missing expected agents column: {expected}"
            );
        }
    }

    #[test]
    fn initializes_roles_table_with_management_columns() {
        let path = unique_temp_db("roles-schema");
        initialize_database_at(&path).expect("database should initialize");
        let connection = Connection::open(&path).expect("database should open");
        let columns = table_columns(&connection, "roles").expect("roles columns should load");

        for expected in [
            "id",
            "slug",
            "name",
            "description",
            "system_prompt",
            "provider",
            "model",
            "thinking_level",
            "capacity",
            "direct_permissions",
            "archived",
            "created_at",
            "updated_at",
        ] {
            assert!(
                columns.contains(expected),
                "missing expected roles column: {expected}"
            );
        }
    }

    #[test]
    fn initializes_skill_catalog_tables_and_indexes() {
        let path = unique_temp_db("skills-schema");
        initialize_database_at(&path).expect("database should initialize");
        let connection = Connection::open(&path).expect("database should open");

        let skill_columns =
            table_columns(&connection, "skills").expect("skills columns should load");
        for expected in [
            "id",
            "slug",
            "name",
            "description",
            "source_kind",
            "source_path",
            "content_path",
            "relative_source_path",
            "archived",
            "status",
            "status_reason",
            "shadowed_by_skill_id",
            "last_seen_at",
            "created_at",
            "updated_at",
        ] {
            assert!(
                skill_columns.contains(expected),
                "missing expected skills column: {expected}"
            );
        }

        let binding_columns = table_columns(&connection, "skill_scope_bindings")
            .expect("skill_scope_bindings columns should load");
        for expected in [
            "id",
            "skill_id",
            "scope_kind",
            "project_id",
            "role_id",
            "agent_id",
            "workflow_id",
            "workflow_lane_id",
            "created_at",
            "updated_at",
        ] {
            assert!(
                binding_columns.contains(expected),
                "missing expected skill_scope_bindings column: {expected}"
            );
        }

        let skill_indexes = connection
            .prepare("PRAGMA index_list('skills')")
            .expect("skill index query should prepare")
            .query_map([], |row| row.get::<_, String>(1))
            .expect("skill index query should execute")
            .collect::<Result<Vec<_>, _>>()
            .expect("skill indexes should collect");
        for expected in [
            "idx_skills_local_slug_unique",
            "idx_skills_source_kind_source_path",
            "idx_skills_slug_source_kind",
            "idx_skills_status_archived",
            "idx_skills_shadowed_by_skill_id",
        ] {
            assert!(skill_indexes.iter().any(|name| name == expected));
        }

        let binding_indexes = connection
            .prepare("PRAGMA index_list('skill_scope_bindings')")
            .expect("binding index query should prepare")
            .query_map([], |row| row.get::<_, String>(1))
            .expect("binding index query should execute")
            .collect::<Result<Vec<_>, _>>()
            .expect("binding indexes should collect");
        for expected in [
            "idx_skill_scope_bindings_unique_scope",
            "idx_skill_scope_bindings_skill_id",
            "idx_skill_scope_bindings_project_id",
            "idx_skill_scope_bindings_role_id",
            "idx_skill_scope_bindings_agent_id",
            "idx_skill_scope_bindings_workflow_id",
            "idx_skill_scope_bindings_workflow_lane_id",
        ] {
            assert!(binding_indexes.iter().any(|name| name == expected));
        }
    }

    #[test]
    fn initializes_agent_and_policy_tables_with_auth_columns() {
        let path = unique_temp_db("agent-policy-schema");
        initialize_database_at(&path).expect("database should initialize");
        let connection = Connection::open(&path).expect("database should open");

        let agent_columns =
            table_columns(&connection, "agents").expect("agents columns should load");
        for expected in [
            "id",
            "name",
            "role_id",
            "direct_permissions",
            "system",
            "immutable",
            "archived",
            "created_at",
            "updated_at",
        ] {
            assert!(
                agent_columns.contains(expected),
                "missing expected agents column: {expected}"
            );
        }

        let policy_columns =
            table_columns(&connection, "policies").expect("policies columns should load");
        for expected in [
            "id",
            "slug",
            "name",
            "description",
            "permissions",
            "system",
            "immutable",
            "created_at",
            "updated_at",
        ] {
            assert!(
                policy_columns.contains(expected),
                "missing expected policies column: {expected}"
            );
        }

        let agent_policy_columns = table_columns(&connection, "agent_policy_assignments")
            .expect("agent_policy_assignments columns should load");
        for expected in ["agent_id", "policy_id", "created_at"] {
            assert!(
                agent_policy_columns.contains(expected),
                "missing expected agent_policy_assignments column: {expected}"
            );
        }

        let role_policy_columns = table_columns(&connection, "role_policy_assignments")
            .expect("role_policy_assignments columns should load");
        for expected in ["role_id", "policy_id", "created_at"] {
            assert!(
                role_policy_columns.contains(expected),
                "missing expected role_policy_assignments column: {expected}"
            );
        }
    }

    #[test]
    fn initializes_role_runtime_tables() {
        let path = unique_temp_db("role-runtime-schema");
        initialize_database_at(&path).expect("database should initialize");
        let connection = Connection::open(&path).expect("database should open");

        let instance_columns = table_columns(&connection, "role_instances")
            .expect("role_instances columns should load");
        for expected in [
            "id",
            "role_id",
            "display_name",
            "status",
            "current_queue_entry_id",
            "session_id",
            "worktree_path",
            "last_heartbeat_at",
            "last_error",
            "created_at",
            "updated_at",
        ] {
            assert!(
                instance_columns.contains(expected),
                "missing expected role_instances column: {expected}"
            );
        }

        let queue_columns = table_columns(&connection, "role_queue_entries")
            .expect("role_queue_entries columns should load");
        for expected in [
            "id",
            "role_id",
            "status",
            "source_type",
            "source_task_id",
            "source_workflow_id",
            "source_lane_id",
            "title",
            "summary",
            "entry_prompt",
            "assigned_instance_id",
            "created_at",
            "updated_at",
            "started_at",
            "completed_at",
        ] {
            assert!(
                queue_columns.contains(expected),
                "missing expected role_queue_entries column: {expected}"
            );
        }
    }

    #[test]
    fn migrates_legacy_agents_table_and_backfills_unique_slugs_and_workflow_refs() {
        let path = unique_temp_db("agents-migration");
        let parent = path.parent().expect("temp database should have a parent");
        fs::create_dir_all(parent).expect("parent directory should exist");

        let connection = Connection::open(&path).expect("legacy database should open");
        connection
            .execute_batch(
                r#"
                CREATE TABLE agents (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    archived INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE roles (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    archived INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE workflows (
                    id TEXT PRIMARY KEY,
                    slug TEXT NOT NULL UNIQUE,
                    name TEXT NOT NULL,
                    description TEXT,
                    archived INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE workflow_lanes (
                    id TEXT NOT NULL,
                    workflow_id TEXT NOT NULL,
                    lane_key TEXT NOT NULL,
                    name TEXT NOT NULL,
                    description TEXT,
                    lane_order INTEGER NOT NULL,
                    assigned_entity_type TEXT NOT NULL,
                    assigned_entity_id TEXT,
                    entry_prompt_template TEXT,
                    success_transition_type TEXT NOT NULL DEFAULT 'end',
                    success_target_lane_id TEXT,
                    failure_transition_type TEXT NOT NULL DEFAULT 'end',
                    failure_target_lane_id TEXT,
                    user_intervention_target_lane_id TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (workflow_id, id)
                );

                INSERT INTO agents (id, name, archived, created_at, updated_at)
                VALUES ('agent-1', 'Data', 0, '2026-03-18T00:00:00Z', '2026-03-18T00:00:00Z');

                INSERT INTO roles (id, name, archived, created_at, updated_at)
                VALUES ('role-1', 'Reviewer', 0, '2026-03-18T00:00:01Z', '2026-03-18T00:00:01Z');

                INSERT INTO workflows (id, slug, name, description, archived, created_at, updated_at)
                VALUES ('workflow-1', 'development', 'Development', NULL, 0, '2026-03-18T00:00:02Z', '2026-03-18T00:00:02Z');

                INSERT INTO workflow_lanes (
                    id,
                    workflow_id,
                    lane_key,
                    name,
                    description,
                    lane_order,
                    assigned_entity_type,
                    assigned_entity_id,
                    entry_prompt_template,
                    success_transition_type,
                    success_target_lane_id,
                    failure_transition_type,
                    failure_target_lane_id,
                    user_intervention_target_lane_id,
                    created_at,
                    updated_at
                ) VALUES
                    ('lane-agent', 'workflow-1', 'implement', 'Implement', NULL, 0, 'agent', 'agent-1', NULL, 'end', NULL, 'end', NULL, NULL, '2026-03-18T00:00:03Z', '2026-03-18T00:00:03Z'),
                    ('lane-role', 'workflow-1', 'review', 'Review', NULL, 1, 'role', 'role-1', NULL, 'end', NULL, 'end', NULL, NULL, '2026-03-18T00:00:03Z', '2026-03-18T00:00:03Z');
                "#,
            )
            .expect("legacy tables should seed");
        drop(connection);

        initialize_database_at(&path).expect("database migration should succeed");
        let connection = Connection::open(&path).expect("migrated database should open");

        let agent_row = connection
            .query_row(
                "SELECT slug, thinking_level FROM agents WHERE id = 'agent-1'",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .expect("migrated agent should load");
        assert_eq!(agent_row, ("data".into(), "off".into()));

        let role_row = connection
            .query_row(
                "SELECT slug, thinking_level FROM roles WHERE id = 'role-1'",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .expect("migrated role should load");
        assert_eq!(role_row, ("reviewer".into(), "off".into()));

        let lane_refs = connection
            .prepare("SELECT assigned_entity_type, assigned_entity_id FROM workflow_lanes ORDER BY lane_order ASC")
            .expect("lane query should prepare")
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)))
            .expect("lane query should execute")
            .collect::<Result<Vec<_>, _>>()
            .expect("lane refs should collect");

        assert_eq!(
            lane_refs,
            vec![
                ("agent".into(), Some("data".into())),
                ("role".into(), Some("reviewer".into())),
            ]
        );
    }

    #[test]
    fn migrates_legacy_tasks_table_and_adds_schedule_source_columns() {
        let path = unique_temp_db("tasks-schedule-migration");
        let parent = path.parent().expect("temp database should have a parent");
        fs::create_dir_all(parent).expect("parent directory should exist");

        let connection = Connection::open(&path).expect("legacy database should open");
        connection
            .execute_batch(
                r#"
                CREATE TABLE tasks (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    sequence_number INTEGER NOT NULL,
                    number TEXT NOT NULL,
                    title TEXT NOT NULL,
                    description TEXT,
                    task_type TEXT NOT NULL,
                    status TEXT NOT NULL,
                    priority TEXT NOT NULL,
                    workflow_id TEXT,
                    current_lane_id TEXT,
                    assignee_type TEXT NOT NULL,
                    assignee_id TEXT,
                    repository_id TEXT,
                    parent_task_id TEXT,
                    whip_max_attempts INTEGER NOT NULL DEFAULT 10,
                    archived INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                INSERT INTO tasks (
                    id, project_id, sequence_number, number, title, description, task_type, status, priority,
                    workflow_id, current_lane_id, assignee_type, assignee_id, repository_id, parent_task_id,
                    whip_max_attempts, archived, created_at, updated_at
                ) VALUES (
                    'task-1', 'orchestra', 1, 'ORC-1', 'Legacy task', NULL, 'task', 'ready', 'P2',
                    NULL, NULL, 'user', NULL, NULL, NULL,
                    10, 0, '2026-03-18T00:00:00Z', '2026-03-18T00:00:00Z'
                );
                "#,
            )
            .expect("legacy tasks table should seed");
        drop(connection);

        initialize_database_at(&path).expect("database migration should succeed");
        let connection = Connection::open(&path).expect("migrated database should open");

        let columns = table_columns(&connection, "tasks").expect("tasks columns should load");
        for expected in ["source_schedule_id", "source_schedule_occurrence_id"] {
            assert!(
                columns.contains(expected),
                "missing expected tasks column: {expected}"
            );
        }

        let indexes = connection
            .prepare("PRAGMA index_list('tasks')")
            .expect("index query should prepare")
            .query_map([], |row| row.get::<_, String>(1))
            .expect("index query should execute")
            .collect::<Result<Vec<_>, _>>()
            .expect("indexes should collect");
        assert!(indexes
            .iter()
            .any(|name| name == "idx_tasks_source_schedule_id"));
    }

    #[test]
    fn migrates_legacy_tasks_table_and_adds_task_tag_tables() {
        let path = unique_temp_db("tasks-tag-migration");
        let parent = path.parent().expect("temp database should have a parent");
        fs::create_dir_all(parent).expect("parent directory should exist");

        let connection = Connection::open(&path).expect("legacy database should open");
        connection
            .execute_batch(
                r#"
                CREATE TABLE tasks (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    sequence_number INTEGER NOT NULL,
                    number TEXT NOT NULL,
                    title TEXT NOT NULL,
                    description TEXT,
                    task_type TEXT NOT NULL,
                    status TEXT NOT NULL,
                    priority TEXT NOT NULL,
                    workflow_id TEXT,
                    current_lane_id TEXT,
                    assignee_type TEXT NOT NULL,
                    assignee_id TEXT,
                    repository_id TEXT,
                    parent_task_id TEXT,
                    whip_max_attempts INTEGER NOT NULL DEFAULT 10,
                    archived INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                INSERT INTO tasks (
                    id, project_id, sequence_number, number, title, description, task_type, status, priority,
                    workflow_id, current_lane_id, assignee_type, assignee_id, repository_id, parent_task_id,
                    whip_max_attempts, archived, created_at, updated_at
                ) VALUES (
                    'task-1', 'orchestra', 1, 'ORC-1', 'Legacy task', NULL, 'task', 'ready', 'P2',
                    NULL, NULL, 'user', NULL, NULL, NULL,
                    10, 0, '2026-03-18T00:00:00Z', '2026-03-18T00:00:00Z'
                );
                "#,
            )
            .expect("legacy tasks table should seed");
        drop(connection);

        initialize_database_at(&path).expect("database migration should succeed");
        let connection = Connection::open(&path).expect("migrated database should open");

        let tag_columns =
            table_columns(&connection, "task_tags").expect("task_tags columns should load");
        for expected in ["task_id", "tag", "created_at"] {
            assert!(
                tag_columns.contains(expected),
                "missing expected task_tags column: {expected}"
            );
        }

        let indexes = connection
            .prepare("PRAGMA index_list('task_tags')")
            .expect("index query should prepare")
            .query_map([], |row| row.get::<_, String>(1))
            .expect("index query should execute")
            .collect::<Result<Vec<_>, _>>()
            .expect("indexes should collect");
        assert!(indexes
            .iter()
            .any(|name| name == "idx_task_tags_tag_task_id"));

        let legacy_task = connection
            .query_row(
                "SELECT id, number FROM tasks WHERE id = 'task-1'",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .expect("legacy task should remain readable");
        assert_eq!(legacy_task, ("task-1".into(), "ORC-1".into()));
    }

    #[test]
    fn migrates_legacy_task_comments_table_and_adds_reply_index() {
        let path = unique_temp_db("task-comments-migration");
        let parent = path.parent().expect("temp database should have a parent");
        fs::create_dir_all(parent).expect("parent directory should exist");

        let connection = Connection::open(&path).expect("legacy database should open");
        connection
            .execute_batch(
                r#"
                CREATE TABLE tasks (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    sequence_number INTEGER NOT NULL,
                    number TEXT NOT NULL,
                    title TEXT NOT NULL,
                    description TEXT,
                    task_type TEXT NOT NULL,
                    status TEXT NOT NULL,
                    priority TEXT NOT NULL,
                    workflow_id TEXT,
                    current_lane_id TEXT,
                    assignee_type TEXT NOT NULL,
                    assignee_id TEXT,
                    repository_id TEXT,
                    parent_task_id TEXT,
                    whip_max_attempts INTEGER NOT NULL DEFAULT 10,
                    archived INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE task_comments (
                    id TEXT PRIMARY KEY,
                    task_id TEXT NOT NULL,
                    author TEXT NOT NULL,
                    message TEXT NOT NULL,
                    interrupt_agent INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
                );

                INSERT INTO tasks (
                    id, project_id, sequence_number, number, title, description, task_type, status, priority,
                    workflow_id, current_lane_id, assignee_type, assignee_id, repository_id, parent_task_id,
                    whip_max_attempts, archived, created_at, updated_at
                ) VALUES (
                    'task-1', 'orchestra', 1, 'ORC-1', 'Legacy task', NULL, 'task', 'ready', 'P2',
                    NULL, NULL, 'user', NULL, NULL, NULL,
                    10, 0, '2026-03-18T00:00:00Z', '2026-03-18T00:00:00Z'
                );

                INSERT INTO task_comments (id, task_id, author, message, interrupt_agent, created_at, updated_at)
                VALUES ('comment-1', 'task-1', 'Reviewer', 'Legacy comment', 0, '2026-03-18T00:00:01Z', '2026-03-18T00:00:01Z');
                "#,
            )
            .expect("legacy task comments table should seed");
        drop(connection);

        initialize_database_at(&path).expect("database migration should succeed");
        let connection = Connection::open(&path).expect("migrated database should open");

        let columns =
            table_columns(&connection, "task_comments").expect("task comments columns should load");
        for expected in [
            "parent_comment_id",
            "repository_id",
            "relative_path",
            "line_start",
            "line_end",
            "column_start",
            "column_end",
            "selected_text",
            "anchor_commit_hash",
            "anchor_has_uncommitted_changes",
        ] {
            assert!(
                columns.contains(expected),
                "missing expected task_comments column: {expected}"
            );
        }

        let indexes = connection
            .prepare("PRAGMA index_list('task_comments')")
            .expect("index query should prepare")
            .query_map([], |row| row.get::<_, String>(1))
            .expect("index query should execute")
            .collect::<Result<Vec<_>, _>>()
            .expect("indexes should collect");
        assert!(indexes
            .iter()
            .any(|name| name == "idx_task_comments_parent_comment_id"));
        assert!(indexes
            .iter()
            .any(|name| name == "idx_task_comments_anchor"));
    }

    #[test]
    fn migrates_legacy_session_catalog_rows_into_sessions_without_relying_on_column_defaults() {
        let path = unique_temp_db("sessions-catalog-backfill");
        let parent = path.parent().expect("temp database should have a parent");
        fs::create_dir_all(parent).expect("parent directory should exist");

        let connection = Connection::open(&path).expect("legacy database should open");
        connection
            .execute_batch(
                r#"
                CREATE TABLE projects (
                    id TEXT PRIMARY KEY,
                    slug TEXT NOT NULL UNIQUE,
                    name TEXT NOT NULL,
                    description TEXT,
                    task_prefix TEXT NOT NULL,
                    default_repository_id TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at)
                VALUES ('project-1', 'legacy-migration-proj', 'Legacy Migration Project', NULL, 'LEG', NULL, '2026-03-18T00:00:00Z', '2026-03-18T00:00:00Z');

                CREATE TABLE session_catalog (
                    session_id TEXT PRIMARY KEY,
                    project_slug TEXT NOT NULL,
                    session_path TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    title TEXT NOT NULL,
                    status TEXT NOT NULL,
                    file_size INTEGER NOT NULL,
                    file_mtime_ms INTEGER NOT NULL,
                    last_indexed_at TEXT NOT NULL
                );

                INSERT INTO session_catalog (
                    session_id, project_slug, session_path, created_at, updated_at, title, status, file_size, file_mtime_ms, last_indexed_at
                ) VALUES (
                    'session-1', 'legacy-migration-proj', '/tmp/session-1.jsonl', '2026-03-18T00:00:01Z', '2026-03-18T00:00:02Z', 'Legacy Session', 'closed', 42, 1234, '2026-03-18T00:00:02Z'
                );

                CREATE TABLE sessions (
                    id TEXT PRIMARY KEY,
                    project_id TEXT,
                    session_path TEXT NOT NULL DEFAULT '' UNIQUE,
                    transcript_path TEXT,
                    title TEXT NOT NULL,
                    session_kind TEXT NOT NULL,
                    session_status TEXT NOT NULL,
                    list_visibility TEXT NOT NULL,
                    first_seen_at TEXT NOT NULL,
                    last_seen_at TEXT NOT NULL,
                    transcript_exists INTEGER NOT NULL,
                    file_size INTEGER,
                    file_mtime_ms INTEGER,
                    last_indexed_at TEXT,
                    lifecycle_state TEXT NOT NULL DEFAULT 'active',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                "#,
            )
            .expect("legacy session tables should seed");
        drop(connection);

        initialize_database_at(&path).expect("database migration should succeed");
        let connection = Connection::open(&path).expect("migrated database should open");

        let row = connection
            .query_row(
                "SELECT project_id, transcript_path, session_status, list_visibility, first_seen_at, last_seen_at, transcript_exists, file_size, file_mtime_ms, last_indexed_at, lifecycle_state FROM sessions WHERE id = 'session-1'",
                [],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, i64>(6)?,
                        row.get::<_, Option<i64>>(7)?,
                        row.get::<_, Option<i64>>(8)?,
                        row.get::<_, Option<String>>(9)?,
                        row.get::<_, String>(10)?,
                    ))
                },
            )
            .expect("backfilled session should load");

        assert_eq!(
            row,
            (
                Some("project-1".into()),
                Some("/tmp/session-1.jsonl".into()),
                "closed".into(),
                "closed".into(),
                "2026-03-18T00:00:01Z".into(),
                "2026-03-18T00:00:02Z".into(),
                0,
                Some(42),
                Some(1234),
                Some("2026-03-18T00:00:02Z".into()),
                "closed".into(),
            )
        );
    }

    #[test]
    fn initializes_database_when_legacy_canonical_session_owns_the_wrong_transcript_path() {
        let _guard = crate::test_support::global_test_env_lock()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let previous_root = env::var_os("ORCHESTRA_STORAGE_ROOT");
        let storage_root = env::temp_dir().join(format!(
            "sessions-path-collision-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time should move forward")
                .as_millis()
        ));
        fs::create_dir_all(&storage_root).expect("temp storage root should exist");
        unsafe {
            env::set_var("ORCHESTRA_STORAGE_ROOT", &storage_root);
        }

        let path = unique_temp_db("sessions-path-collision-upgrade");
        let parent = path.parent().expect("temp database should have a parent");
        fs::create_dir_all(parent).expect("parent directory should exist");
        let transcript_path = parent.join("2026-04-30T00-00-00Z_session-owner.jsonl");
        write_legacy_session_file(&transcript_path, "session-owner", "Canonical owner");

        let result = (|| {
            let connection = Connection::open(&path).expect("legacy database should open");
            connection
                .execute_batch(
                    &format!(
                        r#"
                        CREATE TABLE projects (
                            id TEXT PRIMARY KEY,
                            slug TEXT NOT NULL UNIQUE,
                            name TEXT NOT NULL,
                            description TEXT,
                            task_prefix TEXT NOT NULL,
                            default_repository_id TEXT,
                            created_at TEXT NOT NULL,
                            updated_at TEXT NOT NULL
                        );

                        INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at)
                        VALUES ('project-1', 'legacy-migration-proj', 'Legacy Migration Project', NULL, 'LEG', NULL, '2026-03-18T00:00:00Z', '2026-03-18T00:00:00Z');

                        CREATE TABLE session_catalog (
                            session_id TEXT PRIMARY KEY,
                            project_slug TEXT NOT NULL,
                            session_path TEXT NOT NULL,
                            created_at TEXT NOT NULL,
                            updated_at TEXT NOT NULL,
                            title TEXT NOT NULL,
                            status TEXT NOT NULL,
                            file_size INTEGER NOT NULL,
                            file_mtime_ms INTEGER NOT NULL,
                            last_indexed_at TEXT NOT NULL
                        );

                        INSERT INTO session_catalog (
                            session_id, project_slug, session_path, created_at, updated_at, title, status, file_size, file_mtime_ms, last_indexed_at
                        ) VALUES (
                            'session-stale', 'legacy-migration-proj', '{session_path}', '2026-03-18T00:00:01Z', '2026-03-18T00:00:02Z', 'Stale owner', 'active', 42, 1234, '2026-03-18T00:00:02Z'
                        );

                        CREATE TABLE sessions (
                            id TEXT PRIMARY KEY,
                            project_id TEXT,
                            session_path TEXT NOT NULL DEFAULT '' UNIQUE,
                            transcript_path TEXT,
                            title TEXT NOT NULL,
                            session_kind TEXT NOT NULL,
                            session_status TEXT NOT NULL,
                            list_visibility TEXT NOT NULL,
                            first_seen_at TEXT NOT NULL,
                            last_seen_at TEXT NOT NULL,
                            transcript_exists INTEGER NOT NULL,
                            file_size INTEGER,
                            file_mtime_ms INTEGER,
                            last_indexed_at TEXT,
                            lifecycle_state TEXT NOT NULL DEFAULT 'active',
                            created_at TEXT NOT NULL,
                            updated_at TEXT NOT NULL
                        );

                        INSERT INTO sessions (
                            id, project_id, session_path, transcript_path, title, session_kind, session_status, list_visibility,
                            first_seen_at, last_seen_at, transcript_exists, file_size, file_mtime_ms, last_indexed_at, lifecycle_state,
                            created_at, updated_at
                        ) VALUES (
                            'session-stale', 'project-1', '{session_path}', '{session_path}', 'Stale owner', 'standalone', 'active', 'active',
                            '2026-03-18T00:00:01Z', '2026-03-18T00:00:02Z', 1, 42, 1234, '2026-03-18T00:00:02Z', 'active',
                            '2026-03-18T00:00:01Z', '2026-03-18T00:00:02Z'
                        );
                        "#,
                        session_path = transcript_path.display(),
                    ),
                )
                .expect("legacy session tables should seed");
            drop(connection);

            initialize_database_at(&path).expect("database migration should succeed");
            let connection = Connection::open(&path).expect("migrated database should open");

            let owner_row: (String, String, i64) = connection
                .query_row(
                    "SELECT session_path, transcript_path, transcript_exists FROM sessions WHERE id = 'session-owner'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .expect("owner row should load");
            assert_eq!(owner_row.0, transcript_path.display().to_string());
            assert_eq!(owner_row.1, transcript_path.display().to_string());
            assert_eq!(owner_row.2, 1);

            let stale_row: (String, Option<String>, i64) = connection
                .query_row(
                    "SELECT session_path, transcript_path, transcript_exists FROM sessions WHERE id = 'session-stale'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .expect("stale row should load");
            assert_eq!(stale_row.0, "missing://session-stale");
            assert!(stale_row.1.is_none());
            assert_eq!(stale_row.2, 0);
        })();

        match previous_root {
            Some(value) => unsafe { env::set_var("ORCHESTRA_STORAGE_ROOT", value) },
            None => unsafe { env::remove_var("ORCHESTRA_STORAGE_ROOT") },
        }
        let _ = fs::remove_dir_all(&storage_root);
        result
    }

    #[test]
    fn migrates_legacy_roles_table_and_backfills_unique_slugs() {
        let path = unique_temp_db("roles-migration");
        let parent = path.parent().expect("temp database should have a parent");
        fs::create_dir_all(parent).expect("parent directory should exist");

        let connection = Connection::open(&path).expect("legacy database should open");
        connection
            .execute_batch(
                r#"
                CREATE TABLE roles (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    archived INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                INSERT INTO roles (id, name, archived, created_at, updated_at)
                VALUES
                    ('role-1', 'Reviewer', 0, '2026-03-18T00:00:00Z', '2026-03-18T00:00:00Z'),
                    ('role-2', 'Reviewer', 0, '2026-03-18T00:00:01Z', '2026-03-18T00:00:01Z');
                "#,
            )
            .expect("legacy roles table should seed");
        drop(connection);

        initialize_database_at(&path).expect("database migration should succeed");
        let connection = Connection::open(&path).expect("migrated database should open");

        let rows = connection
            .prepare("SELECT id, slug, thinking_level, capacity FROM roles ORDER BY id ASC")
            .expect("role query should prepare")
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })
            .expect("role query should execute")
            .collect::<Result<Vec<_>, _>>()
            .expect("role rows should collect");

        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows[0],
            ("role-1".into(), "reviewer".into(), "off".into(), 1)
        );
        assert_eq!(
            rows[1],
            ("role-2".into(), "reviewer-2".into(), "off".into(), 1)
        );
    }
}
