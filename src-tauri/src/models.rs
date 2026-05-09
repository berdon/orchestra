use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub app_name: String,
    pub environment: String,
    pub backend_status: String,
    pub version_display: String,
    pub dispatch_blocked: bool,
    pub dispatch_blocked_reason: Option<String>,
    pub pi_runtime_diagnostics: PiRuntimeDiagnostics,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SystemNotificationPermissionState {
    Unsupported,
    NotDetermined,
    Denied,
    Granted,
    Provisional,
    Ephemeral,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemNotificationRequest {
    pub title: String,
    pub body: String,
    pub tag: Option<String>,
    pub icon_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemNotificationEnvironmentStatus {
    pub platform: String,
    pub native_supported: bool,
    pub reason: Option<String>,
    pub app_bundle_path: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NotificationEventType {
    MailboxMessageReceived,
    TaskAwaitingUserApproval,
    TaskAwaitingUserIntervention,
    TaskAssignedToUser,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NotificationActionType {
    OpenInbox,
    OpenTask,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum NotificationActionTarget {
    Details,
    Review,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationAction {
    pub r#type: NotificationActionType,
    pub task_id: Option<String>,
    pub target: Option<NotificationActionTarget>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NotificationIntent {
    pub id: String,
    pub event_type: NotificationEventType,
    pub title: String,
    pub body: String,
    pub tag: String,
    pub project_id: Option<String>,
    pub task_id: Option<String>,
    pub delivery_id: Option<String>,
    pub action: Option<NotificationAction>,
    pub occurred_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAccessSettings {
    pub enabled: bool,
    pub use_tailscale: bool,
    pub bind_host: String,
    pub port: u16,
    pub base_url: Option<String>,
    pub websocket_url: Option<String>,
    pub lan_base_url: Option<String>,
    pub web_url: Option<String>,
    pub tailscale_url: Option<String>,
    pub tailscale_web_url: Option<String>,
    pub started_at: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAccessSettingsInput {
    pub enabled: bool,
    pub use_tailscale: bool,
    pub bind_host: Option<String>,
    pub port: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePairingCode {
    pub id: String,
    pub code: Option<String>,
    pub display_code: String,
    pub created_at: String,
    pub expires_at: String,
    pub consumed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePairingCodeInput {
    pub label: Option<String>,
    pub platform: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDeviceRecord {
    pub id: String,
    pub label: String,
    pub platform: String,
    pub created_at: String,
    pub updated_at: String,
    pub last_seen_at: Option<String>,
    pub revoked_at: Option<String>,
    pub push_token_configured: bool,
    pub active_client_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteClientRecord {
    pub client_id: String,
    pub client_kind: String,
    pub device_id: Option<String>,
    pub device_label: Option<String>,
    pub active_project_id: Option<String>,
    pub connected_at: String,
    pub last_seen_at: String,
    pub subscribed_session_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAccessStatus {
    pub settings: RemoteAccessSettings,
    pub pairing_codes: Vec<RemotePairingCode>,
    pub devices: Vec<RemoteDeviceRecord>,
    pub active_clients: Vec<RemoteClientRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAuthResponse {
    pub device: RemoteDeviceRecord,
    pub token: String,
    pub base_url: Option<String>,
    pub websocket_url: Option<String>,
    pub default_project_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePairingCompleteInput {
    pub code: String,
    pub label: Option<String>,
    pub platform: Option<String>,
    pub push_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePushTokenInput {
    pub push_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteWebPushConfig {
    pub supported: bool,
    pub vapid_public_key: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OrchestraClientHostKind {
    Tauri,
    RemoteApi,
    Mock,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OrchestraClientAuthMode {
    DesktopSession,
    SameOriginCookie,
    BearerToken,
    None,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OrchestraCapabilityAvailability {
    Available,
    Unavailable,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestraCapabilityDescriptor {
    pub availability: OrchestraCapabilityAvailability,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestraClientFeatureFlags {
    pub shared_catalog: bool,
    pub shared_tasks: bool,
    pub shared_inbox: bool,
    pub shared_sessions: bool,
    pub shared_skills: bool,
    pub shared_notes: bool,
    pub task_schedules: bool,
    pub session_streaming: bool,
    pub session_controls: bool,
    pub task_comments: bool,
    pub task_files: bool,
    pub task_browser: bool,
    pub task_pull_requests: bool,
    pub desktop_windows: bool,
    pub agent_terminal: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestraClientAppCapabilities {
    pub bootstrap: OrchestraCapabilityDescriptor,
    pub error_reporting: OrchestraCapabilityDescriptor,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestraClientCatalogCapabilities {
    pub projects: OrchestraCapabilityDescriptor,
    pub agents: OrchestraCapabilityDescriptor,
    pub roles: OrchestraCapabilityDescriptor,
    pub workflows: OrchestraCapabilityDescriptor,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestraClientAdminCapabilities {
    pub projects: OrchestraCapabilityDescriptor,
    pub settings: OrchestraCapabilityDescriptor,
    pub workers: OrchestraCapabilityDescriptor,
    pub workflows: OrchestraCapabilityDescriptor,
    pub policies: OrchestraCapabilityDescriptor,
    pub channels: OrchestraCapabilityDescriptor,
    pub model_catalog: OrchestraCapabilityDescriptor,
    pub pi_executable_diagnostic: OrchestraCapabilityDescriptor,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestraClientSkillCapabilities {
    pub read: OrchestraCapabilityDescriptor,
    pub create: OrchestraCapabilityDescriptor,
    pub update: OrchestraCapabilityDescriptor,
    pub archive: OrchestraCapabilityDescriptor,
    pub delete: OrchestraCapabilityDescriptor,
    pub assign: OrchestraCapabilityDescriptor,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestraClientNotesCapabilities {
    pub read: OrchestraCapabilityDescriptor,
    pub write: OrchestraCapabilityDescriptor,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestraClientTaskCapabilities {
    pub read: OrchestraCapabilityDescriptor,
    pub write: OrchestraCapabilityDescriptor,
    pub review: OrchestraCapabilityDescriptor,
    pub comments: OrchestraCapabilityDescriptor,
    pub comment_delete: OrchestraCapabilityDescriptor,
    pub comment_delete_impact: OrchestraCapabilityDescriptor,
    pub todos: OrchestraCapabilityDescriptor,
    pub dependencies: OrchestraCapabilityDescriptor,
    pub attachments: OrchestraCapabilityDescriptor,
    pub file_references: OrchestraCapabilityDescriptor,
    pub file_contents: OrchestraCapabilityDescriptor,
    pub pull_requests: OrchestraCapabilityDescriptor,
    pub schedules: OrchestraCapabilityDescriptor,
    pub browser: Option<OrchestraCapabilityDescriptor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestraClientInboxCapabilities {
    pub read: OrchestraCapabilityDescriptor,
    pub write: OrchestraCapabilityDescriptor,
    pub archive: OrchestraCapabilityDescriptor,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestraClientSessionCapabilities {
    pub read: OrchestraCapabilityDescriptor,
    pub write: OrchestraCapabilityDescriptor,
    pub stream: OrchestraCapabilityDescriptor,
    pub runtime_controls: OrchestraCapabilityDescriptor,
    pub model_selection: OrchestraCapabilityDescriptor,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestraClientHostCapabilities {
    pub logs_window: OrchestraCapabilityDescriptor,
    pub agent_terminal: OrchestraCapabilityDescriptor,
    pub system_notifications: OrchestraCapabilityDescriptor,
    pub bridge_diagnostics: OrchestraCapabilityDescriptor,
    pub runtime_logs: OrchestraCapabilityDescriptor,
    pub harness_settings: OrchestraCapabilityDescriptor,
    pub remote_access: OrchestraCapabilityDescriptor,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestraClientCapabilities {
    pub app: OrchestraClientAppCapabilities,
    pub catalog: OrchestraClientCatalogCapabilities,
    pub admin: OrchestraClientAdminCapabilities,
    pub skills: OrchestraClientSkillCapabilities,
    pub notes: OrchestraClientNotesCapabilities,
    pub tasks: OrchestraClientTaskCapabilities,
    pub inbox: OrchestraClientInboxCapabilities,
    pub sessions: OrchestraClientSessionCapabilities,
    pub host: OrchestraClientHostCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestraClientTransportUrls {
    pub api_base_url: Option<String>,
    pub websocket_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestraClientBootstrap {
    pub contract_version: String,
    pub bootstrapped_at: String,
    pub host_kind: OrchestraClientHostKind,
    pub auth_mode: OrchestraClientAuthMode,
    pub urls: OrchestraClientTransportUrls,
    pub feature_flags: OrchestraClientFeatureFlags,
    pub capabilities: OrchestraClientCapabilities,
    pub app_info: Option<AppInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEventEnvelope {
    pub id: String,
    pub sequence: u64,
    pub topic: String,
    pub timestamp: String,
    pub project_id: Option<String>,
    pub session_id: Option<String>,
    pub task_id: Option<String>,
    pub delivery_id: Option<String>,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub description: Option<String>,
    pub task_prefix: String,
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
pub struct NoteLocation {
    pub scope: String,
    pub repository_id: Option<String>,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteTreeNode {
    pub kind: String,
    pub name: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<NoteTreeNode>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesRoot {
    pub scope: String,
    pub repository_id: Option<String>,
    pub label: String,
    pub docs_exists: bool,
    pub children: Vec<NoteTreeNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesTree {
    pub project_id: String,
    pub roots: Vec<NotesRoot>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDetail {
    pub location: NoteLocation,
    pub markdown: String,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDetail {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub description: Option<String>,
    pub task_prefix: String,
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
    pub task_prefix: String,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiRuntimeDiagnostics {
    pub runtime: PiRuntimeStatus,
    pub auth: PiAuthStatus,
    pub add_ons: PiAddOnPolicyStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PiBunStatus {
    pub available: bool,
    pub path: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiPackageSourceEntry {
    pub source_kind: String,
    pub source_scope: String,
    pub source_path: String,
    pub entries: Vec<String>,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PiPackageDiagnostics {
    pub bun: PiBunStatus,
    pub sources: Vec<PiPackageSourceEntry>,
    pub blocking: bool,
    pub package_free_probe_succeeded: bool,
    pub package_free_model_count: usize,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiRuntimeStatus {
    pub available: bool,
    pub source: String,
    pub packaged_mode: bool,
    pub resolved_path: Option<String>,
    pub error: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiAuthStatus {
    pub configured: bool,
    pub agent_dir: String,
    pub auth_path: String,
    pub models_path: String,
    pub settings_path: String,
    pub auth_exists: bool,
    pub models_exists: bool,
    pub legacy_agent_dir: Option<String>,
    pub legacy_auth_available: bool,
    pub legacy_models_available: bool,
    pub auth_imported_at: Option<String>,
    pub models_imported_at: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiAddOnPolicyStatus {
    pub packaged_mode: bool,
    pub allowed: bool,
    pub extra_extensions: Vec<String>,
    pub blocked_extensions: Vec<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiRuntimeHealth {
    pub source: String,
    pub mode: String,
    pub status: String,
    pub resolved_path: Option<String>,
    pub package_dir: Option<String>,
    pub agent_dir: Option<String>,
    pub version: Option<String>,
    pub built_at: Option<String>,
    pub manifest_path: Option<String>,
    pub error_kind: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiImportLegacyResult {
    pub imported: Vec<String>,
    pub skipped: Vec<String>,
    pub diagnostics: PiRuntimeDiagnostics,
}

pub type PiExecutableDiagnostic = PiRuntimeHealth;

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
    pub delivery_mode: String,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_text: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDebugInfo {
    pub project_root: Option<String>,
    pub managed_repository_path: Option<String>,
    pub worktree_path: Option<String>,
    pub session_cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionControlCapability {
    pub status: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionControlCapabilities {
    pub reload: SessionControlCapability,
    pub compact: SessionControlCapability,
    pub auto_compact: SessionControlCapability,
    pub effective_compaction_window: Option<String>,
    pub effective_compaction_window_source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionControlOperationState {
    pub kind: String,
    pub trigger: String,
    pub status: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedSkillRuntimeContextSummary {
    pub session_id: Option<String>,
    pub project_id: String,
    pub role_id: Option<String>,
    pub agent_id: Option<String>,
    pub workflow_id: Option<String>,
    pub workflow_lane_id: Option<String>,
    pub context_source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedSkillRuntimeAmbientEntry {
    pub source_kind: String,
    pub slug: String,
    pub skill_id: Option<String>,
    pub skill_name: Option<String>,
    pub source_path: Option<String>,
    pub content_path: Option<String>,
    pub relative_source_path: Option<String>,
    pub materialized_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedSkillRuntimeResolvedEntry {
    pub binding_id: String,
    pub skill_id: String,
    pub slug: String,
    pub name: String,
    pub scope_kind: String,
    pub source_kind: String,
    pub load_mode: String,
    pub source_path: String,
    pub content_path: String,
    pub relative_source_path: Option<String>,
    pub materialized_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedSkillRuntimeSuppressedEntry {
    pub binding_id: String,
    pub skill_id: String,
    pub slug: String,
    pub name: String,
    pub scope_kind: String,
    pub source_kind: String,
    pub source_path: String,
    pub content_path: String,
    pub relative_source_path: Option<String>,
    pub suppression_reason: String,
    pub winner_skill_id: Option<String>,
    pub winner_binding_id: Option<String>,
    pub explanation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedSkillRuntimeSnapshotSummary {
    pub snapshot_id: String,
    pub snapshot_dir: String,
    pub manifest_path: String,
    pub skill_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManagedSkillRuntimeDiagnostics {
    pub state: String,
    pub context: ManagedSkillRuntimeContextSummary,
    pub context_hash: String,
    pub ambient_skills: Vec<ManagedSkillRuntimeAmbientEntry>,
    pub resolved_skills: Vec<ManagedSkillRuntimeResolvedEntry>,
    pub suppressed_skills: Vec<ManagedSkillRuntimeSuppressedEntry>,
    pub scoped_snapshot: Option<ManagedSkillRuntimeSnapshotSummary>,
    pub global_publication_manifest_path: Option<String>,
    pub notes: Vec<String>,
    pub warnings: Vec<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRuntimeDetails {
    pub session_id: String,
    pub source: String,
    pub runtime_active: bool,
    pub subscribed: bool,
    pub extension_load_mode: String,
    pub automatic_extensions_disabled: bool,
    pub orchestra_extension_path: Option<String>,
    pub extra_extensions: Vec<String>,
    pub blocked_extra_extensions: Vec<String>,
    pub loaded_extensions: Vec<String>,
    pub pi_runtime_source: Option<String>,
    pub pi_runtime_mode: Option<String>,
    pub pi_runtime_status: Option<String>,
    pub pi_executable_path: Option<String>,
    pub pi_package_dir: Option<String>,
    pub pi_agent_dir: Option<String>,
    pub pi_runtime_version: Option<String>,
    pub pi_runtime_built_at: Option<String>,
    pub pi_runtime_manifest_path: Option<String>,
    pub pi_runtime_error_kind: Option<String>,
    pub pi_runtime_error_message: Option<String>,
    pub shell_path: Option<String>,
    pub project_root: Option<String>,
    pub session_dir: Option<String>,
    pub session_path: Option<String>,
    pub notes: Vec<String>,
    pub managed_skills: Option<ManagedSkillRuntimeDiagnostics>,
    pub control_capabilities: Option<SessionControlCapabilities>,
    pub control_operation: Option<SessionControlOperationState>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTokenUsage {
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub total: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionContextUsage {
    pub tokens: Option<i64>,
    pub context_window: i64,
    pub percent: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStats {
    pub session_id: String,
    pub session_file: Option<String>,
    pub user_messages: i64,
    pub assistant_messages: i64,
    pub tool_calls: i64,
    pub tool_results: i64,
    pub total_messages: i64,
    pub tokens: SessionTokenUsage,
    pub cost: f64,
    pub context_usage: Option<SessionContextUsage>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionListVisibilityState {
    Active,
    Closed,
    Hidden,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionMessageability {
    Messageable,
    Closed,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_number: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_task_project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_task_number: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_task_title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worker_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worker_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub list_visibility: Option<SessionListVisibilityState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub messageability: Option<SessionMessageability>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub control_capabilities: Option<SessionControlCapabilities>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub control_operation: Option<SessionControlOperationState>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSummary {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub role_id: Option<String>,
    pub scope: String,
    pub project_id: Option<String>,
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
    pub scope: String,
    pub project_id: Option<String>,
    pub thinking_level: String,
    pub compaction_window: Option<String>,
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
    pub scope: Option<String>,
    pub project_id: Option<String>,
    pub thinking_level: Option<String>,
    pub compaction_window: Option<String>,
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
pub struct SourceControlSettings {
    pub git_user_name_template: Option<String>,
    pub git_email_template: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSourceControlSettings {
    pub project_slug: String,
    pub git_user_name_template: Option<String>,
    pub git_email_template: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSecretsAvailability {
    pub status: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSecretMetadata {
    pub id: String,
    pub project_id: String,
    pub project_slug: String,
    pub secret_key: String,
    pub description: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub last_rotated_at: String,
    pub value_state: String,
    pub value_state_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSecretsState {
    pub project_slug: String,
    pub availability: ProjectSecretsAvailability,
    pub secrets: Vec<ProjectSecretMetadata>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSecretUpsertInput {
    pub secret_key: String,
    pub description: Option<String>,
    pub value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSecretValueResult {
    pub project_slug: String,
    pub secret_key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiRuntimeSettings {
    pub extra_extensions: Vec<String>,
    pub default_compaction_window: String,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HarnessModelRef {
    pub provider: String,
    pub model_id: String,
    pub api: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HarnessUsageSource {
    pub adapter: String,
    pub scope_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HarnessModelLimitRule {
    pub metric_key: String,
    pub threshold_kind: String,
    pub threshold_value: i64,
    pub action: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HarnessModelLimitPolicy {
    pub model_ref: HarnessModelRef,
    pub usage_source: HarnessUsageSource,
    pub rules: Vec<HarnessModelLimitRule>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HarnessModelLimitMetricValue {
    pub metric_key: String,
    pub value: i64,
    pub unit: String,
    pub next_reset_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HarnessModelLimitState {
    pub model_ref: HarnessModelRef,
    pub usage_source: HarnessUsageSource,
    pub capped: bool,
    pub last_checked_at: Option<String>,
    pub capped_at: Option<String>,
    pub cleared_at: Option<String>,
    pub last_error: Option<String>,
    pub reason: Option<String>,
    pub metrics: Vec<HarnessModelLimitMetricValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HarnessModelLimitsSnapshot {
    pub policies: Vec<HarnessModelLimitPolicy>,
    pub states: Vec<HarnessModelLimitState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiSetupMetadata {
    pub imported_at: Option<String>,
    pub dismissed_legacy_import_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiProviderAuthMethodSummary {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiProviderSetupSummary {
    pub id: String,
    pub name: String,
    pub auth_modes: Vec<String>,
    pub connected: bool,
    pub using_oauth: bool,
    pub model_count: usize,
    pub uses_callback_server: bool,
    pub oauth_methods: Option<Vec<PiProviderAuthMethodSummary>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiSetupIssue {
    pub code: String,
    pub message: String,
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    pub source_kind: Option<String>,
    pub source_path: Option<String>,
    pub source_entries: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiLegacyImportState {
    pub can_import_legacy: bool,
    pub imported_at: Option<String>,
    pub dismissed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiSetupState {
    pub status: String,
    pub agent_dir: String,
    pub auth_path: String,
    pub models_path: String,
    pub settings_path: String,
    pub legacy_agent_dir: Option<String>,
    pub available_providers: Vec<PiProviderSetupSummary>,
    pub available_models: Vec<SessionModel>,
    pub issues: Vec<PiSetupIssue>,
    pub warnings: Vec<PiSetupIssue>,
    pub import_state: PiLegacyImportState,
    pub package_diagnostics: PiPackageDiagnostics,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiLegacyImportPreview {
    pub legacy_agent_dir: String,
    pub auth_path: String,
    pub models_path: String,
    pub auth_exists: bool,
    pub models_exists: bool,
    pub can_import: bool,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiOAuthPromptState {
    pub kind: String,
    pub message: String,
    pub placeholder: Option<String>,
    pub allow_empty: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiOAuthAuthStep {
    pub kind: String,
    pub url: String,
    pub link_label: String,
    pub instructions: Option<String>,
    pub user_code: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiOAuthFlowState {
    pub provider_id: String,
    pub provider_name: String,
    pub method_id: String,
    pub method_kind: String,
    pub uses_callback_server: bool,
    pub status: String,
    pub auth_step: Option<PiOAuthAuthStep>,
    pub browser_opened: bool,
    pub browser_open_error: Option<String>,
    pub prompt: Option<PiOAuthPromptState>,
    pub latest_progress_message: Option<String>,
    pub error: Option<String>,
    pub started_at: String,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TelegramNotificationScope {
    AllProjects,
    ActiveProject,
}

impl Default for TelegramNotificationScope {
    fn default() -> Self {
        Self::AllProjects
    }
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
    #[serde(default)]
    pub notification_scope: TelegramNotificationScope,
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
    #[serde(default)]
    pub notification_scope: Option<TelegramNotificationScope>,
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
    pub compaction_window: Option<String>,
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
    pub compaction_window: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillRuntimeWarning {
    pub code: String,
    pub tone: String,
    pub title: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillSlugConflictSummary {
    pub slug: String,
    pub ambient_skill_ids: Vec<String>,
    pub scoped_skill_ids: Vec<String>,
    pub ambient_sources: Vec<String>,
    pub scoped_scopes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillCatalogStatusSummary {
    pub active: i64,
    pub shadowed: i64,
    pub missing: i64,
    pub invalid: i64,
    pub unloadable: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillCatalogMigrationCallout {
    pub title: String,
    pub message: String,
    pub bullets: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillsCatalogDiagnostics {
    pub external_root_path: String,
    pub has_discovered_external_skills: bool,
    pub external_status_summary: SkillCatalogStatusSummary,
    pub scoped_ambient_conflict_count: i64,
    pub scoped_ambient_conflicts: Vec<SkillSlugConflictSummary>,
    pub migration_callout: Option<SkillCatalogMigrationCallout>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSummary {
    pub id: String,
    pub slug: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub source_kind: String,
    pub source_path: String,
    pub content_path: String,
    pub relative_source_path: Option<String>,
    pub archived: bool,
    pub status: String,
    pub status_reason: Option<String>,
    pub shadowed_by_skill_id: Option<String>,
    pub last_seen_at: Option<String>,
    pub runtime_warnings: Vec<SkillRuntimeWarning>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillBindingScopeCount {
    pub scope_kind: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillBindingSummary {
    pub total_count: i64,
    pub scope_counts: Vec<SkillBindingScopeCount>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillBindingInput {
    pub scope_kind: String,
    pub project_id: Option<String>,
    pub role_id: Option<String>,
    pub agent_id: Option<String>,
    pub workflow_id: Option<String>,
    pub workflow_lane_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillBindingRecord {
    pub id: String,
    pub skill_id: String,
    pub scope_kind: String,
    pub project_id: Option<String>,
    pub role_id: Option<String>,
    pub agent_id: Option<String>,
    pub workflow_id: Option<String>,
    pub workflow_lane_id: Option<String>,
    pub project_name: Option<String>,
    pub project_slug: Option<String>,
    pub role_name: Option<String>,
    pub role_slug: Option<String>,
    pub agent_name: Option<String>,
    pub agent_slug: Option<String>,
    pub workflow_name: Option<String>,
    pub workflow_slug: Option<String>,
    pub workflow_lane_name: Option<String>,
    pub workflow_lane_key: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillLinkSummary {
    pub binding_id: String,
    pub scope_kind: String,
    pub skill_id: String,
    pub skill_slug: Option<String>,
    pub skill_name: String,
    pub skill_description: Option<String>,
    pub skill_source_kind: String,
    pub skill_archived: bool,
    pub skill_status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleSkillLinks {
    pub role_id: String,
    pub skills: Vec<SkillLinkSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkillLinks {
    pub agent_id: String,
    pub direct_skills: Vec<SkillLinkSummary>,
    pub inherited_role_id: Option<String>,
    pub inherited_role_name: Option<String>,
    pub inherited_role_skills: Vec<SkillLinkSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowLaneSkillLinks {
    pub workflow_lane_id: String,
    pub workflow_lane_name: String,
    pub workflow_lane_key: String,
    pub skills: Vec<SkillLinkSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowSkillLinks {
    pub workflow_id: String,
    pub workflow_skills: Vec<SkillLinkSummary>,
    pub workflow_lane_skills: Vec<WorkflowLaneSkillLinks>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDetail {
    #[serde(flatten)]
    pub summary: SkillSummary,
    pub markdown_body: Option<String>,
    pub binding_summary: SkillBindingSummary,
    pub bindings: Vec<SkillBindingRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSkillUpsertInput {
    pub name: String,
    pub slug: Option<String>,
    pub markdown_body: String,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskDiffCommentAnchor {
    pub kind: String,
    pub repository_id: String,
    pub old_path: Option<String>,
    pub new_path: Option<String>,
    pub side: String,
    pub old_line_start: Option<i64>,
    pub old_line_end: Option<i64>,
    pub new_line_start: Option<i64>,
    pub new_line_end: Option<i64>,
    pub base_commit_hash: Option<String>,
    pub head_commit_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCommentFileAnchor {
    pub repository_id: String,
    pub relative_path: String,
    pub line_start: i64,
    pub line_end: i64,
    pub column_start: Option<i64>,
    pub column_end: Option<i64>,
    pub selected_text: Option<String>,
    pub commit_hash: Option<String>,
    pub has_uncommitted_changes: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCommentDomAnchorOrdinalSegment {
    pub tag: String,
    pub index: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCommentDomAnchorLocator {
    pub css_path: Option<String>,
    pub xpath: Option<String>,
    pub role: Option<String>,
    pub accessible_name: Option<String>,
    pub text_snippet: Option<String>,
    pub test_id: Option<String>,
    #[serde(default)]
    pub ordinal_path: Vec<TaskCommentDomAnchorOrdinalSegment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCommentDomAnchorSnapshot {
    pub tag_name: String,
    pub id: Option<String>,
    #[serde(default)]
    pub class_list: Vec<String>,
    pub text_preview: Option<String>,
    #[serde(default)]
    pub attributes: std::collections::BTreeMap<String, String>,
    pub outer_html_snippet: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCommentDomAnchor {
    pub browser_session_id: String,
    pub url: String,
    pub page_title: Option<String>,
    pub dom_revision: i64,
    pub locator: TaskCommentDomAnchorLocator,
    pub snapshot: TaskCommentDomAnchorSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TaskCommentAnchor {
    File(TaskCommentFileAnchor),
    Dom(TaskCommentDomAnchor),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskComment {
    pub id: String,
    pub task_id: String,
    pub parent_comment_id: Option<String>,
    pub author: String,
    pub origin_type: String,
    pub origin_id: Option<String>,
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
    pub anchor: Option<TaskCommentAnchor>,
    pub diff_anchor: Option<TaskDiffCommentAnchor>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCommentDeleteImpact {
    pub comment_id: String,
    pub task_id: String,
    pub reply_count: i64,
    pub attachment_count: i64,
    pub file_reference_count: i64,
    pub cascade_deleted_count: i64,
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
    pub default_branch: Option<String>,
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
    #[serde(default)]
    pub origin_type: Option<String>,
    #[serde(default)]
    pub origin_id: Option<String>,
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
    #[serde(default)]
    pub anchor: Option<TaskCommentAnchor>,
    #[serde(default)]
    pub diff_anchor: Option<TaskDiffCommentAnchor>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCommentUpdateInput {
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskPullRequestFile {
    pub repository_id: String,
    pub repository_name: String,
    pub repository_slug: String,
    pub change_type: String,
    pub old_path: Option<String>,
    pub new_path: Option<String>,
    pub display_path: String,
    pub origin: String,
    pub additions: i64,
    pub deletions: i64,
    pub is_binary: bool,
    pub patch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskPullRequestRepository {
    pub repository_id: String,
    pub repository_name: String,
    pub repository_slug: String,
    pub status: String,
    pub review_root_path: Option<String>,
    pub review_root_kind: Option<String>,
    pub unavailable_reason: Option<String>,
    pub default_branch: Option<String>,
    pub base_commit_hash: Option<String>,
    pub head_commit_hash: Option<String>,
    pub worktree_only: bool,
    pub has_uncommitted_changes: bool,
    pub committed_file_count: i64,
    pub uncommitted_file_count: i64,
    pub mixed_file_count: i64,
    pub files: Vec<TaskPullRequestFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskPullRequestDetail {
    pub task_id: String,
    pub generated_at: String,
    pub repositories: Vec<TaskPullRequestRepository>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskTodo {
    pub id: String,
    pub task_id: String,
    pub lane_id: String,
    pub description: String,
    pub completed: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskTodoInput {
    #[serde(default)]
    pub lane_id: Option<String>,
    pub description: String,
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
    pub summary: Option<String>,
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
    pub completion_summary: Option<String>,
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
pub struct TaskLaneSummary {
    pub lane_id: String,
    pub lane_name: Option<String>,
    pub summary: String,
    pub outcome: Option<String>,
    pub pending: bool,
    pub session_id: Option<String>,
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
    #[serde(default)]
    pub tags: Vec<String>,
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
    pub unread_comment_count: i64,
    pub lane_run_count: i64,
    pub child_count: i64,
    pub completed_child_count: i64,
    pub in_progress_child_count: i64,
    pub blocked_child_count: i64,
    pub blocked_by_count: i64,
    pub blocking_count: i64,
    pub attachment_count: i64,
    pub dependency_blocked: bool,
    pub active_lane_assignment_status: Option<String>,
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
pub struct TaskBrowserSession {
    pub id: String,
    pub task_id: String,
    pub window_label: String,
    pub current_url: Option<String>,
    pub page_title: Option<String>,
    pub inspect_mode: bool,
    pub dom_revision: i64,
    pub last_mutation_at: Option<String>,
    pub last_ready_state: Option<String>,
    pub last_selected_anchor: Option<TaskCommentDomAnchor>,
    pub created_at: String,
    pub updated_at: String,
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
    #[serde(default)]
    pub tags: Vec<String>,
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
    pub unread_comment_count: i64,
    pub lane_run_count: i64,
    pub child_count: i64,
    pub completed_child_count: i64,
    pub in_progress_child_count: i64,
    pub blocked_child_count: i64,
    pub blocked_by_count: i64,
    pub blocking_count: i64,
    pub attachment_count: i64,
    pub dependency_blocked: bool,
    pub active_lane_assignment_status: Option<String>,
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
    pub todos: Vec<TaskTodo>,
    pub lane_runs: Vec<TaskLaneRun>,
    #[serde(default)]
    pub lane_summaries: Vec<TaskLaneSummary>,
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
    #[serde(default)]
    pub tags: Vec<String>,
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
pub struct TaskScheduleOccurrence {
    pub id: String,
    pub schedule_id: String,
    pub occurrence_key: String,
    pub scheduled_at: Option<String>,
    pub event_id: Option<String>,
    pub status: String,
    pub task_id: Option<String>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TaskScheduleTrigger {
    Time(TaskScheduleTimeTrigger),
    Event(TaskScheduleEventTrigger),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TaskScheduleTimeTrigger {
    Once {
        at: String,
        timezone: String,
    },
    EveryMinutes {
        every_minutes: i64,
    },
    Daily {
        time_of_day: String,
        timezone: String,
    },
    Weekly {
        time_of_day: String,
        timezone: String,
        days_of_week: Vec<u32>,
    },
    Monthly {
        time_of_day: String,
        timezone: String,
        day_of_month: u32,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskScheduleEventTrigger {
    pub event_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskScheduleUpsertInput {
    pub task: TaskUpsertInput,
    pub enabled: Option<bool>,
    pub one_shot: bool,
    pub overlap_policy: String,
    pub trigger: TaskScheduleTrigger,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskScheduleSummary {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub description: Option<String>,
    #[serde(rename = "type")]
    pub task_type: String,
    pub priority: String,
    pub workflow_id: Option<String>,
    #[serde(default)]
    pub repository_ids: Vec<String>,
    pub enabled: bool,
    pub one_shot: bool,
    pub overlap_policy: String,
    pub trigger: TaskScheduleTrigger,
    pub next_fire_at: Option<String>,
    pub last_fired_at: Option<String>,
    pub last_materialized_task_id: Option<String>,
    pub last_error: Option<String>,
    pub materialized_task_count: i64,
    pub open_materialized_task_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskScheduleDetail {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub description: Option<String>,
    #[serde(rename = "type")]
    pub task_type: String,
    pub priority: String,
    pub workflow_id: Option<String>,
    #[serde(default)]
    pub repository_ids: Vec<String>,
    pub enabled: bool,
    pub one_shot: bool,
    pub overlap_policy: String,
    pub trigger: TaskScheduleTrigger,
    pub next_fire_at: Option<String>,
    pub last_fired_at: Option<String>,
    pub last_materialized_task_id: Option<String>,
    pub last_error: Option<String>,
    pub materialized_task_count: i64,
    pub open_materialized_task_count: i64,
    pub task_blueprint: TaskUpsertInput,
    pub recent_materialized_tasks: Vec<TaskSummary>,
    pub recent_occurrences: Vec<TaskScheduleOccurrence>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainEvent {
    pub id: String,
    pub sequence: i64,
    pub project_id: Option<String>,
    pub topic: String,
    pub entity_type: String,
    pub entity_id: Option<String>,
    pub payload: Value,
    pub created_at: String,
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
    pub needs_work_target_lane_id: Option<String>,
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
pub struct WorkflowDeleteImpactReferenceCounts {
    pub tasks: usize,
    pub task_schedules: usize,
    pub task_lane_assignments: usize,
    pub role_queue_entries: usize,
    pub agent_queue_entries: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowDeleteImpact {
    pub workflow_id: String,
    pub workflow_name: String,
    pub can_delete: bool,
    pub reference_counts: WorkflowDeleteImpactReferenceCounts,
    pub blocker_messages: Vec<String>,
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
    pub needs_work_target_lane_id: Option<String>,
    pub success_transition_type: String,
    pub success_target_lane_id: Option<String>,
    pub failure_transition_type: String,
    pub failure_target_lane_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowLanePatchInput {
    pub key: Option<String>,
    pub name: Option<String>,
    pub description: Option<String>,
    pub order: Option<i64>,
    pub assigned_entity_type: Option<String>,
    pub assigned_entity_id: Option<String>,
    pub entry_prompt_template: Option<String>,
    pub use_separate_worktree: Option<bool>,
    pub require_user_approval_on_success: Option<bool>,
    pub needs_work_target_lane_id: Option<String>,
    pub success_transition_type: Option<String>,
    pub success_target_lane_id: Option<String>,
    pub failure_transition_type: Option<String>,
    pub failure_target_lane_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowLaneReorderInput {
    pub lane_ids: Vec<String>,
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
