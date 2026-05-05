use std::fs;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use crate::{
    models::{TaskAttachment, TaskAttachmentInput},
    services::orchestra_paths::{default_orchestra_root, task_attachments_dir},
};

const DEFAULT_PROJECT_ID: &str = "orchestra";
const MAX_TEXT_PREVIEW_BYTES: usize = 64 * 1024;
const MAX_IMAGE_PREVIEW_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone)]
pub struct TaskAttachmentBytesInput {
    pub file_name: String,
    pub media_type: String,
    pub bytes: Vec<u8>,
    pub caption: Option<String>,
}

pub fn add_task_attachment(
    connection: &mut Connection,
    task_id: &str,
    input: TaskAttachmentInput,
) -> Result<TaskAttachment, String> {
    add_task_attachment_bytes(connection, task_id, decode_attachment_input(input)?)
}

pub fn add_task_attachment_bytes(
    connection: &mut Connection,
    task_id: &str,
    input: TaskAttachmentBytesInput,
) -> Result<TaskAttachment, String> {
    let project_id = task_project_id(connection, task_id)?;
    let attachment_id = attachment_id();
    let orchestra_root = default_orchestra_root()?;
    let attachment_dir = task_attachments_dir(&orchestra_root, &project_id, task_id);
    fs::create_dir_all(&attachment_dir).map_err(|error| {
        format!(
            "Unable to create task attachment directory {}: {error}",
            attachment_dir.display()
        )
    })?;

    let file_name = sanitize_file_name(&input.file_name);
    let media_type = normalized_media_type(&input.media_type);
    let stored_path = attachment_dir.join(format!("{}-{}", attachment_id, file_name));
    fs::write(&stored_path, &input.bytes).map_err(|error| {
        format!(
            "Unable to write attachment {}: {error}",
            stored_path.display()
        )
    })?;

    let now = now_iso();
    let tx = connection
        .transaction()
        .map_err(|error| format!("Unable to start attachment transaction: {error}"))?;

    tx.execute(
        r#"
        INSERT INTO task_attachments (
            id,
            project_id,
            task_id,
            file_name,
            media_type,
            byte_size,
            stored_path,
            caption,
            created_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        "#,
        params![
            attachment_id,
            project_id,
            task_id,
            file_name,
            media_type,
            input.bytes.len() as i64,
            stored_path.display().to_string(),
            normalized_optional_string(input.caption),
            now,
        ],
    )
    .map_err(|error| format!("Unable to record task attachment: {error}"))?;

    tx.commit()
        .map_err(|error| format!("Unable to commit task attachment: {error}"))?;

    load_attachment(connection, &attachment_id)
}

pub fn remove_task_attachment(
    connection: &Connection,
    attachment_id: &str,
) -> Result<TaskAttachment, String> {
    let attachment = load_attachment(connection, attachment_id)?;

    let deleted = connection
        .execute(
            "DELETE FROM task_attachments WHERE id = ?1",
            [attachment_id],
        )
        .map_err(|error| format!("Unable to delete task attachment {attachment_id}: {error}"))?;

    if deleted == 0 {
        return Err(format!("Task attachment {attachment_id} was not found"));
    }

    let path = PathBuf::from(&attachment.stored_path);
    if path.exists() {
        fs::remove_file(&path).map_err(|error| {
            format!(
                "Unable to remove task attachment file {}: {error}",
                path.display()
            )
        })?;
    }

    Ok(attachment)
}

pub fn load_task_attachments(
    connection: &Connection,
    task_id: &str,
) -> Result<Vec<TaskAttachment>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, task_id, file_name, media_type, byte_size, stored_path, caption, created_at
            FROM task_attachments
            WHERE task_id = ?1
            ORDER BY created_at ASC, id ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare task attachment query: {error}"))?;

    let rows = statement
        .query_map([task_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, String>(7)?,
            ))
        })
        .map_err(|error| format!("Unable to read task attachments for {task_id}: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to collect task attachments for {task_id}: {error}"))?
        .into_iter()
        .map(
            |(id, task_id, file_name, media_type, byte_size, stored_path, caption, created_at)| {
                build_attachment(
                    id,
                    task_id,
                    file_name,
                    media_type,
                    byte_size,
                    stored_path,
                    caption,
                    created_at,
                )
            },
        )
        .collect()
}

