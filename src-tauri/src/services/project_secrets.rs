use std::path::Path;
#[cfg(test)]
use std::{collections::HashMap, sync::Arc, sync::LazyLock, sync::Mutex, sync::MutexGuard};

use chrono::Utc;
use keyring::Entry;
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    models::{
        ProjectSecretMetadata, ProjectSecretUpsertInput, ProjectSecretValueResult,
        ProjectSecretsAvailability, ProjectSecretsState,
    },
    services::{database, orchestra_paths::default_orchestra_root, projects},
};

const PROJECT_SECRET_SERVICE: &str = "io.hnsn.orchestra.project-secret.v1";
const RESERVED_SECRET_KEYS: &[&str] = &["PATH", "HOME", "SHELL", "TERM"];
const RESERVED_SECRET_PREFIXES: &[&str] = &[
    "ORCHESTRA_",
    "PI_",
    "NPM_",
    "NPM_CONFIG_",
    "NPM_PACKAGE_",
    "NPM_LIFECYCLE_",
];

#[derive(Debug, Clone)]
struct StoredProjectSecretMetadata {
    id: String,
    project_id: String,
    secret_key: String,
    description: Option<String>,
    created_at: String,
    updated_at: String,
    last_rotated_at: String,
}

#[derive(Debug, Clone, Default)]
pub struct ProjectSecretMetadataFilter {
    pub query: Option<String>,
    pub secret_key: Option<String>,
    pub value_state: Option<String>,
    pub has_description: Option<bool>,
}

#[derive(Debug, Clone)]
enum SecretStoreErrorKind {
    Unsupported,
    Locked,
    Other,
}

#[derive(Debug, Clone)]
struct SecretStoreError {
    kind: SecretStoreErrorKind,
    message: String,
}

trait ProjectSecretStore: Send + Sync {
    fn availability(&self) -> ProjectSecretsAvailability;
    fn get_value(&self, service: &str, account: &str) -> Result<Option<String>, SecretStoreError>;
    fn set_value(&self, service: &str, account: &str, value: &str) -> Result<(), SecretStoreError>;
    fn delete_value(&self, service: &str, account: &str) -> Result<(), SecretStoreError>;
}

#[cfg(test)]
static TEST_PROJECT_SECRET_STORE: LazyLock<Mutex<Option<Arc<dyn ProjectSecretStore>>>> =
    LazyLock::new(|| Mutex::new(None));
#[cfg(test)]
static TEST_PROJECT_SECRET_STORE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

#[cfg(test)]
pub(crate) struct ScopedTestProjectSecretStore {
    _guard: MutexGuard<'static, ()>,
}

#[cfg(test)]
impl ScopedTestProjectSecretStore {
    pub(crate) fn install(store: Arc<TestProjectSecretStore>) -> Self {
        let guard = TEST_PROJECT_SECRET_STORE_LOCK
            .lock()
            .expect("test project secret store lock should acquire");
        *TEST_PROJECT_SECRET_STORE
            .lock()
            .expect("test project secret store should lock") = Some(store);
        Self { _guard: guard }
    }
}

#[cfg(test)]
impl Drop for ScopedTestProjectSecretStore {
    fn drop(&mut self) {
        *TEST_PROJECT_SECRET_STORE
            .lock()
            .expect("test project secret store should lock") = None;
    }
}

#[cfg(test)]
pub(crate) struct TestProjectSecretStore {
    availability: ProjectSecretsAvailability,
    values: Mutex<HashMap<String, String>>,
    get_error: Mutex<Option<SecretStoreError>>,
    set_error: Mutex<Option<SecretStoreError>>,
    delete_error: Mutex<Option<SecretStoreError>>,
}

#[cfg(test)]
impl TestProjectSecretStore {
    pub(crate) fn new(status: &str) -> Self {
        Self {
            availability: availability(status, None),
            values: Mutex::new(HashMap::new()),
            get_error: Mutex::new(None),
            set_error: Mutex::new(None),
            delete_error: Mutex::new(None),
        }
    }

    fn key(service: &str, account: &str) -> String {
        format!("{service}::{account}")
    }
}

