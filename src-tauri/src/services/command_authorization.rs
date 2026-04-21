use crate::{
    models::{AuthorizationContext, OrchestraToolDefinition, ResolvedPermissions},
    services::authorization,
};
use rusqlite::Connection;

const ORCHESTRA_TOOLS: &[(&str, &str, &str)] = &[
    ("list_agents", "List Orchestra agents", "agents.read"),
    ("get_agent", "Get an Orchestra agent", "agents.read"),
    (
        "get_agent_memory_info",
        "Inspect agent memory bootstrap paths",
        "agents.read",
    ),
    ("create_agent", "Create an Orchestra agent", "agents.create"),
    ("update_agent", "Update an Orchestra agent", "agents.update"),
    (
        "archive_agent",
        "Archive an Orchestra agent",
        "agents.archive",
    ),
    ("list_roles", "List Orchestra roles", "roles.read"),
    ("get_role", "Get an Orchestra role", "roles.read"),
    ("create_role", "Create an Orchestra role", "roles.create"),
    ("update_role", "Update an Orchestra role", "roles.update"),
    ("archive_role", "Archive an Orchestra role", "roles.archive"),
    (
        "list_role_operations",
        "Inspect role queues and instances",
        "roles.read",
    ),
    (
        "get_role_operations",
        "Inspect a role queue and instances",
        "roles.read",
    ),
    ("enqueue_role_work", "Queue role work", "roles.enqueue"),
    (
        "dispatch_role_queue",
        "Dispatch queued role work",
        "roles.dispatch",
    ),
    (
        "release_role_instance",
        "Release a role instance",
        "roles.release",
    ),
    (
        "dispose_role_instance",
        "Dispose a role instance",
        "roles.dispose",
    ),
    ("list_workflows", "List workflows", "workflows.read"),
    ("get_workflow", "Get a workflow", "workflows.read"),
    (
        "validate_workflow",
        "Validate a workflow definition",
        "workflows.read",
    ),
    ("create_workflow", "Create a workflow", "workflows.create"),
    ("update_workflow", "Update a workflow", "workflows.update"),
    (
        "add_workflow_lane",
        "Add a lane to a workflow",
        "workflows.update",
    ),
    (
        "update_workflow_lane",
        "Update a workflow lane",
        "workflows.update",
    ),
    (
        "delete_workflow_lane",
        "Delete a workflow lane",
        "workflows.update",
    ),
    (
        "reorder_workflow_lanes",
        "Reorder workflow lanes",
        "workflows.update",
    ),
    (
        "duplicate_workflow",
        "Duplicate a workflow",
        "workflows.create",
    ),
    (
        "archive_workflow",
        "Archive a workflow",
        "workflows.archive",
    ),
    ("list_policies", "List policies", "policies.read"),
    ("get_policy", "Get a policy", "policies.read"),
    (
        "get_agent_permissions",
        "Resolve effective permissions for an agent",
        "policies.read",
    ),
    (
        "get_role_permissions",
        "Resolve effective permissions for a role",
        "policies.read",
    ),
    (
        "get_role_instance_permissions",
        "Resolve effective permissions for a role instance",
        "policies.read",
    ),
    ("list_sessions", "List sessions", "sessions.read"),
    ("create_session", "Create a session", "sessions.create"),
    ("resume_session", "Resume a session", "sessions.read"),
    (
        "subscribe_session",
        "Subscribe to a session",
        "sessions.read",
    ),
    (
        "unsubscribe_session",
        "Unsubscribe from a session",
        "sessions.read",
    ),
    ("delete_session", "Delete a session", "sessions.delete"),
    (
        "send_session_message",
        "Send a message to a session",
        "sessions.message",
    ),
    (
        "stop_session_runtime",
        "Stop an active Orchestra session runtime",
        "sessions.stop",
    ),
    (
        "get_session_model_state",
        "Inspect a session model",
        "sessions.read",
    ),
    (
        "set_session_model",
        "Change a session model",
        "sessions.model",
    ),
    ("list_projects", "List Orchestra projects", "projects.read"),
    ("get_project", "Get an Orchestra project", "projects.read"),
    (
        "create_project",
        "Create an Orchestra project",
        "projects.create",
    ),
    (
        "update_project",
        "Update an Orchestra project",
        "projects.update",
    ),
    (
        "delete_project",
        "Delete an Orchestra project",
        "projects.delete",
    ),
    (
        "list_repositories",
        "List Orchestra repositories",
        "projects.read",
    ),
    (
        "get_repository",
        "Get an Orchestra repository",
        "projects.read",
    ),
    (
        "create_repository",
        "Create an Orchestra repository",
        "repositories.write",
    ),
    (
        "update_repository",
        "Update an Orchestra repository",
        "repositories.write",
    ),
    (
        "delete_repository",
        "Delete an Orchestra repository",
        "repositories.write",
    ),
    (
        "attach_repository_remote",
        "Attach or update a repository remote",
        "repositories.write",
    ),
    (
        "set_project_default_repository",
        "Set the default repository for a project",
        "projects.update",
    ),
    ("list_tasks", "List tasks", "tasks.read"),
    ("get_task", "Get a task", "tasks.read"),
    (
        "get_task_context",
        "Get a task with hierarchy, dependencies, attachments, file references, and lane context",
        "tasks.read",
    ),
    (
        "list_task_comments",
        "List task comments with reply threading metadata",
        "tasks.read",
    ),
    ("list_task_todos", "List task todo items", "tasks.read"),
    (
        "list_unfinished_task_todos",
        "List unfinished task todo items",
        "tasks.read",
    ),
    (
        "get_unread_task_comments",
        "Get unread task comments for the active lane session",
        "tasks.read",
    ),
    (
        "mark_task_comments_read",
        "Acknowledge task comments as read for the active lane session",
        "tasks.comment",
    ),
    (
        "get_unread_mail",
        "Get unread mailbox messages for the current worker session",
        "tasks.read",
    ),
    (
        "mark_mail_read",
        "Acknowledge mailbox messages as read for the current worker session",
        "tasks.comment",
    ),
    (
        "send_mail",
        "Send a mailbox message to the user, an agent, or an active assignment mailbox",
        "tasks.comment",
    ),
    (
        "remind_me",
        "Schedule a self-reminder message for the current worker session",
        "tasks.read",
    ),
    (
        "list_task_repositories",
        "List task repositories and their workspace paths",
        "tasks.read",
    ),
    (
        "list_task_file_references",
        "List task project file references",
        "tasks.read",
    ),
    (
        "add_task_file_reference",
        "Add a task project file reference",
        "tasks.update",
    ),
    (
        "remove_task_file_reference",
        "Remove a task project file reference",
        "tasks.update",
    ),
    ("create_task", "Create a task", "tasks.create"),
    ("create_subtask", "Create a subtask", "tasks.create"),
    ("add_task_todo", "Add a task todo item", "tasks.update"),
    (
        "mark_task_todo_finished",
        "Mark a task todo item finished",
        "tasks.update",
    ),
    (
        "mark_task_todo_unfinished",
        "Mark a task todo item unfinished",
        "tasks.update",
    ),
    (
        "delete_task_todo",
        "Delete a task todo item",
        "tasks.update",
    ),
    ("update_task", "Update a task", "tasks.update"),
    ("delete_task", "Delete a task", "tasks.delete"),
    ("comment_on_task", "Comment on a task", "tasks.comment"),
    (
        "dispatch_task_lane",
        "Dispatch the current task lane",
        "tasks.transition",
    ),
    (
        "complete_lane_as_success",
        "Complete the active lane as success",
        "tasks.transition",
    ),
    (
        "complete_lane_as_failure",
        "Complete the active lane as failure",
        "tasks.transition",
    ),
    (
        "request_user_intervention",
        "Request user intervention for the active lane",
        "tasks.transition",
    ),
    (
        "approve_task_review",
        "Approve a task lane paused for user review",
        "tasks.review",
    ),
    (
        "mark_task_needs_work",
        "Send a review-paused task lane back for more work",
        "tasks.review",
    ),
    (
        "resume_task_lane",
        "Resume a user-paused or intervention-paused task lane",
        "tasks.control",
    ),
    (
        "pause_task_lane",
        "Pause active or queued task lane work under user authority",
        "tasks.control",
    ),
    (
        "stop_task_activity",
        "Stop active or queued task work and return the task to a ready state",
        "tasks.control",
    ),
    (
        "reassign_task_to_lane",
        "Move a task into a specific workflow lane",
        "tasks.transition",
    ),
    (
        "add_task_dependency",
        "Add a task dependency",
        "tasks.dependencies.write",
    ),
    (
        "remove_task_dependency",
        "Remove a task dependency",
        "tasks.dependencies.write",
    ),
    (
        "add_task_attachment",
        "Add a task attachment",
        "tasks.attachments.write",
    ),
    (
        "remove_task_attachment",
        "Remove a task attachment",
        "tasks.attachments.write",
    ),
    (
        "get_worker_overlay",
        "Read project worker overlay settings",
        "projects.read",
    ),
    (
        "update_worker_overlay",
        "Update project worker overlay settings",
        "projects.update",
    ),
    ("get_logs", "Read Orchestra logs", "logs.read"),
    ("clear_logs", "Clear Orchestra logs", "logs.clear"),
];