pub fn load_attachment(
    connection: &Connection,
    attachment_id: &str,
) -> Result<TaskAttachment, String> {
    let row = load_attachment_row(connection, attachment_id)?;
    build_attachment(row.0, row.1, row.2, row.3, row.4, row.5, row.6, row.7)
}

pub fn load_attachment_bytes(
    connection: &Connection,
    attachment_id: &str,
) -> Result<(TaskAttachment, Vec<u8>), String> {
    let attachment = load_attachment(connection, attachment_id)?;
    let path = PathBuf::from(&attachment.stored_path);
    let bytes = fs::read(&path)
        .map_err(|error| format!("Unable to read task attachment {}: {error}", path.display()))?;
    Ok((attachment, bytes))
}

pub fn copy_attachment_to_path(
    connection: &Connection,
    attachment_id: &str,
    destination_path: &Path,
) -> Result<TaskAttachment, String> {
    let attachment = load_attachment(connection, attachment_id)?;
    if let Some(parent) = destination_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Unable to create attachment download directory {}: {error}",
                parent.display()
            )
        })?;
    }
    fs::copy(&attachment.stored_path, destination_path).map_err(|error| {
        format!(
            "Unable to copy task attachment {} to {}: {error}",
            attachment.stored_path,
            destination_path.display()
        )
    })?;
    Ok(attachment)
}

pub fn content_disposition_file_name(file_name: &str) -> String {
    sanitize_file_name(file_name)
        .chars()
        .map(|ch| match ch {
            '"' | '\r' | '\n' => '_',
            _ => ch,
        })
        .collect()
}

fn load_attachment_row(
    connection: &Connection,
    attachment_id: &str,
) -> Result<
    (
        String,
        String,
        String,
        String,
        i64,
        String,
        Option<String>,
        String,
    ),
    String,