#[cfg(test)]
impl ProjectSecretStore for TestProjectSecretStore {
    fn availability(&self) -> ProjectSecretsAvailability {
        self.availability.clone()
    }

    fn get_value(&self, service: &str, account: &str) -> Result<Option<String>, SecretStoreError> {
        if let Some(error) = self.get_error.lock().expect("get error lock").clone() {
            return Err(error);
        }
        Ok(self
            .values
            .lock()
            .expect("values lock")
            .get(&Self::key(service, account))
            .cloned())
    }

    fn set_value(&self, service: &str, account: &str, value: &str) -> Result<(), SecretStoreError> {
        if let Some(error) = self.set_error.lock().expect("set error lock").clone() {
            return Err(error);
        }
        self.values
            .lock()
            .expect("values lock")
            .insert(Self::key(service, account), value.into());
        Ok(())
    }

    fn delete_value(&self, service: &str, account: &str) -> Result<(), SecretStoreError> {
        if let Some(error) = self.delete_error.lock().expect("delete error lock").clone() {
            return Err(error);
        }
        self.values
            .lock()
            .expect("values lock")
            .remove(&Self::key(service, account));
        Ok(())
    }
}

struct KeyringProjectSecretStore;

impl KeyringProjectSecretStore {
    fn entry(&self, service: &str, account: &str) -> Result<Entry, SecretStoreError> {
        Entry::new(service, account).map_err(|error| classify_store_error(error.to_string()))
    }
}

impl ProjectSecretStore for KeyringProjectSecretStore {
    fn availability(&self) -> ProjectSecretsAvailability {
        match self.entry(PROJECT_SECRET_SERVICE, "availability-probe") {
            Ok(_) => availability("available", None),
            Err(error) => availability_status_for_error(&error),
        }
    }

    fn get_value(&self, service: &str, account: &str) -> Result<Option<String>, SecretStoreError> {
        let entry = self.entry(service, account)?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(error) => {
                let classified = classify_store_error(error.to_string());
                if classified.message.to_lowercase().contains("no entry")
                    || classified.message.to_lowercase().contains("not found")
                    || classified.message.to_lowercase().contains("no matching")
                {
                    Ok(None)
                } else {
                    Err(classified)
                }
            }
        }
    }

    fn set_value(&self, service: &str, account: &str, value: &str) -> Result<(), SecretStoreError> {
        let entry = self.entry(service, account)?;
        entry
            .set_password(value)
            .map_err(|error| classify_store_error(error.to_string()))
    }

    fn delete_value(&self, service: &str, account: &str) -> Result<(), SecretStoreError> {
        let entry = self.entry(service, account)?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(error) => {
                let classified = classify_store_error(error.to_string());
                if classified.message.to_lowercase().contains("no entry")
                    || classified.message.to_lowercase().contains("not found")
                    || classified.message.to_lowercase().contains("no matching")
                {
                    Ok(())
                } else {
                    Err(classified)
                }
            }
        }
    }
}

fn current_project_secret_store() -> std::sync::Arc<dyn ProjectSecretStore> {
    #[cfg(test)]
    if let Some(store) = TEST_PROJECT_SECRET_STORE
        .lock()
        .expect("test project secret store should lock")
        .clone()
    {
        return store;
    }

    std::sync::Arc::new(KeyringProjectSecretStore)
}

fn availability(status: &str, message: Option<String>) -> ProjectSecretsAvailability {
    ProjectSecretsAvailability {
        status: status.into(),
        message,
    }
}

fn classify_store_error(message: String) -> SecretStoreError {
    let normalized = message.to_lowercase();
    let kind = if normalized.contains("no secure storage")
        || normalized.contains("platform secure storage")
        || normalized.contains("unsupported")
        || normalized.contains("storage provider")
    {
        SecretStoreErrorKind::Unsupported
    } else if normalized.contains("locked")
        || normalized.contains("interaction is not allowed")
        || normalized.contains("user interaction")
        || normalized.contains("temporarily unavailable")
    {
        SecretStoreErrorKind::Locked
    } else {
        SecretStoreErrorKind::Other
    };
    SecretStoreError { kind, message }
}

