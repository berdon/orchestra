use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub app_name: String,
    pub environment: String,
    pub backend_status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub description: Option<String>,
    pub default_repository_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryRecord {
    pub id: String,
    pub project_id: String,
    pub slug: String,
    pub name: String,
    pub repository_path: Option<String>,
    pub source_path: Option<String>,
    pub source_kind: Option<String>,
    pub default_branch: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDetail {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub description: Option<String>,
    pub default_repository_id: Option<String>,
    pub repositories: Vec<RepositoryRecord>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUpsertInput {
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryUpsertInput {
    pub name: String,
    pub repository_path: Option<String>,
    pub default_branch: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub id: String,
    pub level: String,
    pub target: String,
    pub message: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStorageInfo {
    pub orchestra_root: String,
    pub project_slug: String,
    pub session_dir: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionModel {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub api: String,
    pub reasoning: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionModelState {
    pub session_id: String,
    pub current_model: Option<SessionModel>,
    pub current_thinking_level: String,
    pub available_models: Vec<SessionModel>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedSessionMessage {
    pub session_id: String,
    pub run_id: String,
    pub message: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStreamEnvelope {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub event: Value,
    pub received_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStreamEvent {
    pub session_id: String,
    pub run_id: String,
    pub event: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub record: Option<SessionRecord>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEvent {
    pub id: String,
    pub kind: String,
    pub message: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDebugInfo {
    pub project_root: Option<String>,
    pub managed_repository_path: Option<String>,
    pub worktree_path: Option<String>,
    pub session_cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub id: String,
    pub title: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    pub subscribed: bool,
    pub events: Vec<SessionEvent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub debug_info: Option<SessionDebugInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSummary {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub role_id: Option<String>,
    pub thinking_level: String,
    pub policy_ids: Vec<String>,
    pub direct_permissions: Vec<String>,
    pub system: bool,
    pub immutable: bool,
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefinition {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub description: Option<String>,
    pub system_prompt: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub role_id: Option<String>,
    pub thinking_level: String,
    pub policy_ids: Vec<String>,
    pub direct_permissions: Vec<String>,
    pub system: bool,
    pub immutable: bool,
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUpsertInput {
    pub name: String,
    pub description: Option<String>,
    pub system_prompt: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub role_id: Option<String>,
    pub thinking_level: Option<String>,
    #[serde(default)]
    pub policy_ids: Vec<String>,
    #[serde(default)]
    pub direct_permissions: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentValidationResult {
    pub valid: bool,
    pub errors: Vec<AgentValidationError>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentValidationError {
    pub code: String,
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMemoryInfo {
    pub agent_id: String,
    pub slug: String,
    pub root_dir: String,
    pub agents_path: String,
    pub identity_path: String,
    pub soul_path: String,
    pub memory_path: String,
    pub tools_path: String,
    pub daily_memory_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeState {
    pub project_id: String,
    pub agent_id: String,
    pub status: String,
    pub main_session_id: Option<String>,
    pub runtime_cwd: Option<String>,
    pub current_queue_entry_id: Option<String>,
    pub last_dispatch_at: Option<String>,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentQueueEntry {
    pub id: String,
    pub project_id: String,
    pub agent_id: String,
    pub status: String,
    pub source_type: String,
    pub source_task_id: Option<String>,
    pub source_workflow_id: Option<String>,
    pub source_lane_id: Option<String>,
    pub delivery_mode: String,
    pub title: String,
    pub message: String,
    pub session_id: Option<String>,
    pub run_id: Option<String>,
    pub dispatched_at: Option<String>,
    pub completed_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentQueueEntryInput {
    pub agent_id: String,
    pub source_type: String,
    pub source_task_id: Option<String>,
    pub source_workflow_id: Option<String>,
    pub source_lane_id: Option<String>,
    pub delivery_mode: String,
    pub title: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOperationsSnapshot {
    pub agent: AgentDefinition,
    pub runtime_state: AgentRuntimeState,
    pub queued_count: i64,
    pub dispatched_count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOperationsDetail {
    pub agent: AgentDefinition,
    pub runtime_state: AgentRuntimeState,
    pub queue_entries: Vec<AgentQueueEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectWorkerOverlay {
    pub project_slug: String,
    pub worker_type: String,
    pub worker_slug: String,
    pub prompt: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleDefinition {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub description: Option<String>,
    pub system_prompt: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub thinking_level: String,
    pub capacity: i64,
    pub policy_ids: Vec<String>,
    pub direct_permissions: Vec<String>,
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleSummary {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub description: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub thinking_level: String,
    pub capacity: i64,
    pub policy_ids: Vec<String>,
    pub direct_permissions: Vec<String>,
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleUpsertInput {
    pub name: String,
    pub description: Option<String>,
    pub system_prompt: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub thinking_level: Option<String>,
    pub capacity: i64,
    #[serde(default)]
    pub policy_ids: Vec<String>,
    #[serde(default)]
    pub direct_permissions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyDefinition {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub description: Option<String>,
    pub permissions: Vec<String>,
    pub system: bool,
    pub immutable: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicySummary {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub description: Option<String>,
    pub system: bool,
    pub immutable: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizationContext {
    pub actor_type: String,
    pub actor_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedPermissions {
    pub actor_type: String,
    pub actor_id: String,
    pub inherited_role_id: Option<String>,
    pub policy_ids: Vec<String>,
    pub permissions: Vec<String>,
    pub grants_full_access: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestraToolDefinition {
    pub name: String,
    pub description: String,
    pub required_permission: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleValidationResult {
    pub valid: bool,
    pub errors: Vec<RoleValidationError>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleValidationError {
    pub code: String,
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleQueueEntry {
    pub id: String,
    pub role_id: String,
    pub status: String,
    pub source_type: String,
    pub source_task_id: Option<String>,
    pub source_workflow_id: Option<String>,
    pub source_lane_id: Option<String>,
    pub title: String,
    pub summary: Option<String>,
    pub entry_prompt: Option<String>,
    pub assigned_instance_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleQueueEntryInput {
    pub role_id: String,
    pub source_type: String,
    pub source_task_id: Option<String>,
    pub source_workflow_id: Option<String>,
    pub source_lane_id: Option<String>,
    pub title: String,
    pub summary: Option<String>,
    pub entry_prompt: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleInstance {
    pub id: String,
    pub role_id: String,
    pub display_name: String,
    pub status: String,
    pub current_queue_entry_id: Option<String>,
    pub session_id: Option<String>,
    pub worktree_path: Option<String>,
    pub last_heartbeat_at: Option<String>,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleInstanceInput {
    pub role_id: String,
    pub display_name: Option<String>,
    pub status: Option<String>,
    pub current_queue_entry_id: Option<String>,
    pub session_id: Option<String>,
    pub worktree_path: Option<String>,
    pub last_heartbeat_at: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleOperationsSnapshot {
    pub role: RoleSummary,
    pub queued_count: i64,
    pub assigned_count: i64,
    pub active_instance_count: i64,
    pub idle_instance_count: i64,
    pub latest_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleOperationsDetail {
    pub role: RoleDefinition,
    pub queued_count: i64,
    pub assigned_count: i64,
    pub active_instance_count: i64,
    pub idle_instance_count: i64,
    pub queue_entries: Vec<RoleQueueEntry>,
    pub instances: Vec<RoleInstance>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskComment {
    pub id: String,
    pub task_id: String,
    pub author: String,
    pub message: String,
    pub interrupt_agent: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskAttachment {
    pub id: String,
    pub task_id: String,
    pub file_name: String,
    pub media_type: String,
    pub byte_size: i64,
    pub stored_path: String,
    pub caption: Option<String>,
    pub preview_text: Option<String>,
    pub image_data_url: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskAttachmentInput {
    pub file_name: String,
    pub media_type: String,
    pub base64_data: String,
    pub caption: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskFileReference {
    pub id: String,
    pub task_id: String,
    pub repository_id: String,
    pub repository_name: String,
    pub repository_slug: String,
    pub relative_path: String,
    pub absolute_path: Option<String>,
    pub exists: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskFileReferenceInput {
    pub repository_id: String,
    pub relative_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCommentInput {
    pub author: String,
    pub message: String,
    pub interrupt_agent: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskLaneRun {
    pub id: String,
    pub task_id: String,
    pub lane_id: String,
    pub session_id: String,
    pub result: String,
    pub notes: Option<String>,
    pub started_at: String,
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskLaneAssignment {
    pub id: String,
    pub task_id: String,
    pub workflow_id: String,
    pub lane_id: String,
    pub worker_type: String,
    pub worker_id: Option<String>,
    pub status: String,
    pub session_id: Option<String>,
    pub runtime_cwd: Option<String>,
    pub role_queue_entry_id: Option<String>,
    pub role_instance_id: Option<String>,
    pub prompt: Option<String>,
    pub started_at: String,
    pub completed_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSummary {
    pub id: String,
    pub project_id: String,
    pub number: String,
    pub title: String,
    pub description: Option<String>,
    #[serde(rename = "type")]
    pub task_type: String,
    pub status: String,
    pub priority: String,
    pub workflow_id: Option<String>,
    pub current_lane_id: Option<String>,
    pub assignee_type: String,
    pub assignee_id: Option<String>,
    pub parent_task_id: Option<String>,
    pub archived: bool,
    pub comment_count: i64,
    pub lane_run_count: i64,
    pub child_count: i64,
    pub completed_child_count: i64,
    pub in_progress_child_count: i64,
    pub blocked_child_count: i64,
    pub blocked_by_count: i64,
    pub blocking_count: i64,
    pub attachment_count: i64,
    pub dependency_blocked: bool,
    pub ready_for_dispatch: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDependency {
    pub id: String,
    pub blocker_task_id: String,
    pub blocked_task_id: String,
    pub blocker: TaskSummary,
    pub blocked: TaskSummary,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDetail {
    pub id: String,
    pub project_id: String,
    pub number: String,
    pub title: String,
    pub description: Option<String>,
    #[serde(rename = "type")]
    pub task_type: String,
    pub status: String,
    pub priority: String,
    pub workflow_id: Option<String>,
    pub current_lane_id: Option<String>,
    pub assignee_type: String,
    pub assignee_id: Option<String>,
    pub repository_id: Option<String>,
    pub parent_task_id: Option<String>,
    pub archived: bool,
    pub comment_count: i64,
    pub lane_run_count: i64,
    pub child_count: i64,
    pub completed_child_count: i64,
    pub in_progress_child_count: i64,
    pub blocked_child_count: i64,
    pub blocked_by_count: i64,
    pub blocking_count: i64,
    pub attachment_count: i64,
    pub dependency_blocked: bool,
    pub ready_for_dispatch: bool,
    pub parent: Option<TaskSummary>,
    pub lineage: Vec<TaskSummary>,
    pub children: Vec<TaskSummary>,
    pub blocked_by: Vec<TaskDependency>,
    pub blocking: Vec<TaskDependency>,
    pub attachments: Vec<TaskAttachment>,
    pub file_references: Vec<TaskFileReference>,
    pub comments: Vec<TaskComment>,
    pub lane_runs: Vec<TaskLaneRun>,
    pub active_lane_assignment: Option<TaskLaneAssignment>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskUpsertInput {
    pub title: String,
    pub description: Option<String>,
    #[serde(rename = "type")]
    pub task_type: String,
    pub status: String,
    pub priority: String,
    pub workflow_id: Option<String>,
    pub current_lane_id: Option<String>,
    pub assignee_type: String,
    pub assignee_id: Option<String>,
    pub repository_id: Option<String>,
    pub parent_task_id: Option<String>,
    pub archived: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowDefinition {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub description: Option<String>,
    pub archived: bool,
    pub lanes: Vec<WorkflowLane>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowLane {
    pub id: String,
    pub key: String,
    pub name: String,
    pub description: Option<String>,
    pub order: i64,
    pub assigned_entity_type: String,
    pub assigned_entity_id: Option<String>,
    pub entry_prompt_template: Option<String>,
    pub success_transition_type: String,
    pub success_target_lane_id: Option<String>,
    pub failure_transition_type: String,
    pub failure_target_lane_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowSummary {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub description: Option<String>,
    pub archived: bool,
    pub lane_count: usize,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowUpsertInput {
    pub name: String,
    pub description: Option<String>,
    pub lanes: Vec<WorkflowLaneInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowLaneInput {
    pub id: Option<String>,
    pub key: String,
    pub name: String,
    pub description: Option<String>,
    pub order: Option<i64>,
    pub assigned_entity_type: String,
    pub assigned_entity_id: Option<String>,
    pub entry_prompt_template: Option<String>,
    pub success_transition_type: String,
    pub success_target_lane_id: Option<String>,
    pub failure_transition_type: String,
    pub failure_target_lane_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowValidationResult {
    pub valid: bool,
    pub errors: Vec<WorkflowValidationError>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowValidationError {
    pub code: String,
    pub path: String,
    pub message: String,
}