> {
    connection
        .query_row(
            r#"
            SELECT id, task_id, file_name, media_type, byte_size, stored_path, caption, created_at
            FROM task_attachments
            WHERE id = ?1
            "#,
            [attachment_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, String>(7)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Unable to load task attachment {attachment_id}: {error}"))?
        .ok_or_else(|| format!("Task attachment {attachment_id} was not found"))
}

fn build_attachment(
    id: String,
    task_id: String,
    file_name: String,
    media_type: String,
    byte_size: i64,
    stored_path: String,
    caption: Option<String>,
    created_at: String,
) -> Result<TaskAttachment, String> {
    let path = Path::new(&stored_path);
    let mut preview_text = None;
    let mut image_data_url = None;

    if path.exists() {
        let bytes = fs::read(path).map_err(|error| {
            format!("Unable to read task attachment {}: {error}", path.display())
        })?;

        if is_text_media_type(&media_type) && bytes.len() <= MAX_TEXT_PREVIEW_BYTES {
            preview_text = Some(String::from_utf8_lossy(&bytes).to_string());
        }

        if is_image_media_type(&media_type) && bytes.len() <= MAX_IMAGE_PREVIEW_BYTES {
            image_data_url = Some(format!(
                "data:{};base64,{}",
                media_type,
                STANDARD.encode(bytes)
            ));
        }
    }

    Ok(TaskAttachment {
        id,
        task_id,
        file_name,
        media_type,
        byte_size,
        stored_path,
        caption,
        preview_text,
        image_data_url,
        created_at,
    })
}

fn decode_attachment_input(input: TaskAttachmentInput) -> Result<TaskAttachmentBytesInput, String> {
    let bytes = STANDARD
        .decode(input.base64_data.as_bytes())
        .map_err(|error| format!("Unable to decode attachment payload: {error}"))?;
    Ok(TaskAttachmentBytesInput {
        file_name: input.file_name,
        media_type: input.media_type,
        bytes,
        caption: input.caption,
    })
}

fn task_project_id(connection: &Connection, task_id: &str) -> Result<String, String> {
    connection
        .query_row(
            "SELECT project_id FROM tasks WHERE id = ?1",
            [task_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Unable to resolve project for task {task_id}: {error}"))
}

fn is_text_media_type(media_type: &str) -> bool {
    media_type.starts_with("text/") || media_type == "application/json"
}

fn is_image_media_type(media_type: &str) -> bool {
    media_type.starts_with("image/")
}

fn normalized_media_type(media_type: &str) -> String {
    let trimmed = media_type.trim();
    if trimmed.is_empty() {
        "application/octet-stream".into()
    } else {
        trimmed.to_string()
    }
}

fn sanitize_file_name(file_name: &str) -> String {
    let trimmed = file_name.trim();
    let safe = trimmed
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '\0' => '-',
            _ => ch,
        })
        .collect::<String>();
    if safe.is_empty() {
        "attachment.bin".into()
    } else {
        safe
    }
}

fn normalized_optional_string(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn attachment_id() -> String {
    format!("task-attachment-{}", Uuid::new_v4().simple())
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::database;
    use std::{env, fs, path::PathBuf};
    use uuid::Uuid;

    fn in_memory_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("open in-memory db");
        database::apply_migrations(&connection).expect("apply migrations");
        connection
    }

    fn with_temp_storage_root<T>(label: &str, action: impl FnOnce(PathBuf) -> T) -> T {
        let _guard = crate::test_support::global_test_env_lock()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let previous_root = env::var_os("ORCHESTRA_STORAGE_ROOT");
        let root = env::temp_dir().join(format!(
            "task-attachments-{label}-{}",
            Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&root).expect("temp storage root should create");
        unsafe {
            env::set_var("ORCHESTRA_STORAGE_ROOT", &root);
        }
        let result = action(root.clone());
        match previous_root {
            Some(value) => unsafe { env::set_var("ORCHESTRA_STORAGE_ROOT", value) },
            None => unsafe { env::remove_var("ORCHESTRA_STORAGE_ROOT") },
        }
        let _ = fs::remove_dir_all(root);
        result
    }

    fn create_task_record(connection: &mut Connection) -> String {
        let now = now_iso();
        let task_id = format!("task-{}", Uuid::new_v4().simple());
        connection
            .execute(
                "INSERT INTO tasks (id, project_id, sequence_number, number, title, task_type, status, priority, assignee_type, archived, created_at, updated_at) VALUES (?1, 'orchestra', 1, 'ORC-1', 'Task', 'task', 'ready', 'P2', 'user', 0, ?2, ?2)",
                params![task_id, now],
            )
            .expect("insert task");
        task_id
    }

    #[test]
    fn stores_attachment_metadata_and_preview() {
        with_temp_storage_root("preview", |_| {
            let mut connection = in_memory_connection();
            let task_id = create_task_record(&mut connection);
            let root = default_orchestra_root().expect("orchestra root");
            let attachment_dir = task_attachments_dir(&root, DEFAULT_PROJECT_ID, &task_id);
            if attachment_dir.exists() {
                fs::remove_dir_all(&attachment_dir).ok();
            }

            let attachment = add_task_attachment(
                &mut connection,
                &task_id,
                TaskAttachmentInput {
                    file_name: "notes.txt".into(),
                    media_type: "text/plain".into(),
                    base64_data: STANDARD.encode("hello attachments"),
                    caption: Some("Spec notes".into()),
                },
            )
            .expect("add attachment");

            assert_eq!(attachment.file_name, "notes.txt");
            assert_eq!(
                attachment.preview_text.as_deref(),
                Some("hello attachments")
            );
            assert!(PathBuf::from(&attachment.stored_path).exists());

            let attachments =
                load_task_attachments(&connection, &task_id).expect("load attachments");
            assert_eq!(attachments.len(), 1);
            let removed =
                remove_task_attachment(&connection, &attachment.id).expect("remove attachment");
            assert_eq!(removed.id, attachment.id);
            assert!(!PathBuf::from(&removed.stored_path).exists());
        });
    }

    #[test]
    fn loads_raw_attachment_bytes_even_when_preview_is_skipped() {
        with_temp_storage_root("bytes", |_| {
            let mut connection = in_memory_connection();
            let task_id = create_task_record(&mut connection);
            let large_text = "a".repeat(MAX_TEXT_PREVIEW_BYTES + 1);
            let attachment = add_task_attachment(
                &mut connection,
                &task_id,
                TaskAttachmentInput {
                    file_name: "large.txt".into(),
                    media_type: "text/plain".into(),
                    base64_data: STANDARD.encode(large_text.as_bytes()),
                    caption: None,
                },
            )
            .expect("add attachment");

            assert_eq!(attachment.preview_text, None);
            let (loaded_attachment, bytes) =
                load_attachment_bytes(&connection, &attachment.id).expect("load bytes");
            assert_eq!(loaded_attachment.file_name, "large.txt");
            assert_eq!(bytes, large_text.as_bytes());
        });
    }

    #[test]
    fn stores_non_text_binary_attachments_without_preview_and_preserves_bytes() {
        with_temp_storage_root("binary-roundtrip", |_| {
            let mut connection = in_memory_connection();
            let task_id = create_task_record(&mut connection);
            let zip_bytes = vec![80_u8, 75, 3, 4, 20, 0, 255, 42, 7];
            let audio_bytes = b"RIFF-WAVE".to_vec();

            let zip_attachment = add_task_attachment(
                &mut connection,
                &task_id,
                TaskAttachmentInput {
                    file_name: "bundle.zip".into(),
                    media_type: "application/zip".into(),
                    base64_data: STANDARD.encode(&zip_bytes),
                    caption: Some("Release bundle".into()),
                },
            )
            .expect("zip attachment should store");
            let audio_attachment = add_task_attachment(
                &mut connection,
                &task_id,
                TaskAttachmentInput {
                    file_name: "meeting.wav".into(),
                    media_type: "audio/wav".into(),
                    base64_data: STANDARD.encode(&audio_bytes),
                    caption: None,
                },
            )
            .expect("audio attachment should store");

            assert_eq!(zip_attachment.preview_text, None);
            assert_eq!(zip_attachment.image_data_url, None);
            assert_eq!(audio_attachment.preview_text, None);
            assert_eq!(audio_attachment.image_data_url, None);

            let (_, stored_zip_bytes) =
                load_attachment_bytes(&connection, &zip_attachment.id).expect("zip bytes should load");
            let (_, stored_audio_bytes) = load_attachment_bytes(&connection, &audio_attachment.id)
                .expect("audio bytes should load");
            assert_eq!(stored_zip_bytes, zip_bytes);
            assert_eq!(stored_audio_bytes, audio_bytes);
        });
    }

    #[test]
    fn copies_attachment_to_destination_path() {
        with_temp_storage_root("copy", |_| {
            let mut connection = in_memory_connection();
            let task_id = create_task_record(&mut connection);
            let root = default_orchestra_root().expect("orchestra root");
            let download_dir =
                task_attachments_dir(&root, DEFAULT_PROJECT_ID, &format!("{task_id}-downloads"));
            if download_dir.exists() {
                fs::remove_dir_all(&download_dir).ok();
            }
            let destination_path = download_dir.join("copied.bin");
            let source_bytes = vec![0_u8, 159, 255, 42, 7];
            let attachment = add_task_attachment(
                &mut connection,
                &task_id,
                TaskAttachmentInput {
                    file_name: "payload.bin".into(),
                    media_type: "application/octet-stream".into(),
                    base64_data: STANDARD.encode(&source_bytes),
                    caption: None,
                },
            )
            .expect("add attachment");

            let copied_attachment =
                copy_attachment_to_path(&connection, &attachment.id, &destination_path)
                    .expect("copy attachment");
            assert_eq!(copied_attachment.file_name, "payload.bin");
            assert_eq!(
                fs::read(&destination_path).expect("read copied attachment"),
                source_bytes
            );
        });
    }

    #[test]
    fn content_disposition_file_name_strips_header_unsafe_characters() {
        assert_eq!(
            content_disposition_file_name("quoted\"name\n.txt"),
            "quoted_name_.txt"
        );
    }
}