fn availability_status_for_error(error: &SecretStoreError) -> ProjectSecretsAvailability {
    match error.kind {
        SecretStoreErrorKind::Unsupported => {
            availability("unsupported", Some(error.message.clone()))
        }
        SecretStoreErrorKind::Locked => availability("locked", Some(error.message.clone())),
        SecretStoreErrorKind::Other => availability("error", Some(error.message.clone())),
    }
}

pub fn get_project_secrets(project_slug: &str) -> Result<ProjectSecretsState, String> {
    let orchestra_root = default_orchestra_root()?;
    get_project_secrets_in(&orchestra_root, project_slug)
}

pub fn get_project_secrets_in(
    orchestra_root: &Path,
    project_slug: &str,
) -> Result<ProjectSecretsState, String> {
    let connection = database::open_connection_at(
        &crate::services::orchestra_paths::orchestra_database_path(orchestra_root),
    )?;
    get_project_secrets_with_connection(&connection, Some(orchestra_root), project_slug)
}

pub(crate) fn get_project_secrets_with_connection(
    connection: &Connection,
    orchestra_root: Option<&Path>,
    project_slug: &str,
) -> Result<ProjectSecretsState, String> {
    let store = current_project_secret_store();
    get_project_secrets_with_store(connection, orchestra_root, project_slug, store.as_ref())
}

pub fn search_project_secrets(
    project_slug: &str,
    filter: ProjectSecretMetadataFilter,
) -> Result<ProjectSecretsState, String> {
    let orchestra_root = default_orchestra_root()?;
    let connection = database::open_connection_at(
        &crate::services::orchestra_paths::orchestra_database_path(&orchestra_root),
    )?;
    let store = current_project_secret_store();
    search_project_secrets_with_store(
        &connection,
        Some(&orchestra_root),
        project_slug,
        &filter,
        store.as_ref(),
    )
}

pub(crate) fn search_project_secrets_with_connection(
    connection: &Connection,
    orchestra_root: Option<&Path>,
    project_slug: &str,
    filter: &ProjectSecretMetadataFilter,
) -> Result<ProjectSecretsState, String> {
    let store = current_project_secret_store();
    search_project_secrets_with_store(
        connection,
        orchestra_root,
        project_slug,
        filter,
        store.as_ref(),
    )
}

fn get_project_secrets_with_store(
    connection: &Connection,
    orchestra_root: Option<&Path>,
    project_slug: &str,
    store: &dyn ProjectSecretStore,
) -> Result<ProjectSecretsState, String> {
    let project = projects::get_project_by_slug(connection, project_slug)?
        .ok_or_else(|| format!("Project slug {project_slug} was not found"))?;
    let metadata = load_project_secret_metadata(connection, &project.id)?;
    let mut availability_state = store.availability();
    let secrets = metadata
        .into_iter()
        .map(|entry| {
            let account = secure_store_account(orchestra_root, &project.id, &entry.secret_key);
            let (value_state, value_state_message) =
                match store.get_value(PROJECT_SECRET_SERVICE, &account) {
                    Ok(Some(_)) => ("ready".to_string(), None),
                    Ok(None) => ("missing_value".to_string(), None),
                    Err(error) => {
                        if availability_state.status == "available" {
                            availability_state = availability_status_for_error(&error);
                        }
                        match error.kind {
                            SecretStoreErrorKind::Locked => {
                                ("store_locked".to_string(), Some(error.message))
                            }
                            SecretStoreErrorKind::Unsupported | SecretStoreErrorKind::Other => {
                                ("store_error".to_string(), Some(error.message))
                            }
                        }
                    }
                };
            ProjectSecretMetadata {
                id: entry.id,
                project_id: entry.project_id,
                project_slug: project.slug.clone(),
                secret_key: entry.secret_key,
                description: entry.description,
                created_at: entry.created_at,
                updated_at: entry.updated_at,
                last_rotated_at: entry.last_rotated_at,
                value_state,
                value_state_message,
            }
        })
        .collect::<Vec<_>>();

    Ok(ProjectSecretsState {
        project_slug: project.slug,
        availability: availability_state,
        secrets,
    })
}

