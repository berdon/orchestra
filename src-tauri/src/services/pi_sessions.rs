use std::{
    collections::HashSet,
    env,
    fs::{self, File},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
};

use chrono::{DateTime, TimeZone, Utc};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    models::{SessionEvent, SessionRecord},
    services::orchestra_paths::{default_orchestra_root, project_session_dir, sanitize_slug},
};

const DEFAULT_EMPTY_SESSION_MESSAGE: &str = "Real pi session ready. Send a message to begin.";
const PROMPT_REQUEST_ID: &str = "prompt-1";

#[derive(Debug, Clone)]
pub struct SessionContext {
    pub project_root: PathBuf,
    pub project_slug: String,
    pub orchestra_root: PathBuf,
    pub session_dir: PathBuf,
}

#[derive(Debug, Clone)]
pub struct StoredSession {
    pub path: PathBuf,
    pub record: SessionRecord,
}

pub fn detect_session_context(project_slug_override: Option<&str>) -> Result<SessionContext, String> {
    let project_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "Unable to resolve Orchestra project root".to_string())?;

    let project_slug = project_slug_override
        .map(sanitize_slug)
        .unwrap_or_else(|| infer_project_slug(&project_root));
    let orchestra_root = default_orchestra_root()?;
    let session_dir = project_session_dir(&orchestra_root, &project_slug);

    fs::create_dir_all(&session_dir)
        .map_err(|error| format!("Unable to create session directory {}: {error}", session_dir.display()))?;

    Ok(SessionContext {
        project_root,
        project_slug,
        orchestra_root,
        session_dir,
    })
}

pub fn create_session_file(
    project_root: &Path,
    session_dir: &Path,
    title: Option<&str>,
    subscribed: bool,
) -> Result<StoredSession, String> {
    fs::create_dir_all(session_dir)
        .map_err(|error| format!("Unable to create session directory {}: {error}", session_dir.display()))?;

    let session_id = Uuid::new_v4().to_string();
    let timestamp = now_iso();
    let file_timestamp = timestamp.replace(':', "-").replace('.', "-");
    let session_path = session_dir.join(format!("{file_timestamp}_{session_id}.jsonl"));

    let mut file = File::create(&session_path)
        .map_err(|error| format!("Unable to create session file {}: {error}", session_path.display()))?;

    writeln!(
        file,
        "{}",
        json!({
            "type": "session",
            "version": 3,
            "id": session_id,
            "timestamp": timestamp,
            "cwd": project_root.display().to_string(),
        })
    )
    .map_err(|error| format!("Unable to write session header {}: {error}", session_path.display()))?;

    if let Some(title) = normalized_title(title) {
        writeln!(
            file,
            "{}",
            json!({
                "type": "session_info",
                "id": random_entry_id(),
                "parentId": Value::Null,
                "timestamp": now_iso(),
                "name": title,
            })
        )
        .map_err(|error| format!("Unable to write session title {}: {error}", session_path.display()))?;
    }

    file.sync_all()
        .map_err(|error| format!("Unable to flush session file {}: {error}", session_path.display()))?;

    parse_session_file(&session_path, subscribed)
}

pub fn list_sessions(session_dir: &Path, subscribed_ids: &HashSet<String>) -> Result<Vec<SessionRecord>, String> {
    let mut sessions = list_stored_sessions(session_dir, subscribed_ids)?;
    sessions.sort_by(|left, right| right.record.updated_at.cmp(&left.record.updated_at));
    Ok(sessions.into_iter().map(|session| session.record).collect())
}

pub fn get_session(session_dir: &Path, session_id: &str, subscribed: bool) -> Result<SessionRecord, String> {
    resolve_session(session_dir, session_id, subscribed).map(|session| session.record)
}

pub fn prompt_session(
    project_root: &Path,
    session_dir: &Path,
    session_id: &str,
    message: &str,
    subscribed: bool,
) -> Result<SessionRecord, String> {
    prompt_session_with_executable(project_root, session_dir, session_id, message, subscribed, Path::new("pi"))
}

