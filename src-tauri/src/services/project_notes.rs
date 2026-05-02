use std::{
    fs,
    path::{Path, PathBuf},
};

use rusqlite::Connection;
use uuid::Uuid;

use crate::{
    models::{NoteDetail, NoteLocation, NoteTreeNode, NotesRoot, NotesTree},
    services::{
        orchestra_paths::{default_orchestra_root, managed_repository_checkout_dir, project_root},
        projects,
    },
};

pub fn list_notes(connection: &Connection, project_id: &str) -> Result<NotesTree, String> {
    list_project_notes(connection, project_id)
}

pub fn get_note(
    connection: &Connection,
    project_id: &str,
    location: &NoteLocation,
) -> Result<NoteDetail, String> {
    get_project_note(connection, project_id, location.clone())
}

pub fn update_note(
    connection: &Connection,
    project_id: &str,
    location: &NoteLocation,
    markdown: &str,
) -> Result<NoteDetail, String> {
    update_project_note(
        connection,
        project_id,
        location.clone(),
        markdown.to_string(),
    )
}

pub fn delete_note(
    connection: &Connection,
    project_id: &str,
    location: &NoteLocation,
) -> Result<NoteLocation, String> {
    delete_project_note(connection, project_id, location.clone())
}

pub fn copy_note(
    connection: &Connection,
    project_id: &str,
    source: &NoteLocation,
    destination: &NoteLocation,
) -> Result<NoteDetail, String> {
    copy_project_note(connection, project_id, source.clone(), destination.clone())
}

pub fn move_note(
    connection: &Connection,
    project_id: &str,
    source: &NoteLocation,
    destination: &NoteLocation,
) -> Result<NoteDetail, String> {
    move_project_note(connection, project_id, source.clone(), destination.clone())
}

pub fn create_directory(
    connection: &Connection,
    project_id: &str,
    location: &NoteLocation,
) -> Result<NoteLocation, String> {
    create_project_notes_directory(connection, project_id, location.clone())
}

pub fn delete_directory(
    connection: &Connection,
    project_id: &str,
    location: &NoteLocation,
) -> Result<NoteLocation, String> {
    delete_project_notes_directory(connection, project_id, location.clone())
}

pub fn copy_directory(
    connection: &Connection,
    project_id: &str,
    source: &NoteLocation,
    destination: &NoteLocation,
) -> Result<NoteLocation, String> {
    copy_project_notes_directory(connection, project_id, source.clone(), destination.clone())
}

pub fn move_directory(
    connection: &Connection,
    project_id: &str,
    source: &NoteLocation,
    destination: &NoteLocation,
) -> Result<NoteLocation, String> {
    move_project_notes_directory(connection, project_id, source.clone(), destination.clone())
}

pub fn list_project_notes(connection: &Connection, project_id: &str) -> Result<NotesTree, String> {
    let project = projects::get_project(connection, project_id)?;
    let orchestra_root = default_orchestra_root()?;
    let mut roots = vec![build_notes_root(
        "Project",
        NoteLocation {
            scope: "project".into(),
            repository_id: None,
            path: String::new(),
        },
        &resolve_scope_root(
            connection,
            project_id,
            &NoteLocation {
                scope: "project".into(),
                repository_id: None,
                path: String::new(),
            },
        )?,
    )?];

    let mut repositories = project.repositories;
    repositories.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    for repository in repositories {
        let checkout_root = repository
            .repository_path
            .clone()
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                managed_repository_checkout_dir(&orchestra_root, &project.slug, &repository.slug)
            });
        roots.push(build_notes_root(
            &repository.name,
            NoteLocation {
                scope: "repository".into(),
                repository_id: Some(repository.id.clone()),
                path: String::new(),
            },
            &checkout_root.join("docs"),
        )?);
    }

    Ok(NotesTree {
        project_id: project.id,
        roots,
    })
}