fn search_project_secrets_with_store(
    connection: &Connection,
    orchestra_root: Option<&Path>,
    project_slug: &str,
    filter: &ProjectSecretMetadataFilter,
    store: &dyn ProjectSecretStore,
) -> Result<ProjectSecretsState, String> {
    let mut state =
        get_project_secrets_with_store(connection, orchestra_root, project_slug, store)?;
    state.secrets = filter_project_secret_metadata(state.secrets, filter)?;
    Ok(state)
}

pub fn create_project_secret(
    project_slug: &str,
    input: ProjectSecretUpsertInput,
) -> Result<ProjectSecretsState, String> {
    let orchestra_root = default_orchestra_root()?;
    let connection = database::open_connection_at(
        &crate::services::orchestra_paths::orchestra_database_path(&orchestra_root),
    )?;
    let store = current_project_secret_store();
    write_project_secret_with_store(
        &connection,
        Some(&orchestra_root),
        project_slug,
        input,
        SecretWriteMode::Create,
        store.as_ref(),
    )
}

pub fn update_project_secret(
    project_slug: &str,
    input: ProjectSecretUpsertInput,
) -> Result<ProjectSecretsState, String> {
    let orchestra_root = default_orchestra_root()?;
    let connection = database::open_connection_at(
        &crate::services::orchestra_paths::orchestra_database_path(&orchestra_root),
    )?;
    let store = current_project_secret_store();
    write_project_secret_with_store(
        &connection,
        Some(&orchestra_root),
        project_slug,
        input,
        SecretWriteMode::Update,
        store.as_ref(),
    )
}

pub fn delete_project_secret(
    project_slug: &str,
    secret_key: &str,
) -> Result<ProjectSecretsState, String> {
    let orchestra_root = default_orchestra_root()?;
    let connection = database::open_connection_at(
        &crate::services::orchestra_paths::orchestra_database_path(&orchestra_root),
    )?;
    let store = current_project_secret_store();
    delete_project_secret_with_store(
        &connection,
        Some(&orchestra_root),
        project_slug,
        secret_key,
        store.as_ref(),
    )
}

pub fn get_project_secret_value(
    project_slug: &str,
    secret_key: &str,
) -> Result<ProjectSecretValueResult, String> {
    let orchestra_root = default_orchestra_root()?;
    let connection = database::open_connection_at(
        &crate::services::orchestra_paths::orchestra_database_path(&orchestra_root),
    )?;
    let store = current_project_secret_store();
    get_project_secret_value_with_store(
        &connection,
        Some(&orchestra_root),
        project_slug,
        secret_key,
        store.as_ref(),
    )
}

fn get_project_secret_value_with_store(
    connection: &Connection,
    orchestra_root: Option<&Path>,
    project_slug: &str,
    secret_key: &str,
    store: &dyn ProjectSecretStore,
) -> Result<ProjectSecretValueResult, String> {
    let project = projects::get_project_by_slug(connection, project_slug)?
        .ok_or_else(|| format!("Project slug {project_slug} was not found"))?;
    let normalized_key = normalize_secret_key(secret_key)?;
    load_project_secret_metadata_entry(connection, &project.id, &normalized_key)?.ok_or_else(
        || {
            format!(
                "Project secret {normalized_key} was not found in project {}.",
                project.slug
            )
        },
    )?;
    let account = secure_store_account(orchestra_root, &project.id, &normalized_key);
    let value = store
        .get_value(PROJECT_SECRET_SERVICE, &account)
        .map_err(|error| error.message)?
        .ok_or_else(|| format!("Project secret {normalized_key} is missing a stored value."))?;
    Ok(ProjectSecretValueResult {
        project_slug: project.slug,
        secret_key: normalized_key,
        value,
    })
}

pub(crate) fn cleanup_project_secrets_for_project_id(
    connection: &Connection,
    orchestra_root: Option<&Path>,
    project_id: &str,
) -> Vec<String> {
    let metadata = match load_project_secret_metadata(connection, project_id) {
        Ok(entries) => entries,
        Err(error) => return vec![error],
    };
    let store = current_project_secret_store();
    metadata
        .into_iter()
        .filter_map(|entry| {
            let account = secure_store_account(orchestra_root, project_id, &entry.secret_key);
            store
                .delete_value(PROJECT_SECRET_SERVICE, &account)
                .err()
                .map(|error| format!("{}: {}", entry.secret_key, error.message))
        })
        .collect()
}

