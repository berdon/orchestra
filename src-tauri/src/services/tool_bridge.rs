use std::{io::Read, sync::Arc, thread};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tiny_http::{Method, Response, Server, StatusCode};
use uuid::Uuid;

use crate::{
    models::{
        AuthorizationContext, OrchestraToolDefinition, RoleQueueEntryInput, TaskAttachmentInput,
        TaskCommentInput, TaskLaneAssignment, TaskUpsertInput,
    },
    services::{
        agents, authorization, command_authorization, database, pi_sessions, policies,
        project_settings, role_dispatch, role_runtime, roles, task_attachments, task_file_references, tasks,
        workflows,
    },
};

#[derive(Debug, Clone)]
pub struct ToolBridgeConfig {
    pub url: String,
    pub token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolBridgeRequest {
    token: String,
    command: String,
    #[serde(default)]
    authorization: Option<AuthorizationContext>,
    #[serde(default)]
    payload: Value,
}

const BRIDGE_SUPPORTED_COMMANDS: &[&str] = &[
    "list_orchestra_tools",
    "list_agents",
    "get_agent",
    "get_agent_memory_info",
    "create_agent",
    "update_agent",
    "archive_agent",
    "list_roles",
    "get_role",
    "create_role",
    "update_role",
    "archive_role",
    "list_role_operations",
    "get_role_operations",
    "enqueue_role_work",
    "list_tasks",
    "get_task",
    "get_task_context",
    "create_task",
    "create_subtask",
    "update_task",
    "comment_on_task",
    "dispatch_task_lane",
    "complete_lane_as_success",
    "complete_lane_as_failure",
    "request_user_intervention",
    "add_task_dependency",
    "remove_task_dependency",
    "add_task_attachment",
    "remove_task_attachment",
    "list_workflows",
    "get_workflow",
    "create_workflow",
    "update_workflow",
    "duplicate_workflow",
    "archive_workflow",
    "list_policies",
    "get_policy",
    "get_agent_permissions",
    "get_role_permissions",
    "get_role_instance_permissions",
    "get_worker_overlay",
    "update_worker_overlay",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolBridgeResponse {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

pub fn start_tool_bridge() -> Result<Arc<ToolBridgeConfig>, String> {
    let server = Server::http("127.0.0.1:0")
        .map_err(|error| format!("Unable to start Orchestra tool bridge server: {error}"))?;
    let address = server
        .server_addr()
        .to_ip()
        .ok_or_else(|| "Unable to resolve Orchestra tool bridge address".to_string())?;
    let url = format!("http://{}", address);
    let token = format!("bridge-{}", Uuid::new_v4().simple());
    let config = Arc::new(ToolBridgeConfig { url, token });
    let thread_config = Arc::clone(&config);

    thread::spawn(move || {
        for mut request in server.incoming_requests() {
            let response = handle_request(&thread_config, &mut request).unwrap_or_else(|error| {
                ToolBridgeResponse {
                    success: false,
                    data: None,
                    error: Some(error),
                }
            });
            let status = if response.success {
                StatusCode(200)
            } else {
                StatusCode(400)
            };
            let _ = request.respond(
                Response::from_string(serde_json::to_string(&response).unwrap_or_else(|_| {
                    "{\"success\":false,\"error\":\"serialization failed\"}".into()
                }))
                .with_status_code(status),
            );
        }
    });

    Ok(config)
}

fn handle_request(
    config: &ToolBridgeConfig,
    request: &mut tiny_http::Request,
) -> Result<ToolBridgeResponse, String> {
    if request.method() != &Method::Post || request.url() != "/invoke" {
        return Ok(ToolBridgeResponse {
            success: false,
            data: None,
            error: Some("Unsupported route".into()),
        });
    }

    let mut body = String::new();
    request
        .as_reader()
        .read_to_string(&mut body)
        .map_err(|error| format!("Unable to read tool bridge request: {error}"))?;
    let request = serde_json::from_str::<ToolBridgeRequest>(&body)
        .map_err(|error| format!("Unable to parse tool bridge request: {error}"))?;

    if request.token != config.token {
        return Ok(ToolBridgeResponse {
            success: false,
            data: None,
            error: Some("Invalid Orchestra bridge token".into()),
        });
    }

    let connection = database::open_connection()?;
    let data = invoke_bridge_command(
        &connection,
        &request.command,
        request.authorization.as_ref(),
        request.payload,
    )?;

    Ok(ToolBridgeResponse {
        success: true,
        data: Some(data),
        error: None,
    })
}

pub fn list_bridge_tools(
    connection: &Connection,
    authorization: Option<&AuthorizationContext>,
) -> Result<Vec<OrchestraToolDefinition>, String> {
    Ok(command_authorization::list_allowed_tools(connection, authorization)?
        .into_iter()
        .filter(|tool| BRIDGE_SUPPORTED_COMMANDS.contains(&tool.name.as_str()))
        .collect())
}

fn invoke_bridge_command(
    connection: &Connection,
    command: &str,
    authorization: Option<&AuthorizationContext>,
    payload: Value,
) -> Result<Value, String> {
    match command {
        "list_orchestra_tools" => {
            let tools = list_bridge_tools(connection, authorization)?;
            serde_json::to_value(tools)
                .map_err(|error| format!("Unable to serialize tools: {error}"))
        }
        "list_agents" => {
            let include_archived = payload
                .get("includeArchived")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            command_authorization::require_permission(connection, authorization, "agents.read")?;
            serde_json::to_value(agents::list_agents(connection, include_archived)?)
                .map_err(|error| format!("Unable to serialize agents: {error}"))
        }
        "get_agent" => {
            let agent_id = require_string(&payload, "agentId")?;
            command_authorization::require_permission(connection, authorization, "agents.read")?;
            serde_json::to_value(agents::get_agent(connection, &agent_id)?)
                .map_err(|error| format!("Unable to serialize agent: {error}"))
        }
        "get_agent_memory_info" => {
            let agent_id = require_string(&payload, "agentId")?;
            command_authorization::require_permission(connection, authorization, "agents.read")?;
            serde_json::to_value(agents::get_agent_memory_info(connection, &agent_id)?)
                .map_err(|error| format!("Unable to serialize agent memory info: {error}"))
        }
        "create_agent" => {
            command_authorization::require_permission(connection, authorization, "agents.create")?;
            let input =
                serde_json::from_value(payload.get("input").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("Unable to parse agent input: {error}"))?;
            let mut writable = database::open_connection()?;
            serde_json::to_value(agents::create_agent(&mut writable, input)?)
                .map_err(|error| format!("Unable to serialize agent: {error}"))
        }
        "update_agent" => {
            let agent_id = require_string(&payload, "agentId")?;
            command_authorization::require_permission(connection, authorization, "agents.update")?;
            let input =
                serde_json::from_value(payload.get("input").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("Unable to parse agent input: {error}"))?;
            let mut writable = database::open_connection()?;
            serde_json::to_value(agents::update_agent(&mut writable, &agent_id, input)?)
                .map_err(|error| format!("Unable to serialize agent: {error}"))
        }
        "archive_agent" => {
            let agent_id = require_string(&payload, "agentId")?;
            command_authorization::require_permission(connection, authorization, "agents.archive")?;
            let writable = database::open_connection()?;
            serde_json::to_value(agents::archive_agent(&writable, &agent_id)?)
                .map_err(|error| format!("Unable to serialize agent: {error}"))
        }
        "list_roles" => {
            let include_archived = payload
                .get("includeArchived")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            command_authorization::require_permission(connection, authorization, "roles.read")?;
            serde_json::to_value(roles::list_roles(connection, include_archived)?)
                .map_err(|error| format!("Unable to serialize roles: {error}"))
        }
        "get_role" => {
            let role_id = require_string(&payload, "roleId")?;
            command_authorization::require_permission(connection, authorization, "roles.read")?;
            serde_json::to_value(roles::get_role(connection, &role_id)?)
                .map_err(|error| format!("Unable to serialize role: {error}"))
        }
        "create_role" => {
            command_authorization::require_permission(connection, authorization, "roles.create")?;
            let input =
                serde_json::from_value(payload.get("input").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("Unable to parse role input: {error}"))?;
            let mut writable = database::open_connection()?;
            serde_json::to_value(roles::create_role(&mut writable, input)?)
                .map_err(|error| format!("Unable to serialize role: {error}"))
        }
        "update_role" => {
            let role_id = require_string(&payload, "roleId")?;
            command_authorization::require_permission(connection, authorization, "roles.update")?;
            let input =
                serde_json::from_value(payload.get("input").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("Unable to parse role input: {error}"))?;
            let mut writable = database::open_connection()?;
            serde_json::to_value(roles::update_role(&mut writable, &role_id, input)?)
                .map_err(|error| format!("Unable to serialize role: {error}"))
        }
        "archive_role" => {
            let role_id = require_string(&payload, "roleId")?;
            command_authorization::require_permission(connection, authorization, "roles.archive")?;
            let writable = database::open_connection()?;
            serde_json::to_value(roles::archive_role(&writable, &role_id)?)
                .map_err(|error| format!("Unable to serialize role: {error}"))
        }
        "list_role_operations" => {
            let include_archived = payload
                .get("includeArchived")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            command_authorization::require_permission(connection, authorization, "roles.read")?;
            serde_json::to_value(role_runtime::list_role_operations(
                connection,
                include_archived,
            )?)
            .map_err(|error| format!("Unable to serialize role operations: {error}"))
        }
        "get_role_operations" => {
            let role_id = require_string(&payload, "roleId")?;
            command_authorization::require_permission(connection, authorization, "roles.read")?;
            serde_json::to_value(role_runtime::get_role_operations(connection, &role_id)?)
                .map_err(|error| format!("Unable to serialize role operations: {error}"))
        }
        "enqueue_role_work" => {
            command_authorization::require_permission(connection, authorization, "roles.enqueue")?;
            let input: RoleQueueEntryInput =
                serde_json::from_value(payload.get("input").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("Unable to parse role queue input: {error}"))?;
            let mut writable = database::open_connection()?;
            serde_json::to_value(role_runtime::enqueue_role_work(&mut writable, input)?)
                .map_err(|error| format!("Unable to serialize role queue entry: {error}"))
        }
        "list_tasks" => {
            let include_archived = payload
                .get("includeArchived")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            command_authorization::require_permission(connection, authorization, "tasks.read")?;
            let project_id = payload
                .get("projectId")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("orchestra");
            serde_json::to_value(tasks::list_tasks(connection, project_id, include_archived)?)
                .map_err(|error| format!("Unable to serialize tasks: {error}"))
        }
        "get_task" | "get_task_context" => {
            let task_id = require_string(&payload, "taskId")?;
            command_authorization::require_permission(connection, authorization, "tasks.read")?;
            serde_json::to_value(tasks::get_task_context(connection, &task_id)?)
                .map_err(|error| format!("Unable to serialize task context: {error}"))
        }
        "create_task" => {
            command_authorization::require_permission(connection, authorization, "tasks.create")?;
            let input: TaskUpsertInput =
                serde_json::from_value(payload.get("input").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("Unable to parse task input: {error}"))?;
            let project_id = payload
                .get("projectId")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(str::to_string);
            let mut writable = database::open_connection()?;
            serde_json::to_value(tasks::create_task(&mut writable, project_id.as_deref(), input)?)
                .map_err(|error| format!("Unable to serialize task: {error}"))
        }
        "create_subtask" => {
            let parent_task_id = require_string(&payload, "parentTaskId")?;
            command_authorization::require_permission(connection, authorization, "tasks.create")?;
            let input: TaskUpsertInput =
                serde_json::from_value(payload.get("input").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("Unable to parse task input: {error}"))?;
            let mut writable = database::open_connection()?;
            serde_json::to_value(tasks::create_subtask(&mut writable, &parent_task_id, input)?)
                .map_err(|error| format!("Unable to serialize task: {error}"))
        }
        "update_task" => {
            let task_id = require_string(&payload, "taskId")?;
            command_authorization::require_permission(connection, authorization, "tasks.update")?;
            let input: TaskUpsertInput =
                serde_json::from_value(payload.get("input").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("Unable to parse task input: {error}"))?;
            let mut writable = database::open_connection()?;
            serde_json::to_value(tasks::update_task(&mut writable, &task_id, input)?)
                .map_err(|error| format!("Unable to serialize task: {error}"))
        }
        "comment_on_task" => {
            let task_id = require_string(&payload, "taskId")?;
            command_authorization::require_permission(connection, authorization, "tasks.comment")?;
            let input: TaskCommentInput =
                serde_json::from_value(payload.get("input").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("Unable to parse task comment input: {error}"))?;
            let mut writable = database::open_connection()?;
            let comment = tasks::add_task_comment(&mut writable, &task_id, input)?;
            serde_json::to_value(comment)
                .map_err(|error| format!("Unable to serialize task comment: {error}"))
        }
        "dispatch_task_lane" => {
            let task_id = require_string(&payload, "taskId")?;
            command_authorization::require_permission(connection, authorization, "tasks.transition")?;
            let context = pi_sessions::detect_session_context(None)?;
            let mut writable = database::open_connection()?;
            let assignment = crate::services::task_runtime::dispatch_task_lane(
                &mut writable,
                &context.project_root,
                &context.session_dir,
                &task_id,
            )?;
            start_assignment_blocking(&context.session_dir, &assignment)?;
            serde_json::to_value(assignment)
                .map_err(|error| format!("Unable to serialize task dispatch assignment: {error}"))
        }
        "complete_lane_as_success" => {
            let task_id = require_string(&payload, "taskId")?;
            let notes = payload.get("notes").and_then(Value::as_str).map(str::to_string);
            command_authorization::require_permission(connection, authorization, "tasks.transition")?;
            let context = pi_sessions::detect_session_context(None)?;
            let mut writable = database::open_connection()?;
            let task = crate::services::task_runtime::complete_lane_as_success(
                &mut writable,
                &context.project_root,
                &context.session_dir,
                &task_id,
                notes,
                authorization,
            )?;
            if let Some(next_assignment) = crate::services::task_runtime::maybe_auto_dispatch_task(
                &mut writable,
                &context.project_root,
                &context.session_dir,
                &task_id,
            )? {
                start_assignment_blocking(&context.session_dir, &next_assignment)?;
            }
            serde_json::to_value(task)
                .map_err(|error| format!("Unable to serialize completed task lane: {error}"))
        }
        "complete_lane_as_failure" => {
            let task_id = require_string(&payload, "taskId")?;
            let notes = payload.get("notes").and_then(Value::as_str).map(str::to_string);
            command_authorization::require_permission(connection, authorization, "tasks.transition")?;
            let context = pi_sessions::detect_session_context(None)?;
            let mut writable = database::open_connection()?;
            let task = crate::services::task_runtime::complete_lane_as_failure(
                &mut writable,
                &context.project_root,
                &context.session_dir,
                &task_id,
                notes,
                authorization,
            )?;
            if let Some(next_assignment) = crate::services::task_runtime::maybe_auto_dispatch_task(
                &mut writable,
                &context.project_root,
                &context.session_dir,
                &task_id,
            )? {
                start_assignment_blocking(&context.session_dir, &next_assignment)?;
            }
            serde_json::to_value(task)
                .map_err(|error| format!("Unable to serialize failed task lane: {error}"))
        }
        "request_user_intervention" => {
            let task_id = require_string(&payload, "taskId")?;
            let notes = payload.get("notes").and_then(Value::as_str).map(str::to_string);
            command_authorization::require_permission(connection, authorization, "tasks.transition")?;
            let context = pi_sessions::detect_session_context(None)?;
            let mut writable = database::open_connection()?;
            let task = crate::services::task_runtime::request_user_intervention(
                &mut writable,
                &context.project_root,
                &context.session_dir,
                &task_id,
                notes,
                authorization,
            )?;
            serde_json::to_value(task)
                .map_err(|error| format!("Unable to serialize user-intervention task lane: {error}"))
        }
        "add_task_dependency" => {
            let blocker_task_id = require_string(&payload, "blockerTaskId")?;
            let blocked_task_id = require_string(&payload, "blockedTaskId")?;
            command_authorization::require_permission(connection, authorization, "tasks.dependencies.write")?;
            let mut writable = database::open_connection()?;
            serde_json::to_value(tasks::add_task_dependency(
                &mut writable,
                &blocker_task_id,
                &blocked_task_id,
            )?)
            .map_err(|error| format!("Unable to serialize task dependency: {error}"))
        }
        "remove_task_dependency" => {
            let dependency_id = require_string(&payload, "dependencyId")?;
            command_authorization::require_permission(connection, authorization, "tasks.dependencies.write")?;
            let writable = database::open_connection()?;
            serde_json::to_value(tasks::remove_task_dependency(&writable, &dependency_id)?)
                .map_err(|error| format!("Unable to serialize removed task dependency: {error}"))
        }
        "add_task_attachment" => {
            let task_id = require_string(&payload, "taskId")?;
            command_authorization::require_permission(connection, authorization, "tasks.attachments.write")?;
            let input: TaskAttachmentInput =
                serde_json::from_value(payload.get("input").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("Unable to parse task attachment input: {error}"))?;
            let mut writable = database::open_connection()?;
            serde_json::to_value(task_attachments::add_task_attachment(&mut writable, &task_id, input)?)
                .map_err(|error| format!("Unable to serialize task attachment: {error}"))
        }
        "remove_task_attachment" => {
            let attachment_id = require_string(&payload, "attachmentId")?;
            command_authorization::require_permission(connection, authorization, "tasks.attachments.write")?;
            let writable = database::open_connection()?;
            serde_json::to_value(task_attachments::remove_task_attachment(&writable, &attachment_id)?)
                .map_err(|error| format!("Unable to serialize removed task attachment: {error}"))
        }
        "list_workflows" => {
            let include_archived = payload
                .get("includeArchived")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            command_authorization::require_permission(connection, authorization, "workflows.read")?;
            serde_json::to_value(workflows::list_workflows(connection, include_archived)?)
                .map_err(|error| format!("Unable to serialize workflows: {error}"))
        }
        "get_workflow" => {
            let workflow_id = require_string(&payload, "workflowId")?;
            command_authorization::require_permission(connection, authorization, "workflows.read")?;
            serde_json::to_value(workflows::get_workflow(connection, &workflow_id)?)
                .map_err(|error| format!("Unable to serialize workflow: {error}"))
        }
        "create_workflow" => {
            command_authorization::require_permission(
                connection,
                authorization,
                "workflows.create",
            )?;
            let input =
                serde_json::from_value(payload.get("input").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("Unable to parse workflow input: {error}"))?;
            let mut writable = database::open_connection()?;
            serde_json::to_value(workflows::create_workflow(&mut writable, input)?)
                .map_err(|error| format!("Unable to serialize workflow: {error}"))
        }
        "update_workflow" => {
            let workflow_id = require_string(&payload, "workflowId")?;
            command_authorization::require_permission(
                connection,
                authorization,
                "workflows.update",
            )?;
            let input =
                serde_json::from_value(payload.get("input").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("Unable to parse workflow input: {error}"))?;
            let mut writable = database::open_connection()?;
            serde_json::to_value(workflows::update_workflow(
                &mut writable,
                &workflow_id,
                input,
            )?)
            .map_err(|error| format!("Unable to serialize workflow: {error}"))
        }
        "duplicate_workflow" => {
            let workflow_id = require_string(&payload, "workflowId")?;
            command_authorization::require_permission(
                connection,
                authorization,
                "workflows.create",
            )?;
            let new_name = payload
                .get("newName")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            let mut writable = database::open_connection()?;
            serde_json::to_value(workflows::duplicate_workflow(
                &mut writable,
                &workflow_id,
                new_name,
            )?)
            .map_err(|error| format!("Unable to serialize workflow: {error}"))
        }
        "archive_workflow" => {
            let workflow_id = require_string(&payload, "workflowId")?;
            command_authorization::require_permission(
                connection,
                authorization,
                "workflows.archive",
            )?;
            let writable = database::open_connection()?;
            serde_json::to_value(workflows::archive_workflow(&writable, &workflow_id)?)
                .map_err(|error| format!("Unable to serialize workflow: {error}"))
        }
        "list_policies" => {
            command_authorization::require_permission(connection, authorization, "policies.read")?;
            serde_json::to_value(policies::list_policies(connection)?)
                .map_err(|error| format!("Unable to serialize policies: {error}"))
        }
        "get_policy" => {
            let policy_id = require_string(&payload, "policyId")?;
            command_authorization::require_permission(connection, authorization, "policies.read")?;
            serde_json::to_value(policies::get_policy(connection, &policy_id)?)
                .map_err(|error| format!("Unable to serialize policy: {error}"))
        }
        "get_agent_permissions" => {
            let agent_id = require_string(&payload, "agentId")?;
            command_authorization::require_permission(connection, authorization, "policies.read")?;
            serde_json::to_value(authorization::resolve_agent_permissions(
                connection, &agent_id,
            )?)
            .map_err(|error| format!("Unable to serialize permissions: {error}"))
        }
        "get_role_permissions" => {
            let role_id = require_string(&payload, "roleId")?;
            command_authorization::require_permission(connection, authorization, "policies.read")?;
            serde_json::to_value(authorization::resolve_role_permissions(
                connection, &role_id,
            )?)
            .map_err(|error| format!("Unable to serialize permissions: {error}"))
        }
        "get_role_instance_permissions" => {
            let instance_id = require_string(&payload, "instanceId")?;
            command_authorization::require_permission(connection, authorization, "policies.read")?;
            serde_json::to_value(authorization::resolve_role_instance_permissions(
                connection,
                &instance_id,
            )?)
            .map_err(|error| format!("Unable to serialize permissions: {error}"))
        }
        "get_worker_overlay" => {
            let worker_type = require_string(&payload, "workerType")?;
            let worker_slug = require_string(&payload, "workerSlug")?;
            let project_slug = payload
                .get("projectSlug")
                .and_then(Value::as_str)
                .unwrap_or("orchestra");
            command_authorization::require_permission(connection, authorization, "projects.read")?;
            serde_json::to_value(project_settings::get_worker_overlay(
                project_slug,
                &worker_type,
                &worker_slug,
            )?)
            .map_err(|error| format!("Unable to serialize worker overlay: {error}"))
        }
        "update_worker_overlay" => {
            let worker_type = require_string(&payload, "workerType")?;
            let worker_slug = require_string(&payload, "workerSlug")?;
            let project_slug = payload
                .get("projectSlug")
                .and_then(Value::as_str)
                .unwrap_or("orchestra");
            let prompt = payload
                .get("prompt")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            command_authorization::require_permission(
                connection,
                authorization,
                "projects.update",
            )?;
            serde_json::to_value(project_settings::update_worker_overlay(
                project_slug,
                &worker_type,
                &worker_slug,
                prompt,
            )?)
            .map_err(|error| format!("Unable to serialize worker overlay: {error}"))
        }
        _ => Err(format!("Unsupported Orchestra bridge command: {command}")),
    }
}

fn start_assignment_blocking(
    session_dir: &std::path::Path,
    assignment: &TaskLaneAssignment,
) -> Result<(), String> {
    if assignment.status != "active" {
        return Ok(());
    }
    let Some(session_id) = assignment.session_id.as_deref() else {
        return Ok(());
    };
    let Some(runtime_cwd) = assignment.runtime_cwd.as_deref() else {
        return Ok(());
    };
    let Some(prompt) = assignment.prompt.as_deref() else {
        return Ok(());
    };

    let run_id = format!("bridge-run-{}", Uuid::new_v4().simple());
    let _ = pi_sessions::stream_prompt_session(
        std::path::Path::new(runtime_cwd),
        session_dir,
        session_id,
        &run_id,
        prompt,
        false,
        |_| {},
    )?;
    Ok(())
}

fn require_string(payload: &Value, key: &str) -> Result<String, String> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("Missing required string field: {key}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::{database::initialize_database_at, policies};
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

    #[test]
    fn invokes_bridge_commands_with_authorization() {
        let mut connection = open_test_connection("tool-bridge");
        let policy = policies::create_policy(
            &mut connection,
            "policy-reader",
            "Policy Reader",
            None,
            &["policies.read".into()],
            false,
            false,
        )
        .expect("policy should create");
        connection
            .execute(
                "INSERT INTO agents (id, slug, name, description, system_prompt, provider, model, role_id, thinking_level, direct_permissions, system, immutable, archived, created_at, updated_at) VALUES ('agent-1', 'agent-1', 'Agent 1', NULL, NULL, NULL, NULL, NULL, 'off', '[]', 0, 0, 0, '2026-03-19T00:00:00Z', '2026-03-19T00:00:00Z')",
                [],
            )
            .expect("agent should seed");
        policies::sync_agent_policy_ids(
            &connection,
            "agent-1",
            std::slice::from_ref(&policy.id),
            "2026-03-19T00:00:00Z",
        )
        .expect("agent policies should sync");

        let result = invoke_bridge_command(
            &connection,
            "list_policies",
            Some(&AuthorizationContext {
                actor_type: "agent".into(),
                actor_id: "agent-1".into(),
            }),
            json!({}),
        )
        .expect("bridge call should succeed");
        let array = result.as_array().expect("result should be an array");
        assert_eq!(array.len(), 1);

        let error = invoke_bridge_command(
            &connection,
            "list_roles",
            Some(&AuthorizationContext {
                actor_type: "agent".into(),
                actor_id: "agent-1".into(),
            }),
            json!({}),
        )
        .expect_err("bridge call should be denied");
        assert!(error.contains("roles.read"));
    }
}