pub fn get_project_note(
    connection: &Connection,
    project_id: &str,
    location: NoteLocation,
) -> Result<NoteDetail, String> {
    let normalized = normalize_note_location(&location, true, true)?;
    let path = resolve_location_path(connection, project_id, &normalized)?;
    match fs::read_to_string(&path) {
        Ok(markdown) => Ok(NoteDetail {
            location: normalized,
            markdown,
            exists: true,
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(NoteDetail {
            location: normalized,
            markdown: String::new(),
            exists: false,
        }),
        Err(error) => Err(format!("Unable to read note {}: {error}", path.display())),
    }
}

pub fn update_project_note(
    connection: &Connection,
    project_id: &str,
    location: NoteLocation,
    markdown: String,
) -> Result<NoteDetail, String> {
    let normalized = normalize_note_location(&location, true, true)?;
    let path = resolve_location_path(connection, project_id, &normalized)?;
    write_file_atomically(&path, &markdown)?;
    Ok(NoteDetail {
        location: normalized,
        markdown,
        exists: true,
    })
}

pub fn delete_project_note(
    connection: &Connection,
    project_id: &str,
    location: NoteLocation,
) -> Result<NoteLocation, String> {
    let normalized = normalize_note_location(&location, true, true)?;
    let path = resolve_location_path(connection, project_id, &normalized)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(normalized),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(normalized),
        Err(error) => Err(format!("Unable to delete note {}: {error}", path.display())),
    }
}

pub fn copy_project_note(
    connection: &Connection,
    project_id: &str,
    source: NoteLocation,
    destination: NoteLocation,
) -> Result<NoteDetail, String> {
    let normalized_source = normalize_note_location(&source, true, true)?;
    let normalized_destination = normalize_note_location(&destination, true, true)?;
    let source_path = resolve_location_path(connection, project_id, &normalized_source)?;
    let destination_path = resolve_location_path(connection, project_id, &normalized_destination)?;
    let markdown = fs::read_to_string(&source_path).map_err(|error| {
        format!(
            "Unable to read source note {}: {error}",
            source_path.display()
        )
    })?;
    write_file_atomically(&destination_path, &markdown)?;
    Ok(NoteDetail {
        location: normalized_destination,
        markdown,
        exists: true,
    })
}

pub fn move_project_note(
    connection: &Connection,
    project_id: &str,
    source: NoteLocation,
    destination: NoteLocation,
) -> Result<NoteDetail, String> {
    let normalized_source = normalize_note_location(&source, true, true)?;
    let normalized_destination = normalize_note_location(&destination, true, true)?;
    let copied = copy_project_note(
        connection,
        project_id,
        normalized_source.clone(),
        normalized_destination.clone(),
    )?;
    delete_project_note(connection, project_id, normalized_source)?;
    Ok(copied)
}

pub fn create_project_notes_directory(
    connection: &Connection,
    project_id: &str,
    location: NoteLocation,
) -> Result<NoteLocation, String> {
    let normalized = normalize_note_location(&location, true, false)?;
    if normalized.path.is_empty() {
        return Ok(normalized);
    }
    let path = resolve_location_path(connection, project_id, &normalized)?;
    fs::create_dir_all(&path).map_err(|error| {
        format!(
            "Unable to create note directory {}: {error}",
            path.display()
        )
    })?;
    Ok(normalized)
}

pub fn delete_project_notes_directory(
    connection: &Connection,
    project_id: &str,
    location: NoteLocation,
) -> Result<NoteLocation, String> {
    let normalized = normalize_note_location(&location, false, false)?;
    let path = resolve_location_path(connection, project_id, &normalized)?;
    match fs::remove_dir_all(&path) {
        Ok(()) => Ok(normalized),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(normalized),
        Err(error) => Err(format!(
            "Unable to delete note directory {}: {error}",
            path.display()
        )),
    }
}

pub fn copy_project_notes_directory(
    connection: &Connection,
    project_id: &str,
    source: NoteLocation,
    destination: NoteLocation,
) -> Result<NoteLocation, String> {
    let normalized_source = normalize_note_location(&source, false, false)?;
    let normalized_destination = normalize_note_location(&destination, false, false)?;
    validate_directory_move(&normalized_source, &normalized_destination)?;
    let source_path = resolve_location_path(connection, project_id, &normalized_source)?;
    let destination_path = resolve_location_path(connection, project_id, &normalized_destination)?;
    copy_directory_recursively(&source_path, &destination_path)?;
    Ok(normalized_destination)
}

pub fn move_project_notes_directory(
    connection: &Connection,
    project_id: &str,
    source: NoteLocation,
    destination: NoteLocation,
) -> Result<NoteLocation, String> {
    let normalized_source = normalize_note_location(&source, false, false)?;
    let normalized_destination = normalize_note_location(&destination, false, false)?;
    validate_directory_move(&normalized_source, &normalized_destination)?;
    copy_project_notes_directory(
        connection,
        project_id,
        normalized_source.clone(),
        normalized_destination.clone(),
    )?;
    delete_project_notes_directory(connection, project_id, normalized_source)?;
    Ok(normalized_destination)
}

fn build_notes_root(
    label: &str,
    location: NoteLocation,
    docs_root: &Path,
) -> Result<NotesRoot, String> {
    Ok(NotesRoot {
        scope: location.scope,
        repository_id: location.repository_id,
        label: label.to_string(),
        docs_exists: docs_root.exists(),
        children: list_tree_nodes(docs_root, "")?,
    })
}

fn list_tree_nodes(root: &Path, relative_path: &str) -> Result<Vec<NoteTreeNode>, String> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut directories = Vec::new();
    let mut notes = Vec::new();
    for entry in fs::read_dir(root)
        .map_err(|error| format!("Unable to read notes directory {}: {error}", root.display()))?
    {
        let entry = entry.map_err(|error| format!("Unable to read notes entry: {error}"))?;
        let file_type = entry.file_type().map_err(|error| {
            format!(
                "Unable to inspect notes entry {}: {error}",
                entry.path().display()
            )
        })?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let path = if relative_path.is_empty() {
            name.clone()
        } else {
            format!("{relative_path}/{name}")
        };
        if file_type.is_dir() {
            directories.push(NoteTreeNode {
                kind: "directory".into(),
                name: name.clone(),
                path: path.clone(),
                children: Some(list_tree_nodes(&entry.path(), &path)?),
            });
        } else if file_type.is_file() && name.to_lowercase().ends_with(".md") {
            notes.push(NoteTreeNode {
                kind: "note".into(),
                name,
                path,
                children: None,
            });
        }
    }
    directories.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    notes.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    directories.extend(notes);
    Ok(directories)
}