pub fn require_permission(
    connection: &Connection,
    authorization_context: Option<&AuthorizationContext>,
    permission: &str,
) -> Result<(), String> {
    let Some(context) = authorization_context else {
        return Ok(());
    };

    let resolved = resolve_permissions(connection, context)?;
    if authorization::has_permission(&resolved, permission) {
        Ok(())
    } else {
        Err(format!(
            "Actor {}:{} does not have required permission {}",
            context.actor_type, context.actor_id, permission
        ))
    }
}

pub fn list_allowed_tools(
    connection: &Connection,
    authorization_context: Option<&AuthorizationContext>,
) -> Result<Vec<OrchestraToolDefinition>, String> {
    let resolved = authorization_context
        .map(|context| resolve_permissions(connection, context))
        .transpose()?;

    Ok(ORCHESTRA_TOOLS
        .iter()
        .filter(|(_, _, permission)| {
            resolved
                .as_ref()
                .map(|resolved| authorization::has_permission(resolved, permission))
                .unwrap_or(true)
        })
        .map(
            |(name, description, required_permission)| OrchestraToolDefinition {
                name: (*name).into(),
                description: (*description).into(),
                required_permission: (*required_permission).into(),
            },
        )
        .collect())
}

fn resolve_permissions(
    connection: &Connection,
    context: &AuthorizationContext,
) -> Result<ResolvedPermissions, String> {
    match context.actor_type.as_str() {
        "agent" => authorization::resolve_agent_permissions(connection, &context.actor_id),
        "role" => authorization::resolve_role_permissions(connection, &context.actor_id),
        "role_instance" => {
            authorization::resolve_role_instance_permissions(connection, &context.actor_id)
        }
        "user" => Ok(ResolvedPermissions {
            actor_type: context.actor_type.clone(),
            actor_id: context.actor_id.clone(),
            inherited_role_id: None,
            policy_ids: Vec::new(),
            permissions: vec!["*".into()],
            grants_full_access: true,
        }),
        other => Err(format!("Unsupported authorization actor type: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::{database::initialize_database_at, policies, roles};
    use chrono::Utc;
    use rusqlite::{params, Connection};
    use std::{
        env,
        path::PathBuf,
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

    fn open_test_connection(label: &str) -> Connection {
        let path = unique_temp_db(label);
        initialize_database_at(&path).expect("database should initialize");
        Connection::open(path).expect("database should open")
    }

    fn now_iso() -> String {
        Utc::now().to_rfc3339()
    }

    #[test]
    fn filters_tool_manifest_by_permissions() {
        let mut connection = open_test_connection("command-auth-tools");
        let worker_policy = policies::create_policy(
            &mut connection,
            "worker",
            "Worker",
            None,
            &["agents.read".into(), "sessions.read".into()],
            false,
            false,
        )
        .expect("policy should create");
        let role = roles::create_role(
            &mut connection,
            crate::models::RoleUpsertInput {
                name: "Worker".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                thinking_level: Some("off".into()),
                capacity: 1,
                policy_ids: vec![worker_policy.id.clone()],
                direct_permissions: Vec::new(),
            },
        )
        .expect("role should create");
        connection
            .execute(
                "INSERT INTO agents (id, slug, name, description, system_prompt, provider, model, role_id, thinking_level, direct_permissions, system, immutable, archived, created_at, updated_at) VALUES ('agent-1', 'agent-1', 'Agent 1', NULL, NULL, NULL, NULL, ?1, 'off', '[]', 0, 0, 0, ?2, ?2)",
                params![role.id, now_iso()],
            )
            .expect("agent should seed");

        let tools = list_allowed_tools(
            &connection,
            Some(&AuthorizationContext {
                actor_type: "agent".into(),
                actor_id: "agent-1".into(),
            }),
        )
        .expect("tools should list");

        assert!(tools.iter().any(|tool| tool.name == "list_agents"));
        assert!(tools.iter().any(|tool| tool.name == "list_sessions"));
        assert!(!tools.iter().any(|tool| tool.name == "create_role"));
    }

    #[test]
    fn splits_review_control_and_session_stop_tools_from_task_transition() {
        let mut connection = open_test_connection("command-auth-review-control");
        let transition_role = roles::create_role(
            &mut connection,
            crate::models::RoleUpsertInput {
                name: "Transition Only".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                thinking_level: Some("off".into()),
                capacity: 1,
                policy_ids: Vec::new(),
                direct_permissions: vec!["tasks.transition".into()],
            },
        )
        .expect("transition role should create");
        let review_role = roles::create_role(
            &mut connection,
            crate::models::RoleUpsertInput {
                name: "Review Control".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                thinking_level: Some("off".into()),
                capacity: 1,
                policy_ids: Vec::new(),
                direct_permissions: vec![
                    "tasks.review".into(),
                    "tasks.control".into(),
                    "sessions.stop".into(),
                ],
            },
        )
        .expect("review role should create");

        let transition_tools = list_allowed_tools(
            &connection,
            Some(&AuthorizationContext {
                actor_type: "role".into(),
                actor_id: transition_role.id,
            }),
        )
        .expect("transition tools should list");
        assert!(transition_tools
            .iter()
            .any(|tool| tool.name == "complete_lane_as_success"));
        assert!(!transition_tools
            .iter()
            .any(|tool| tool.name == "approve_task_review"));
        assert!(!transition_tools
            .iter()
            .any(|tool| tool.name == "pause_task_lane"));

        let review_tools = list_allowed_tools(
            &connection,
            Some(&AuthorizationContext {
                actor_type: "role".into(),
                actor_id: review_role.id,
            }),
        )
        .expect("review tools should list");
        assert!(review_tools
            .iter()
            .any(|tool| tool.name == "approve_task_review"));
        assert!(review_tools
            .iter()
            .any(|tool| tool.name == "mark_task_needs_work"));
        assert!(review_tools
            .iter()
            .any(|tool| tool.name == "resume_task_lane"));
        assert!(review_tools
            .iter()
            .any(|tool| tool.name == "pause_task_lane"));
        assert!(review_tools
            .iter()
            .any(|tool| tool.name == "stop_task_activity"));
        assert!(review_tools
            .iter()
            .any(|tool| tool.name == "stop_session_runtime"));
        assert!(!review_tools
            .iter()
            .any(|tool| tool.name == "complete_lane_as_success"));
    }

    #[test]
    fn requires_permission_for_authorized_actors() {
        let mut connection = open_test_connection("command-auth-require");
        let reviewer_policy = policies::create_policy(
            &mut connection,
            "reviewer",
            "Reviewer",
            None,
            &["roles.read".into()],
            false,
            false,
        )
        .expect("policy should create");
        let role = roles::create_role(
            &mut connection,
            crate::models::RoleUpsertInput {
                name: "Reviewer".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                thinking_level: Some("off".into()),
                capacity: 1,
                policy_ids: vec![reviewer_policy.id],
                direct_permissions: Vec::new(),
            },
        )
        .expect("role should create");

        require_permission(
            &connection,
            Some(&AuthorizationContext {
                actor_type: "role".into(),
                actor_id: role.id.clone(),
            }),
            "roles.read",
        )
        .expect("roles.read should be allowed");

        let error = require_permission(
            &connection,
            Some(&AuthorizationContext {
                actor_type: "role".into(),
                actor_id: role.id,
            }),
            "roles.update",
        )
        .expect_err("roles.update should be denied");
        assert!(error.contains("roles.update"));
    }
}