enum SecretWriteMode {
    Create,
    Update,
}

fn write_project_secret_with_store(
    connection: &Connection,
    orchestra_root: Option<&Path>,
    project_slug: &str,
    input: ProjectSecretUpsertInput,
    mode: SecretWriteMode,
    store: &dyn ProjectSecretStore,
) -> Result<ProjectSecretsState, String> {
    let project = projects::get_project_by_slug(connection, project_slug)?
        .ok_or_else(|| format!("Project slug {project_slug} was not found"))?;
    let normalized_key = normalize_secret_key(&input.secret_key)?;
    let description = normalize_optional_string(input.description);
    let value = normalize_secret_value(input.value);
    let existing = load_project_secret_metadata_entry(connection, &project.id, &normalized_key)?;

    match mode {
        SecretWriteMode::Create if existing.is_some() => {
            return Err(format!("Project secret {normalized_key} already exists."));
        }
        SecretWriteMode::Update if existing.is_none() => {
            return Err(format!("Project secret {normalized_key} was not found."));
        }
        _ => {}
    }

    if matches!(mode, SecretWriteMode::Create) && value.is_none() {
        return Err("Secret value is required when creating a project secret.".into());
    }

    let now = Utc::now().to_rfc3339();
    let account = secure_store_account(orchestra_root, &project.id, &normalized_key);
    let created_at = existing
        .as_ref()
        .map(|entry| entry.created_at.clone())
        .unwrap_or_else(|| now.clone());
    let last_rotated_at = if let Some(next_value) = value.as_deref() {
        store
            .set_value(PROJECT_SECRET_SERVICE, &account, next_value)
            .map_err(|error| error.message)?;
        now.clone()
    } else {
        existing
            .as_ref()
            .map(|entry| entry.last_rotated_at.clone())
            .unwrap_or_else(|| now.clone())
    };

    let id = existing
        .as_ref()
        .map(|entry| entry.id.clone())
        .unwrap_or_else(|| format!("project-secret-{}", Uuid::new_v4().simple()));

    connection
        .execute(
            r#"
            INSERT INTO project_secret_metadata (
                id,
                project_id,
                secret_key,
                description,
                created_at,
                updated_at,
                last_rotated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(project_id, secret_key) DO UPDATE SET
                description = excluded.description,
                updated_at = excluded.updated_at,
                last_rotated_at = excluded.last_rotated_at
            "#,
            params![
                id,
                project.id,
                normalized_key,
                description,
                created_at,
                now,
                last_rotated_at
            ],
        )
        .map_err(|error| format!("Unable to save project secret metadata: {error}"))?;

    get_project_secrets_with_store(connection, orchestra_root, &project.slug, store)
}

fn delete_project_secret_with_store(
    connection: &Connection,
    orchestra_root: Option<&Path>,
    project_slug: &str,
    secret_key: &str,
    store: &dyn ProjectSecretStore,
) -> Result<ProjectSecretsState, String> {
    let project = projects::get_project_by_slug(connection, project_slug)?
        .ok_or_else(|| format!("Project slug {project_slug} was not found"))?;
    let normalized_key = normalize_secret_key(secret_key)?;
    let existing = load_project_secret_metadata_entry(connection, &project.id, &normalized_key)?
        .ok_or_else(|| format!("Project secret {normalized_key} was not found."))?;
    let account = secure_store_account(orchestra_root, &project.id, &normalized_key);
    store
        .delete_value(PROJECT_SECRET_SERVICE, &account)
        .map_err(|error| error.message)?;
    connection
        .execute(
            "DELETE FROM project_secret_metadata WHERE id = ?1",
            [existing.id],
        )
        .map_err(|error| format!("Unable to delete project secret metadata: {error}"))?;
    get_project_secrets_with_store(connection, orchestra_root, &project.slug, store)
}

fn load_project_secret_metadata(
    connection: &Connection,
    project_id: &str,
) -> Result<Vec<StoredProjectSecretMetadata>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, project_id, secret_key, description, created_at, updated_at, last_rotated_at
            FROM project_secret_metadata
            WHERE project_id = ?1
            ORDER BY secret_key ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare project secret query: {error}"))?;
    let rows = statement
        .query_map([project_id], |row| {
            Ok(StoredProjectSecretMetadata {
                id: row.get(0)?,
                project_id: row.get(1)?,
                secret_key: row.get(2)?,
                description: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
                last_rotated_at: row.get(6)?,
            })
        })
        .map_err(|error| format!("Unable to query project secrets: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to load project secret rows: {error}"))
}