fn resolve_scope_root(
    connection: &Connection,
    project_id: &str,
    location: &NoteLocation,
) -> Result<PathBuf, String> {
    let project = projects::get_project(connection, project_id)?;
    let orchestra_root = default_orchestra_root()?;
    if location.scope == "project" {
        return Ok(project_root(&orchestra_root, &project.slug).join("docs"));
    }

    let repository_id = location
        .repository_id
        .as_deref()
        .ok_or_else(|| "repositoryId: Repository notes require repositoryId.".to_string())?;
    let repository = project
        .repositories
        .iter()
        .find(|entry| entry.id == repository_id)
        .ok_or_else(|| {
            format!("Repository {repository_id} does not belong to project {project_id}")
        })?;
    let checkout_root = repository
        .repository_path
        .clone()
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            managed_repository_checkout_dir(&orchestra_root, &project.slug, &repository.slug)
        });
    Ok(checkout_root.join("docs"))
}

fn resolve_location_path(
    connection: &Connection,
    project_id: &str,
    location: &NoteLocation,
) -> Result<PathBuf, String> {
    let root = resolve_scope_root(connection, project_id, location)?;
    if location.path.is_empty() {
        return Ok(root);
    }
    Ok(root.join(location.path.split('/').collect::<PathBuf>()))
}

fn normalize_note_location(
    location: &NoteLocation,
    allow_empty: bool,
    require_markdown: bool,
) -> Result<NoteLocation, String> {
    let scope = match location.scope.trim() {
        "project" => "project",
        "repository" => "repository",
        other => return Err(format!("scope: Unsupported note scope {other}.")),
    };
    let repository_id = location
        .repository_id
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if scope == "repository" && repository_id.is_none() {
        return Err("repositoryId: Repository notes require repositoryId.".into());
    }
    let path = normalize_relative_docs_path(&location.path, allow_empty, require_markdown)?;
    Ok(NoteLocation {
        scope: scope.into(),
        repository_id: repository_id,
        path,
    })
}

