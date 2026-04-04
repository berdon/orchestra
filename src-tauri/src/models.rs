use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub app_name: String,
    pub environment: String,
    pub backend_status: String,
    pub version_display: String,
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
    pub mode: Option<String>,
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
    pub mode: Option<String>,
    pub repository_path: Option<String>,
    pub default_branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryRemoteInput {
    pub remote_url: String,
    pub remote_name: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeClientDiagnostics {
    pub client_id: String,
    pub session_id: Option<String>,
    pub actor_type: Option<String>,
    pub actor_id: Option<String>,
    pub request_count: i64,
    pub in_flight_request_count: i64,
    pub last_seen_at: String,
    pub last_command: Option<String>,
    pub last_error: Option<String>,
    pub active: bool,
    pub bridge_instance_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeRequestDiagnostics {
    pub request_id: String,
    pub client_id: Option<String>,
    pub session_id: Option<String>,
    pub command: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub success: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeCleanupEvent {
    pub id: String,
    pub instance_id: Option<String>,
    pub pid: Option<u32>,
    pub action: String,
    pub reason: String,
    pub success: bool,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeInstanceDiagnostics {
    pub instance_id: String,
    pub url: String,
    pub owner_pid: u32,
    pub started_at: String,
    pub heartbeat_at: String,
    pub metadata_path: String,
    pub active_client_count: i64,
    pub in_flight_request_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeDiagnostics {
    pub instance: BridgeInstanceDiagnostics,
    pub clients: Vec<BridgeClientDiagnostics>,
    pub recent_requests: Vec<BridgeRequestDiagnostics>,
    pub recent_cleanup_events: Vec<BridgeCleanupEvent>,
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
pub struct PiExecutableDiagnostic {
    pub resolved_path: Option<String>,
    pub error: Option<String>,
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
    #[serde(default)]
    pub terminal_attached: bool,
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
    #[serde(default)]
    pub terminal_attached: bool,
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
pub struct SessionPromptToken {
    pub token: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSessionPromptSettings {
    pub project_slug: String,
    pub template: String,
    pub default_template: String,
    pub available_tokens: Vec<SessionPromptToken>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTaskAutomationSettings {
    pub project_slug: String,
    pub auto_dispatch_on_blocker_completion: bool,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramChannelConfig {
    pub bot_username: Option<String>,
    pub api_base_url: Option<String>,
    pub chat_id: Option<String>,
    pub chat_title: Option<String>,
    pub chat_type: Option<String>,
    pub commands_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramChannelConfigInput {
    #[serde(default)]
    pub bot_token: Option<String>,
    #[serde(default)]
    pub api_base_url: Option<String>,
    #[serde(default)]
    pub chat_id: Option<String>,
    #[serde(default)]
    pub chat_title: Option<String>,
    #[serde(default)]
    pub chat_type: Option<String>,
    #[serde(default)]
    pub commands_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelUpsertInput {
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub target_agent_id: Option<String>,
    #[serde(default)]
    pub default_project_id: Option<String>,
    #[serde(default)]
    pub telegram: Option<TelegramChannelConfigInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelSummary {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub enabled: bool,
    pub status: String,
    pub target_agent_id: String,
    pub default_project_id: Option<String>,
    pub default_project_name: Option<String>,
    pub last_error: Option<String>,
    pub last_activity_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelActivityEntry {
    pub id: String,
    pub channel_id: String,
    pub direction: String,
    pub message_kind: String,
    pub external_message_id: Option<String>,
    pub chat_id: Option<String>,
    pub session_id: Option<String>,
    pub run_id: Option<String>,
    pub body: String,
    pub status: String,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelDetail {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub enabled: bool,
    pub status: String,
    pub target_agent_id: String,
    pub default_project_id: Option<String>,
    pub default_project_name: Option<String>,
    pub secret_configured: bool,
    pub telegram: Option<TelegramChannelConfig>,
    pub last_error: Option<String>,
    pub last_activity_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramBotValidation {
    pub bot_id: String,
    pub username: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramChatCandidate {
    pub chat_id: String,
    pub title: String,
    pub chat_type: String,
    pub username: Option<String>,
    pub last_message_text: Option<String>,
    pub last_message_at: Option<String>,
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
    pub parent_comment_id: Option<String>,
    pub author: String,
    pub message: String,
    pub interrupt_agent: bool,
    pub repository_id: Option<String>,
    pub relative_path: Option<String>,
    pub line_start: Option<i64>,
    pub line_end: Option<i64>,
    pub column_start: Option<i64>,
    pub column_end: Option<i64>,
    pub selected_text: Option<String>,
    pub anchor_commit_hash: Option<String>,
    pub anchor_has_uncommitted_changes: Option<bool>,
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
    pub is_default: bool,
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
pub struct TaskRepository {
    pub task_id: String,
    pub repository_id: String,
    pub repository_name: String,
    pub repository_slug: String,
    pub managed_repository_path: Option<String>,
    pub source_path: Option<String>,
    pub source_kind: Option<String>,
    pub task_worktree_path: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCommentFileMentionCandidate {
    pub repository_id: String,
    pub repository_name: String,
    pub repository_slug: String,
    pub relative_path: String,
    pub display_text: String,
    pub insert_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCommentInput {
    pub author: String,
    pub message: String,
    pub interrupt_agent: bool,
    #[serde(default)]
    pub parent_comment_id: Option<String>,
    #[serde(default)]
    pub repository_id: Option<String>,
    #[serde(default)]
    pub relative_path: Option<String>,
    #[serde(default)]
    pub absolute_path: Option<String>,
    #[serde(default)]
    pub line_start: Option<i64>,
    #[serde(default)]
    pub line_end: Option<i64>,
    #[serde(default)]
    pub column_start: Option<i64>,
    #[serde(default)]
    pub column_end: Option<i64>,
    #[serde(default)]
    pub selected_text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCommentUpdateInput {
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MarkTaskCommentsReadInput {
    pub comment_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMailboxMessageInput {
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub task_id: Option<String>,
    pub recipient_type: String,
    #[serde(default)]
    pub recipient_id: Option<String>,
    #[serde(default)]
    pub sender_label: Option<String>,
    pub body: String,
    #[serde(default)]
    pub priority: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MarkMailboxMessagesReadInput {
    pub delivery_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveMailboxMessagesInput {
    pub delivery_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MailboxMessage {
    pub delivery_id: String,
    pub message_id: String,
    pub project_id: String,
    pub task_id: Option<String>,
    pub task_number: Option<String>,
    pub task_title: Option<String>,
    pub sender_type: String,
    pub sender_id: Option<String>,
    pub sender_label: String,
    pub recipient_type: String,
    pub recipient_id: Option<String>,
    pub recipient_label: String,
    pub assignment_id: Option<String>,
    pub body: String,
    pub priority: String,
    pub read_at: Option<String>,
    pub read_session_id: Option<String>,
    pub archived_at: Option<String>,
    pub last_notified_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCommentReceipt {
    pub comment_id: String,
    pub task_id: String,
    pub assignment_id: String,
    pub worker_type: String,
    pub worker_id: Option<String>,
    pub role_instance_id: Option<String>,
    pub session_id: String,
    pub read_at: String,
    pub created_at: String,
    pub updated_at: String,
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
    pub pending_outcome: Option<String>,
    pub completion_notes: Option<String>,
    pub whip_count: i64,
    pub last_whip_at: Option<String>,
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
    pub whip_max_attempts: i64,
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
    #[serde(default)]
    pub repository_ids: Vec<String>,
    pub parent_task_id: Option<String>,
    pub whip_max_attempts: i64,
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
    pub task_repositories: Vec<TaskRepository>,
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
    #[serde(default)]
    pub repository_ids: Vec<String>,
    pub parent_task_id: Option<String>,
    pub whip_max_attempts: Option<i64>,
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
    #[serde(default)]
    pub use_separate_worktree: bool,
    #[serde(default)]
    pub require_user_approval_on_success: bool,
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
    #[serde(default)]
    pub use_separate_worktree: bool,
    #[serde(default)]
    pub require_user_approval_on_success: bool,
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
