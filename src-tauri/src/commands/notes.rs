use tauri::State;

use crate::{
    models::{AuthorizationContext, NoteDetail, NoteLocation, NotesTree},
    services::{command_authorization, database, project_notes},
    state::AppState,
};

#[tauri::command]
pub fn list_project_notes(
    project_id: String,
    authorization: Option<AuthorizationContext>,
) -> Result<NotesTree, String> {
    let connection = database::open_connection()?;
    command_authorization::require_permission(&connection, authorization.as_ref(), "notes.read")?;
    project_notes::list_project_notes(&connection, &project_id)
}

#[tauri::command]
pub fn get_project_note(
    project_id: String,
    location: NoteLocation,
    authorization: Option<AuthorizationContext>,
) -> Result<NoteDetail, String> {
    let connection = database::open_connection()?;
    command_authorization::require_permission(&connection, authorization.as_ref(), "notes.read")?;
    project_notes::get_project_note(&connection, &project_id, location)
}

#[tauri::command]
pub fn update_project_note(
    state: State<'_, AppState>,
    project_id: String,
    location: NoteLocation,
    markdown: String,
    authorization: Option<AuthorizationContext>,
) -> Result<NoteDetail, String> {
    let connection = database::open_connection()?;
    command_authorization::require_permission(&connection, authorization.as_ref(), "notes.write")?;
    let note = project_notes::update_project_note(&connection, &project_id, location, markdown)?;
    state.log(
        "info",
        "notes.updated",
        &format!(
            "Updated note {} in project {}",
            note.location.path, project_id
        ),
    );
    Ok(note)
}

#[tauri::command]
pub fn delete_project_note(
    state: State<'_, AppState>,
    project_id: String,
    location: NoteLocation,
    authorization: Option<AuthorizationContext>,
) -> Result<NoteLocation, String> {
    let connection = database::open_connection()?;
    command_authorization::require_permission(&connection, authorization.as_ref(), "notes.write")?;
    let deleted = project_notes::delete_project_note(&connection, &project_id, location)?;
    state.log(
        "info",
        "notes.deleted",
        &format!("Deleted note {} in project {}", deleted.path, project_id),
    );
    Ok(deleted)
}

#[tauri::command]
pub fn copy_project_note(
    state: State<'_, AppState>,
    project_id: String,
    source: NoteLocation,
    destination: NoteLocation,
    authorization: Option<AuthorizationContext>,
) -> Result<NoteDetail, String> {
    let connection = database::open_connection()?;
    command_authorization::require_permission(&connection, authorization.as_ref(), "notes.write")?;
    let note = project_notes::copy_project_note(&connection, &project_id, source, destination)?;
    state.log(
        "info",
        "notes.copied",
        &format!(
            "Copied note {} in project {}",
            note.location.path, project_id
        ),
    );
    Ok(note)
}

#[tauri::command]
pub fn move_project_note(
    state: State<'_, AppState>,
    project_id: String,
    source: NoteLocation,
    destination: NoteLocation,
    authorization: Option<AuthorizationContext>,
) -> Result<NoteDetail, String> {
    let connection = database::open_connection()?;
    command_authorization::require_permission(&connection, authorization.as_ref(), "notes.write")?;
    let note = project_notes::move_project_note(&connection, &project_id, source, destination)?;
    state.log(
        "info",
        "notes.moved",
        &format!(
            "Moved note {} in project {}",
            note.location.path, project_id
        ),
    );
    Ok(note)
}

#[tauri::command]
pub fn create_project_notes_directory(
    state: State<'_, AppState>,
    project_id: String,
    location: NoteLocation,
    authorization: Option<AuthorizationContext>,
) -> Result<NoteLocation, String> {
    let connection = database::open_connection()?;
    command_authorization::require_permission(&connection, authorization.as_ref(), "notes.write")?;
    let directory =
        project_notes::create_project_notes_directory(&connection, &project_id, location)?;
    state.log(
        "info",
        "notes.directory_created",
        &format!(
            "Created note directory {} in project {}",
            directory.path, project_id
        ),
    );
    Ok(directory)
}

#[tauri::command]
pub fn delete_project_notes_directory(
    state: State<'_, AppState>,
    project_id: String,
    location: NoteLocation,
    authorization: Option<AuthorizationContext>,
) -> Result<NoteLocation, String> {
    let connection = database::open_connection()?;
    command_authorization::require_permission(&connection, authorization.as_ref(), "notes.write")?;
    let directory =
        project_notes::delete_project_notes_directory(&connection, &project_id, location)?;
    state.log(
        "info",
        "notes.directory_deleted",
        &format!(
            "Deleted note directory {} in project {}",
            directory.path, project_id
        ),
    );
    Ok(directory)
}

#[tauri::command]
pub fn copy_project_notes_directory(
    state: State<'_, AppState>,
    project_id: String,
    source: NoteLocation,
    destination: NoteLocation,
    authorization: Option<AuthorizationContext>,
) -> Result<NoteLocation, String> {
    let connection = database::open_connection()?;
    command_authorization::require_permission(&connection, authorization.as_ref(), "notes.write")?;
    let directory =
        project_notes::copy_project_notes_directory(&connection, &project_id, source, destination)?;
    state.log(
        "info",
        "notes.directory_copied",
        &format!(
            "Copied note directory {} in project {}",
            directory.path, project_id
        ),
    );
    Ok(directory)
}

#[tauri::command]
pub fn move_project_notes_directory(
    state: State<'_, AppState>,
    project_id: String,
    source: NoteLocation,
    destination: NoteLocation,
    authorization: Option<AuthorizationContext>,
) -> Result<NoteLocation, String> {
    let connection = database::open_connection()?;
    command_authorization::require_permission(&connection, authorization.as_ref(), "notes.write")?;
    let directory =
        project_notes::move_project_notes_directory(&connection, &project_id, source, destination)?;
    state.log(
        "info",
        "notes.directory_moved",
        &format!(
            "Moved note directory {} in project {}",
            directory.path, project_id
        ),
    );
    Ok(directory)
}