pub fn prompt_session_with_executable(
    project_root: &Path,
    session_dir: &Path,
    session_id: &str,
    message: &str,
    subscribed: bool,
    executable: &Path,
) -> Result<SessionRecord, String> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err("Message cannot be empty".into());
    }

    let stored = resolve_session(session_dir, session_id, subscribed)?;
    run_prompt_rpc(executable, project_root, session_dir, &stored.path, trimmed)?;
    parse_session_file(&stored.path, subscribed).map(|session| session.record)
}

fn infer_project_slug(project_root: &Path) -> String {
    let file_name = project_root
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("orchestra");

    if file_name == "repository" {
        return project_root
            .parent()
            .and_then(Path::file_name)
            .and_then(|value| value.to_str())
            .map(sanitize_slug)
            .unwrap_or_else(|| "orchestra".into());
    }

    if project_root
        .parent()
        .and_then(Path::file_name)
        .and_then(|value| value.to_str())
        == Some("worktrees")
    {
        return project_root
            .parent()
            .and_then(Path::parent)
            .and_then(Path::file_name)
            .and_then(|value| value.to_str())
            .map(sanitize_slug)
            .unwrap_or_else(|| "orchestra".into());
    }

    sanitize_slug(file_name)
}

fn list_stored_sessions(session_dir: &Path, subscribed_ids: &HashSet<String>) -> Result<Vec<StoredSession>, String> {
    if !session_dir.exists() {
        return Ok(Vec::new());
    }

    let mut sessions = Vec::new();
    let entries = fs::read_dir(session_dir)
        .map_err(|error| format!("Unable to read session directory {}: {error}", session_dir.display()))?;

    for entry in entries {
        let entry = entry.map_err(|error| format!("Unable to inspect session directory entry: {error}"))?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
            continue;
        }

        let subscribed = path
            .file_name()
            .and_then(|_| parse_session_header_id(&path).ok())
            .map(|id| subscribed_ids.contains(&id))
            .unwrap_or(false);

        if let Ok(session) = parse_session_file(&path, subscribed) {
            sessions.push(session);
        }
    }

    Ok(sessions)
}

fn resolve_session(session_dir: &Path, session_id: &str, subscribed: bool) -> Result<StoredSession, String> {
    if !session_dir.exists() {
        return Err(format!(
            "Session directory {} does not exist yet",
            session_dir.display()
        ));
    }

    let entries = fs::read_dir(session_dir)
        .map_err(|error| format!("Unable to read session directory {}: {error}", session_dir.display()))?;

    for entry in entries {
        let entry = entry.map_err(|error| format!("Unable to inspect session directory entry: {error}"))?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
            continue;
        }

        if parse_session_header_id(&path).ok().as_deref() == Some(session_id) {
            return parse_session_file(&path, subscribed);
        }
    }

    Err(format!("Unable to find session {session_id}"))
}

fn parse_session_header_id(path: &Path) -> Result<String, String> {
    let lines = read_jsonl(path)?;
    let header = lines
        .first()
        .ok_or_else(|| format!("Session file {} is empty", path.display()))?;
    header
        .get("id")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("Session file {} is missing a header id", path.display()))
}

