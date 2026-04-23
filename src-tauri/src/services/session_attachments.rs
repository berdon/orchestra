use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::services::orchestra_paths::default_orchestra_root;

const SESSION_ATTACHMENT_DIR: &str = "runtime/session-attachments";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionAttachmentRecord {
    pub session_id: String,
    pub surface: String,
    pub owner_pid: u32,
    pub label: Option<String>,
    pub attached_at: String,
    pub updated_at: String,
}

pub fn session_terminal_attached(session_id: &str) -> Result<bool, String> {
    Ok(load_active_attachment(session_id)?.is_some())
}

pub fn claim_session_terminal_attachment(
    session_id: &str,
    surface: &str,
    label: Option<&str>,
    owner_pid: u32,
) -> Result<(), String> {
    let root = default_orchestra_root()?;
    claim_session_terminal_attachment_at(&root, session_id, surface, label, owner_pid)
}

pub fn update_session_terminal_attachment(
    session_id: &str,
    surface: &str,
    label: Option<&str>,
    owner_pid: u32,
) -> Result<(), String> {
    let root = default_orchestra_root()?;
    update_session_terminal_attachment_at(&root, session_id, surface, label, owner_pid)
}

pub fn clear_session_terminal_attachment(session_id: &str) -> Result<(), String> {
    let root = default_orchestra_root()?;
    clear_session_terminal_attachment_at(&root, session_id)
}

fn load_active_attachment(session_id: &str) -> Result<Option<SessionAttachmentRecord>, String> {
    let root = default_orchestra_root()?;
    load_active_attachment_at(&root, session_id)
}

pub(crate) fn claim_session_terminal_attachment_at(
    root: &Path,
    session_id: &str,
    surface: &str,
    label: Option<&str>,
    owner_pid: u32,
) -> Result<(), String> {
    if let Some(existing) = load_active_attachment_at(root, session_id)? {
        return Err(format!(
            "Session {session_id} is already attached via {}{}.",
            existing.surface,
            existing
                .label
                .as_deref()
                .map(|label| format!(" ({label})"))
                .unwrap_or_default(),
        ));
    }

    write_attachment_record(
        root,
        &SessionAttachmentRecord {
            session_id: session_id.to_string(),
            surface: surface.trim().to_string(),
            owner_pid,
            label: label
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
            attached_at: now_iso(),
            updated_at: now_iso(),
        },
    )
}

pub(crate) fn update_session_terminal_attachment_at(
    root: &Path,
    session_id: &str,
    surface: &str,
    label: Option<&str>,
    owner_pid: u32,
) -> Result<(), String> {
    let mut record = load_attachment_record(root, session_id)?.unwrap_or(SessionAttachmentRecord {
        session_id: session_id.to_string(),
        surface: surface.trim().to_string(),
        owner_pid,
        label: label
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        attached_at: now_iso(),
        updated_at: now_iso(),
    });
    record.surface = surface.trim().to_string();
    record.owner_pid = owner_pid;
    record.label = label
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    record.updated_at = now_iso();
    write_attachment_record(root, &record)
}

pub(crate) fn clear_session_terminal_attachment_at(
    root: &Path,
    session_id: &str,
) -> Result<(), String> {
    let path = attachment_path(root, session_id);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "Unable to clear session attachment marker {}: {error}",
            path.display()
        )),
    }
}

pub(crate) fn load_active_attachment_at(
    root: &Path,
    session_id: &str,
) -> Result<Option<SessionAttachmentRecord>, String> {
    let Some(record) = load_attachment_record(root, session_id)? else {
        return Ok(None);
    };

    if !process_is_running(record.owner_pid) {
        clear_session_terminal_attachment_at(root, session_id)?;
        return Ok(None);
    }

    Ok(Some(record))
}

fn load_attachment_record(
    root: &Path,
    session_id: &str,
) -> Result<Option<SessionAttachmentRecord>, String> {
    let path = attachment_path(root, session_id);
    let contents = match fs::read_to_string(&path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Unable to read session attachment marker {}: {error}",
                path.display()
            ))
        }
    };

    let record = serde_json::from_str::<SessionAttachmentRecord>(&contents).map_err(|error| {
        format!(
            "Unable to parse session attachment marker {}: {error}",
            path.display()
        )
    })?;

    if record.session_id != session_id {
        clear_session_terminal_attachment_at(root, session_id)?;
        return Ok(None);
    }

    Ok(Some(record))
}

fn write_attachment_record(root: &Path, record: &SessionAttachmentRecord) -> Result<(), String> {
    let path = attachment_path(root, &record.session_id);
    let parent = path
        .parent()
        .ok_or_else(|| format!("Attachment marker path {} has no parent", path.display()))?;
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "Unable to create session attachment directory {}: {error}",
            parent.display()
        )
    })?;

    let temp_path = parent.join(format!(
        ".{}.{}.tmp",
        sanitize_session_id(&record.session_id),
        std::process::id()
    ));
    let contents = serde_json::to_vec_pretty(record)
        .map_err(|error| format!("Unable to serialize session attachment marker: {error}"))?;
    fs::write(&temp_path, contents).map_err(|error| {
        format!(
            "Unable to write session attachment marker {}: {error}",
            temp_path.display()
        )
    })?;
    fs::rename(&temp_path, &path).map_err(|error| {
        let _ = fs::remove_file(&temp_path);
        format!(
            "Unable to publish session attachment marker {}: {error}",
            path.display()
        )
    })?;
    Ok(())
}

fn attachment_path(root: &Path, session_id: &str) -> PathBuf {
    root.join(SESSION_ATTACHMENT_DIR)
        .join(format!("{}.json", sanitize_session_id(session_id)))
}

fn sanitize_session_id(session_id: &str) -> String {
    session_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect()
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

#[cfg(unix)]
fn process_is_running(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }

    Command::new("kill")
        .arg("-0")
        .arg(pid.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(true)
}

#[cfg(not(unix))]
fn process_is_running(pid: u32) -> bool {
    pid != 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_test_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "orchestra-session-attachments-{name}-{}-{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        fs::create_dir_all(&root).expect("test root should create");
        root
    }

    #[test]
    fn claim_and_clear_attachment_marker_round_trip() {
        let root = unique_test_root("claim-clear");
        let session_id = "session-1";

        claim_session_terminal_attachment_at(
            &root,
            session_id,
            "orc-chat",
            Some("orc chat"),
            std::process::id(),
        )
        .expect("attachment should claim");

        let record = load_active_attachment_at(&root, session_id)
            .expect("attachment should load")
            .expect("attachment should exist");
        assert_eq!(record.surface, "orc-chat");
        assert_eq!(record.label.as_deref(), Some("orc chat"));

        clear_session_terminal_attachment_at(&root, session_id).expect("attachment should clear");
        assert!(load_active_attachment_at(&root, session_id)
            .expect("attachment should load")
            .is_none());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn stale_attachment_marker_is_discarded() {
        let root = unique_test_root("stale");
        let session_id = "session-2";

        update_session_terminal_attachment_at(
            &root,
            session_id,
            "desktop-agent-terminal",
            Some("agent-terminal-session-2"),
            u32::MAX,
        )
        .expect("stale attachment marker should write");

        assert!(load_active_attachment_at(&root, session_id)
            .expect("attachment should load")
            .is_none());
        assert!(!attachment_path(&root, session_id).exists());

        let _ = fs::remove_dir_all(root);
    }
}