fn normalize_relative_docs_path(
    value: &str,
    allow_empty: bool,
    require_markdown: bool,
) -> Result<String, String> {
    let trimmed = value.trim().replace('\\', "/");
    if trimmed.is_empty() {
        if allow_empty {
            return Ok(String::new());
        }
        return Err("path: Path is required.".into());
    }
    if trimmed.starts_with('/') || trimmed.starts_with("~/") {
        return Err("path: Paths must stay relative to docs/.".into());
    }
    let mut parts = Vec::new();
    for part in trimmed.split('/') {
        let part = part.trim();
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err("path: Paths must stay inside docs/.".into());
        }
        parts.push(part);
    }
    if parts.is_empty() && !allow_empty {
        return Err("path: Path is required.".into());
    }
    let normalized = parts.join("/");
    if require_markdown && !normalized.to_lowercase().ends_with(".md") {
        return Err("path: Note paths must end with .md.".into());
    }
    Ok(normalized)
}

fn validate_directory_move(
    source: &NoteLocation,
    destination: &NoteLocation,
) -> Result<(), String> {
    if source.path.is_empty() {
        return Err("path: Root docs directories cannot be copied or moved as directories.".into());
    }
    if source.scope == destination.scope
        && source.repository_id == destination.repository_id
        && (destination.path == source.path
            || destination.path.starts_with(&format!("{}/", source.path)))
    {
        return Err("path: Destination cannot be the same directory or a descendant of the source directory.".into());
    }
    Ok(())
}

fn write_file_atomically(path: &Path, markdown: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Path {} has no parent directory", path.display()))?;
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "Unable to create note directory {}: {error}",
            parent.display()
        )
    })?;
    let temp_path = parent.join(format!(
        ".{}.tmp-{}-{}",
        path.file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("note.md"),
        std::process::id(),
        Uuid::new_v4().simple()
    ));
    fs::write(&temp_path, markdown).map_err(|error| {
        format!(
            "Unable to write note temp file {}: {error}",
            temp_path.display()
        )
    })?;
    if path.exists() {
        fs::remove_file(path)
            .map_err(|error| format!("Unable to replace note {}: {error}", path.display()))?;
    }
    fs::rename(&temp_path, path).map_err(|error| {
        format!(
            "Unable to move note temp file {} into place at {}: {error}",
            temp_path.display(),
            path.display()
        )
    })?;
    Ok(())
}

fn copy_directory_recursively(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.exists() {
        return Err(format!(
            "Source directory {} was not found.",
            source.display()
        ));
    }
    fs::create_dir_all(destination).map_err(|error| {
        format!(
            "Unable to create destination directory {}: {error}",
            destination.display()
        )
    })?;
    for entry in fs::read_dir(source).map_err(|error| {
        format!(
            "Unable to read source directory {}: {error}",
            source.display()
        )
    })? {
        let entry = entry.map_err(|error| format!("Unable to read directory entry: {error}"))?;
        let file_type = entry.file_type().map_err(|error| {
            format!(
                "Unable to inspect directory entry {}: {error}",
                entry.path().display()
            )
        })?;
        let entry_name = entry.file_name();
        let source_path = entry.path();
        let destination_path = destination.join(entry_name);
        if file_type.is_dir() {
            copy_directory_recursively(&source_path, &destination_path)?;
        } else if file_type.is_file() {
            if let Some(parent) = destination_path.parent() {
                fs::create_dir_all(parent).map_err(|error| {
                    format!(
                        "Unable to create destination directory {}: {error}",
                        parent.display()
                    )
                })?;
            }
            fs::copy(&source_path, &destination_path).map_err(|error| {
                format!(
                    "Unable to copy {} to {}: {error}",
                    source_path.display(),
                    destination_path.display()
                )
            })?;
        }
    }
    Ok(())
}