fn parse_session_file(path: &Path, subscribed: bool) -> Result<StoredSession, String> {
    let lines = read_jsonl(path)?;
    let header = lines
        .first()
        .ok_or_else(|| format!("Session file {} is empty", path.display()))?;

    if header.get("type").and_then(Value::as_str) != Some("session") {
        return Err(format!("Session file {} does not start with a session header", path.display()));
    }

    let session_id = header
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Session file {} is missing a session id", path.display()))?
        .to_string();
    let created_timestamp = header
        .get("timestamp")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .unwrap_or_else(now_iso);
    let created_at = normalize_timestamp(&created_timestamp);

    let mut title = None;
    let mut updated_at = created_at.clone();
    let mut updated_sort_key = timestamp_sort_key(&updated_at);
    let mut first_user_message = None;
    let mut last_visible_role = None;
    let mut events = Vec::new();

    for line in lines.iter().skip(1) {
        let entry_type = line.get("type").and_then(Value::as_str).unwrap_or_default();
        let entry_timestamp = normalize_timestamp(
            line.get("timestamp")
                .and_then(Value::as_str)
                .unwrap_or(&created_at),
        );
        maybe_update_timestamp(&entry_timestamp, &mut updated_at, &mut updated_sort_key);

        match entry_type {
            "session_info" => {
                if let Some(name) = line.get("name").and_then(Value::as_str).and_then(non_empty_trimmed) {
                    title = Some(name.to_string());
                }
            }
            "message" => {
                let Some(message) = line.get("message") else {
                    continue;
                };
                let role = message.get("role").and_then(Value::as_str).unwrap_or_default();
                let message_text = extract_message_text(message);
                let message_timestamp = message_timestamp(message, &entry_timestamp);
                maybe_update_timestamp(&message_timestamp, &mut updated_at, &mut updated_sort_key);

                match role {
                    "user" => {
                        if let Some(text) = non_empty_trimmed(&message_text) {
                            if first_user_message.is_none() {
                                first_user_message = Some(text.to_string());
                            }
                            last_visible_role = Some("user");
                            events.push(SessionEvent {
                                id: line
                                    .get("id")
                                    .and_then(Value::as_str)
                                    .unwrap_or("user-message")
                                    .to_string(),
                                kind: "user".into(),
                                message: text.to_string(),
                                timestamp: message_timestamp,
                            });
                        }
                    }
                    "assistant" => {
                        if let Some(text) = non_empty_trimmed(&message_text) {
                            last_visible_role = Some("assistant");
                            events.push(SessionEvent {
                                id: line
                                    .get("id")
                                    .and_then(Value::as_str)
                                    .unwrap_or("assistant-message")
                                    .to_string(),
                                kind: "assistant".into(),
                                message: text.to_string(),
                                timestamp: message_timestamp,
                            });
                        }
                    }
                    "toolResult" => {
                        if let Some(text) = non_empty_trimmed(&message_text) {
                            events.push(SessionEvent {
                                id: line
                                    .get("id")
                                    .and_then(Value::as_str)
                                    .unwrap_or("tool-result")
                                    .to_string(),
                                kind: "system".into(),
                                message: format!(
                                    "{} tool result:\n{}",
                                    message
                                        .get("toolName")
                                        .and_then(Value::as_str)
                                        .unwrap_or("Tool"),
                                    text
                                ),
                                timestamp: message_timestamp,
                            });
                        }
                    }
                    "bashExecution" => {
                        if let Some(command) = message.get("command").and_then(Value::as_str) {
                            events.push(SessionEvent {
                                id: line
                                    .get("id")
                                    .and_then(Value::as_str)
                                    .unwrap_or("bash-execution")
                                    .to_string(),
                                kind: "system".into(),
                                message: format!("Executed bash command: {command}"),
                                timestamp: message_timestamp,
                            });
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }

    if events.is_empty() {
        events.push(SessionEvent {
            id: format!("system-{session_id}"),
            kind: "system".into(),
            message: DEFAULT_EMPTY_SESSION_MESSAGE.into(),
            timestamp: created_at.clone(),
        });
    }

    let title = title
        .or_else(|| first_user_message.map(|message| truncate_for_title(&message)))
        .unwrap_or_else(|| format!("Session {}", &session_id[..session_id.len().min(8)]));
    let status = match last_visible_role {
        Some("user") => "active",
        _ => "idle",
    }
    .to_string();

    Ok(StoredSession {
        path: path.to_path_buf(),
        record: SessionRecord {
            id: session_id,
            title,
            status,
            created_at,
            updated_at,
            subscribed,
            events,
        },
    })
}

fn read_jsonl(path: &Path) -> Result<Vec<Value>, String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("Unable to read session file {}: {error}", path.display()))?;

    content
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            serde_json::from_str::<Value>(line).map_err(|error| {
                format!(
                    "Unable to parse session file {} as JSONL: {error}",
                    path.display()
                )
            })
        })
        .collect()
}

fn run_prompt_rpc(
    executable: &Path,
    project_root: &Path,
    session_dir: &Path,
    session_path: &Path,
    message: &str,
) -> Result<(), String> {
    let mut child = Command::new(executable)
        .arg("--mode")
        .arg("rpc")
        .arg("--session")
        .arg(session_path)
        .arg("--session-dir")
        .arg(session_dir)
        .arg("--no-extensions")
        .current_dir(project_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Unable to start pi RPC process: {error}"))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Unable to open stdin for pi RPC process".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Unable to open stdout for pi RPC process".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Unable to open stderr for pi RPC process".to_string())?;

    let stderr_handle = thread::spawn(move || -> String {
        let mut reader = BufReader::new(stderr);
        let mut buffer = String::new();
        let _ = reader.read_to_string(&mut buffer);
        buffer
    });

    writeln!(
        stdin,
        "{}",
        json!({
            "id": PROMPT_REQUEST_ID,
            "type": "prompt",
            "message": message,
        })
    )
    .map_err(|error| format!("Unable to send prompt to pi RPC process: {error}"))?;
    stdin
        .flush()
        .map_err(|error| format!("Unable to flush pi RPC stdin: {error}"))?;
    drop(stdin);

    let mut saw_prompt_response = false;
    let mut saw_agent_end = false;
    let mut rpc_error = None;
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();

    loop {
        line.clear();
        let bytes_read = reader
            .read_line(&mut line)
            .map_err(|error| format!("Unable to read pi RPC output: {error}"))?;
        if bytes_read == 0 {
            break;
        }

        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            continue;
        }

        let payload: Value = serde_json::from_str(trimmed)
            .map_err(|error| format!("Unable to parse pi RPC output as JSON: {error}"))?;

        match payload.get("type").and_then(Value::as_str) {
            Some("response") => {
                if payload.get("id").and_then(Value::as_str) == Some(PROMPT_REQUEST_ID) {
                    saw_prompt_response = true;
                    if payload.get("success").and_then(Value::as_bool) != Some(true) {
                        rpc_error = Some(extract_rpc_error(&payload));
                    }
                }
            }
            Some("message_update") => {
                if payload.pointer("/assistantMessageEvent/type").and_then(Value::as_str) == Some("error") {
                    rpc_error = Some(extract_rpc_error(&payload));
                }
            }
            Some("agent_end") => {
                saw_agent_end = true;
                break;
            }
            _ => {}
        }
    }

    let status = child
        .wait()
        .map_err(|error| format!("Unable to wait for pi RPC process: {error}"))?;
    let stderr_output = stderr_handle
        .join()
        .unwrap_or_else(|_| "Unable to join pi RPC stderr reader".to_string());

    if let Some(error) = rpc_error {
        let stderr_suffix = non_empty_trimmed(&stderr_output)
            .map(|output| format!("\n{output}"))
            .unwrap_or_default();
        return Err(format!("{error}{stderr_suffix}"));
    }

    if !status.success() {
        let stderr_suffix = non_empty_trimmed(&stderr_output)
            .map(|output| format!(": {output}"))
            .unwrap_or_default();
        return Err(format!("pi RPC process exited unsuccessfully{stderr_suffix}"));
    }

    if !saw_prompt_response {
        return Err("pi RPC process did not acknowledge the prompt command".into());
    }

    if !saw_agent_end {
        return Err("pi RPC process ended before the agent finished the turn".into());
    }

    Ok(())
}