fn load_project_secret_metadata_entry(
    connection: &Connection,
    project_id: &str,
    secret_key: &str,
) -> Result<Option<StoredProjectSecretMetadata>, String> {
    connection
        .query_row(
            r#"
            SELECT id, project_id, secret_key, description, created_at, updated_at, last_rotated_at
            FROM project_secret_metadata
            WHERE project_id = ?1 AND secret_key = ?2
            LIMIT 1
            "#,
            params![project_id, secret_key],
            |row| {
                Ok(StoredProjectSecretMetadata {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    secret_key: row.get(2)?,
                    description: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                    last_rotated_at: row.get(6)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("Unable to query project secret {secret_key}: {error}"))
}

fn filter_project_secret_metadata(
    secrets: Vec<ProjectSecretMetadata>,
    filter: &ProjectSecretMetadataFilter,
) -> Result<Vec<ProjectSecretMetadata>, String> {
    let normalized_query =
        normalize_optional_string(filter.query.clone()).map(|value| value.to_ascii_lowercase());
    let normalized_secret_key = filter
        .secret_key
        .as_deref()
        .map(normalize_secret_key)
        .transpose()?;
    let normalized_value_state = normalize_optional_string(filter.value_state.clone())
        .map(|value| value.to_ascii_lowercase());

    Ok(secrets
        .into_iter()
        .filter(|secret| {
            if let Some(secret_key) = normalized_secret_key.as_deref() {
                if secret.secret_key != secret_key {
                    return false;
                }
            }

            if let Some(value_state) = normalized_value_state.as_deref() {
                if secret.value_state.to_ascii_lowercase() != value_state {
                    return false;
                }
            }

            if let Some(has_description) = filter.has_description {
                let secret_has_description = secret
                    .description
                    .as_deref()
                    .map(str::trim)
                    .is_some_and(|value| !value.is_empty());
                if secret_has_description != has_description {
                    return false;
                }
            }

            if let Some(query) = normalized_query.as_deref() {
                let description_matches = secret
                    .description
                    .as_deref()
                    .map(|value| value.to_ascii_lowercase().contains(query))
                    .unwrap_or(false);
                let value_state_message_matches = secret
                    .value_state_message
                    .as_deref()
                    .map(|value| value.to_ascii_lowercase().contains(query))
                    .unwrap_or(false);
                if !secret.secret_key.to_ascii_lowercase().contains(query)
                    && !description_matches
                    && !secret.value_state.to_ascii_lowercase().contains(query)
                    && !value_state_message_matches
                {
                    return false;
                }
            }

            true
        })
        .collect())
}

fn normalize_secret_key(value: &str) -> Result<String, String> {
    let normalized = value.trim().to_ascii_uppercase();
    if normalized.is_empty() {
        return Err("Secret key is required.".into());
    }
    let mut chars = normalized.chars();
    let Some(first) = chars.next() else {
        return Err("Secret key is required.".into());
    };
    if !first.is_ascii_uppercase() {
        return Err(
            "Secret keys must start with an uppercase letter and contain only A-Z, 0-9, and _."
                .into(),
        );
    }
    if !chars.all(|character| {
        character.is_ascii_uppercase() || character.is_ascii_digit() || character == '_'
    }) {
        return Err(
            "Secret keys must start with an uppercase letter and contain only A-Z, 0-9, and _."
                .into(),
        );
    }
    if RESERVED_SECRET_KEYS.contains(&normalized.as_str())
        || RESERVED_SECRET_PREFIXES
            .iter()
            .any(|prefix| normalized.starts_with(prefix))
    {
        return Err(format!(
            "Secret key {normalized} uses a reserved name or prefix."
        ));
    }
    Ok(normalized)
}

fn normalize_optional_string(value: Option<String>) -> Option<String> {
    value.and_then(|entry| {
        let trimmed = entry.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn normalize_secret_value(value: Option<String>) -> Option<String> {
    value
        .map(|entry| entry.trim_end_matches(['\r', '\n']).to_string())
        .and_then(|entry| if entry.is_empty() { None } else { Some(entry) })
}

fn secure_store_account(
    orchestra_root: Option<&Path>,
    project_id: &str,
    secret_key: &str,
) -> String {
    let fingerprint = orchestra_root
        .map(root_fingerprint)
        .unwrap_or_else(|| "memory".into());
    format!("scope:{fingerprint}:project:{project_id}:secret:{secret_key}",)
}

fn root_fingerprint(orchestra_root: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(orchestra_root.to_string_lossy().as_bytes());
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::database;
    use std::{
        env,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn unique_temp_dir(label: &str) -> PathBuf {
        let suffix = format!(
            "{}-{}-{}-{}",
            label,
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time should move forward")
                .as_millis(),
            Uuid::new_v4().simple(),
        );
        env::temp_dir().join(suffix)
    }

    fn connection_with_project() -> (Connection, PathBuf) {
        let root = unique_temp_dir("project-secrets");
        let database_path = crate::services::orchestra_paths::orchestra_database_path(&root);
        let connection =
            database::open_connection_at(&database_path).expect("database should open");
        let now = Utc::now().to_rfc3339();
        connection
            .execute(
                "INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('project-1', 'test-project', 'Test Project', NULL, 'TPS', NULL, ?1, ?1)",
                params![now],
            )
            .expect("project should insert");
        (connection, root)
    }

    #[test]
    fn validates_reserved_secret_keys() {
        assert_eq!(
            normalize_secret_key("openai_api_key").as_deref(),
            Ok("OPENAI_API_KEY")
        );
        assert!(normalize_secret_key("1INVALID").is_err());
        assert!(normalize_secret_key("PATH").is_err());
        assert!(normalize_secret_key("orchestra_token").is_err());
    }

    #[test]
    fn creates_updates_lists_and_deletes_project_secrets() {
        let (connection, root) = connection_with_project();
        let store = TestProjectSecretStore::new("available");

        let created = write_project_secret_with_store(
            &connection,
            Some(&root),
            "test-project",
            ProjectSecretUpsertInput {
                secret_key: "OPENAI_API_KEY".into(),
                description: Some("Primary provider key".into()),
                value: Some("sk-test-1".into()),
            },
            SecretWriteMode::Create,
            &store,
        )
        .expect("secret should create");
        assert_eq!(created.secrets.len(), 1);
        assert_eq!(created.secrets[0].value_state, "ready");
        let initial_rotated_at = created.secrets[0].last_rotated_at.clone();

        let updated = write_project_secret_with_store(
            &connection,
            Some(&root),
            "test-project",
            ProjectSecretUpsertInput {
                secret_key: "openai_api_key".into(),
                description: Some("Rotated provider key".into()),
                value: Some("sk-test-2".into()),
            },
            SecretWriteMode::Update,
            &store,
        )
        .expect("secret should update");
        assert_eq!(
            updated.secrets[0].description.as_deref(),
            Some("Rotated provider key")
        );
        assert_ne!(updated.secrets[0].last_rotated_at, initial_rotated_at);

        let loaded = get_project_secret_value_with_store(
            &connection,
            Some(&root),
            "test-project",
            "OPENAI_API_KEY",
            &store,
        )
        .expect("secret value should load");
        assert_eq!(loaded.value, "sk-test-2");

        let deleted = delete_project_secret_with_store(
            &connection,
            Some(&root),
            "test-project",
            "OPENAI_API_KEY",
            &store,
        )
        .expect("secret should delete");
        assert!(deleted.secrets.is_empty());
    }

    #[test]
    fn reports_missing_value_without_plaintext_fallback() {
        let (connection, root) = connection_with_project();
        let store = TestProjectSecretStore::new("available");

        connection
            .execute(
                "INSERT INTO project_secret_metadata (id, project_id, secret_key, description, created_at, updated_at, last_rotated_at) VALUES ('secret-1', 'project-1', 'OPENAI_API_KEY', 'Key', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z')",
                [],
            )
            .expect("metadata should insert");

        let state =
            get_project_secrets_with_store(&connection, Some(&root), "test-project", &store)
                .expect("state should load");
        assert_eq!(state.secrets[0].value_state, "missing_value");
        assert_eq!(state.availability.status, "available");
    }

    #[test]
    fn surfaces_locked_store_errors() {
        let (connection, root) = connection_with_project();
        let store = TestProjectSecretStore::new("available");

        write_project_secret_with_store(
            &connection,
            Some(&root),
            "test-project",
            ProjectSecretUpsertInput {
                secret_key: "OPENAI_API_KEY".into(),
                description: None,
                value: Some("sk-test-1".into()),
            },
            SecretWriteMode::Create,
            &store,
        )
        .expect("secret should create");

        *store.get_error.lock().expect("get error lock") = Some(SecretStoreError {
            kind: SecretStoreErrorKind::Locked,
            message: "Keychain is locked".into(),
        });

        let state =
            get_project_secrets_with_store(&connection, Some(&root), "test-project", &store)
                .expect("state should load");
        assert_eq!(state.availability.status, "locked");
        assert_eq!(state.secrets[0].value_state, "store_locked");
    }

    #[test]
    fn searches_project_secret_metadata_without_loading_values() {
        let (connection, root) = connection_with_project();
        let store = TestProjectSecretStore::new("available");

        write_project_secret_with_store(
            &connection,
            Some(&root),
            "test-project",
            ProjectSecretUpsertInput {
                secret_key: "OPENAI_API_KEY".into(),
                description: Some("Primary provider key".into()),
                value: Some("sk-test-1".into()),
            },
            SecretWriteMode::Create,
            &store,
        )
        .expect("first secret should create");
        write_project_secret_with_store(
            &connection,
            Some(&root),
            "test-project",
            ProjectSecretUpsertInput {
                secret_key: "ANTHROPIC_API_KEY".into(),
                description: None,
                value: Some("sk-test-2".into()),
            },
            SecretWriteMode::Create,
            &store,
        )
        .expect("second secret should create");

        let state = search_project_secrets_with_store(
            &connection,
            Some(&root),
            "test-project",
            &ProjectSecretMetadataFilter {
                query: Some("provider".into()),
                secret_key: None,
                value_state: Some("ready".into()),
                has_description: Some(true),
            },
            &store,
        )
        .expect("filtered state should load");
        assert_eq!(state.secrets.len(), 1);
        assert_eq!(state.secrets[0].secret_key, "OPENAI_API_KEY");
    }

    #[test]
    fn cleanup_best_effort_collects_store_warnings() {
        let (connection, root) = connection_with_project();
        let account = secure_store_account(Some(&root), "project-1", "OPENAI_API_KEY");
        let store = TestProjectSecretStore::new("available");
        store.values.lock().expect("values lock").insert(
            TestProjectSecretStore::key(PROJECT_SECRET_SERVICE, &account),
            "sk-test-1".into(),
        );
        connection
            .execute(
                "INSERT INTO project_secret_metadata (id, project_id, secret_key, description, created_at, updated_at, last_rotated_at) VALUES ('secret-1', 'project-1', 'OPENAI_API_KEY', NULL, '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z', '2026-05-01T00:00:00Z')",
                [],
            )
            .expect("metadata should insert");

        *store.delete_error.lock().expect("delete error lock") = Some(SecretStoreError {
            kind: SecretStoreErrorKind::Other,
            message: "delete failed".into(),
        });
        let project = projects::get_project_by_slug(&connection, "test-project")
            .expect("project lookup should succeed")
            .expect("project should exist");
        let warnings = load_project_secret_metadata(&connection, &project.id)
            .expect("metadata should load")
            .into_iter()
            .filter_map(|entry| {
                let account = secure_store_account(Some(&root), &project.id, &entry.secret_key);
                store
                    .delete_value(PROJECT_SECRET_SERVICE, &account)
                    .err()
                    .map(|error| format!("{}: {}", entry.secret_key, error.message))
            })
            .collect::<Vec<_>>();
        assert_eq!(warnings, vec!["OPENAI_API_KEY: delete failed".to_string()]);
    }
}
