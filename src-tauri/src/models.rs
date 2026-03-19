use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub app_name: String,
    pub environment: String,
    pub backend_status: String,
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
pub struct SessionRecord {
    pub id: String,
    pub title: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    pub subscribed: bool,
    pub events: Vec<SessionEvent>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSummary {
    pub id: String,
    pub name: String,
    pub thinking_level: String,
    pub archived: bool,
    pub created_at: String,
    pub updated_at: String,
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