fn extract_rpc_error(payload: &Value) -> String {
    payload
        .get("error")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| {
            payload
                .pointer("/assistantMessageEvent/error")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .or_else(|| {
            payload
                .pointer("/message/errorMessage")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_else(|| "pi reported an RPC error".into())
}

fn message_timestamp(message: &Value, fallback: &str) -> String {
    if let Some(milliseconds) = message.get("timestamp").and_then(Value::as_i64) {
        return Utc
            .timestamp_millis_opt(milliseconds)
            .single()
            .map(|value| value.to_rfc3339())
            .unwrap_or_else(|| fallback.to_string());
    }

    normalize_timestamp(fallback)
}

fn extract_message_text(message: &Value) -> String {
    let Some(content) = message.get("content") else {
        return String::new();
    };

    if let Some(text) = content.as_str() {
        return text.trim().to_string();
    }

    content
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|block| {
            if block.get("type").and_then(Value::as_str) == Some("text") {
                block.get("text").and_then(Value::as_str).map(str::trim)
            } else {
                None
            }
        })
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn normalize_timestamp(input: &str) -> String {
    DateTime::parse_from_rfc3339(input)
        .map(|value| value.with_timezone(&Utc).to_rfc3339())
        .unwrap_or_else(|_| now_iso())
}

fn maybe_update_timestamp(candidate: &str, current: &mut String, current_sort_key: &mut i64) {
    let sort_key = timestamp_sort_key(candidate);
    if sort_key > *current_sort_key {
        *current = candidate.to_string();
        *current_sort_key = sort_key;
    }
}

fn timestamp_sort_key(timestamp: &str) -> i64 {
    DateTime::parse_from_rfc3339(timestamp)
        .map(|value| value.with_timezone(&Utc).timestamp_millis())
        .unwrap_or(0)
}

fn random_entry_id() -> String {
    Uuid::new_v4().simple().to_string()[..8].to_string()
}

fn truncate_for_title(input: &str) -> String {
    const MAX_CHARS: usize = 56;
    let trimmed = input.trim();
    let mut chars = trimmed.chars();
    let truncated: String = chars.by_ref().take(MAX_CHARS).collect();
    if chars.next().is_some() {
        format!("{truncated}…")
    } else {
        truncated
    }
}

fn normalized_title(title: Option<&str>) -> Option<String> {
    title.and_then(non_empty_trimmed).map(ToOwned::to_owned)
}

fn non_empty_trimmed(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

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
        let dir = env::temp_dir().join(suffix);
        fs::create_dir_all(&dir).expect("temp dir should be creatable");
        dir
    }

    fn write_fake_pi_executable(path: &Path) {
        let script = r#"#!/usr/bin/env node
import fs from 'node:fs';

const args = process.argv.slice(2);
const sessionIndex = args.indexOf('--session');
const sessionFile = sessionIndex >= 0 ? args[sessionIndex + 1] : null;
if (!sessionFile) {
  console.error('missing --session');
  process.exit(1);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  const commands = input
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const prompt = commands.find((command) => command.type === 'prompt');
  const now = new Date();
  const later = new Date(now.getTime() + 1);
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  fs.appendFileSync(
    sessionFile,
    JSON.stringify({
      type: 'message',
      id: '11111111',
      parentId: null,
      timestamp: now.toISOString(),
      message: {
        role: 'user',
        content: prompt.message,
        timestamp: now.getTime(),
        attachments: [],
      },
    }) + '\n'
  );
  fs.appendFileSync(
    sessionFile,
    JSON.stringify({
      type: 'message',
      id: '22222222',
      parentId: '11111111',
      timestamp: later.toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `Echo: ${prompt.message}` }],
        api: 'test',
        provider: 'test',
        model: 'stub',
        usage,
        stopReason: 'stop',
        timestamp: later.getTime(),
      },
    }) + '\n'
  );
  process.stdout.write(JSON.stringify({ id: 'prompt-1', type: 'response', command: 'prompt', success: true }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'agent_end', messages: [] }) + '\n');
});
"#;

        fs::write(path, script).expect("fake pi script should be writable");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = fs::metadata(path)
                .expect("fake pi script metadata should exist")
                .permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(path, permissions).expect("fake pi script should be executable");
        }
    }

    #[test]
    fn creates_header_only_session_and_preserves_title() {
        let root = unique_temp_dir("orchestra-real-session-create");
        let project_root = root.join("project");
        let session_dir = root.join("sessions");
        fs::create_dir_all(&project_root).expect("project root should exist");

        let stored = create_session_file(&project_root, &session_dir, Some("Desk test"), true)
            .expect("session should be created");

        assert!(stored.path.exists());
        assert_eq!(stored.record.title, "Desk test");
        assert!(stored.record.subscribed);
        assert_eq!(stored.record.events.len(), 1);
        assert_eq!(stored.record.events[0].kind, "system");
    }

    #[test]
    fn lists_real_session_messages_from_jsonl() {
        let root = unique_temp_dir("orchestra-real-session-list");
        let project_root = root.join("project");
        let session_dir = root.join("sessions");
        fs::create_dir_all(&project_root).expect("project root should exist");
        fs::create_dir_all(&session_dir).expect("session dir should exist");

        let session_id = Uuid::new_v4().to_string();
        let session_path = session_dir.join("sample.jsonl");
        let content = format!(
            "{}\n{}\n{}\n{}\n",
            json!({
                "type": "session",
                "version": 3,
                "id": session_id,
                "timestamp": "2026-03-18T12:00:00Z",
                "cwd": project_root.display().to_string(),
            }),
            json!({
                "type": "session_info",
                "id": "abcdef12",
                "parentId": Value::Null,
                "timestamp": "2026-03-18T12:00:01Z",
                "name": "Named session",
            }),
            json!({
                "type": "message",
                "id": "11111111",
                "parentId": "abcdef12",
                "timestamp": "2026-03-18T12:01:00Z",
                "message": {
                    "role": "user",
                    "content": "Hello from Orchestra",
                    "timestamp": 1773835260000i64,
                    "attachments": [],
                }
            }),
            json!({
                "type": "message",
                "id": "22222222",
                "parentId": "11111111",
                "timestamp": "2026-03-18T12:01:01Z",
                "message": {
                    "role": "assistant",
                    "content": [{ "type": "text", "text": "Real pi session reply" }],
                    "api": "test",
                    "provider": "test",
                    "model": "stub",
                    "usage": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}},
                    "stopReason": "stop",
                    "timestamp": 1773835261000i64,
                }
            })
        );
        fs::write(&session_path, content).expect("session file should be writable");

        let mut subscribed = HashSet::new();
        subscribed.insert(session_id.clone());
        let sessions = list_sessions(&session_dir, &subscribed).expect("sessions should list");

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, session_id);
        assert_eq!(sessions[0].title, "Named session");
        assert_eq!(sessions[0].events.len(), 2);
        assert_eq!(sessions[0].events[0].kind, "user");
        assert_eq!(sessions[0].events[1].kind, "assistant");
        assert_eq!(sessions[0].events[1].message, "Real pi session reply");
        assert!(sessions[0].subscribed);
    }

    #[test]
    fn prompts_real_session_through_rpc_process() {
        let root = unique_temp_dir("orchestra-real-session-rpc");
        let project_root = root.join("project");
        let session_dir = root.join("sessions");
        let fake_pi = root.join("fake-pi.mjs");
        fs::create_dir_all(&project_root).expect("project root should exist");
        write_fake_pi_executable(&fake_pi);

        let stored = create_session_file(&project_root, &session_dir, Some("RPC session"), true)
            .expect("session should be created");

        let updated = prompt_session_with_executable(
            &project_root,
            &session_dir,
            &stored.record.id,
            "Hello from the UI",
            true,
            &fake_pi,
        )
        .expect("prompt should succeed");

        assert_eq!(updated.title, "RPC session");
        assert!(updated.events.iter().any(|event| event.kind == "user" && event.message == "Hello from the UI"));
        assert!(updated
            .events
            .iter()
            .any(|event| event.kind == "assistant" && event.message == "Echo: Hello from the UI"));
    }
}
