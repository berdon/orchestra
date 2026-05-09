use std::fs;

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Deserialize;

use crate::services::{
    orchestra_paths::{default_orchestra_root, project_root},
    project_settings,
};

const INSTALL_BASELINE_KEY: &str = "default-install-baseline";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DefaultInstallBaselineCatalog {
    version: i64,
    project: SeedProject,
    roles: Vec<SeedRole>,
    workflows: Vec<SeedWorkflow>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SeedProject {
    id: String,
    slug: String,
    name: String,
    description: Option<String>,
    task_prefix: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SeedRole {
    id: String,
    slug: String,
    name: String,
    description: Option<String>,
    system_prompt: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    thinking_level: String,
    capacity: i64,
    #[serde(default)]
    direct_permissions: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SeedWorkflow {
    id: String,
    slug: String,
    name: String,
    description: Option<String>,
    lanes: Vec<SeedWorkflowLane>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SeedWorkflowLane {
    id: String,
    key: String,
    name: String,
    description: Option<String>,
    order: i64,
    assigned_entity_type: String,
    assigned_entity_id: Option<String>,
    entry_prompt_template: Option<String>,
    #[serde(default)]
    use_separate_worktree: bool,
    #[serde(default)]
    require_user_approval_on_success: bool,
    needs_work_target_lane_id: Option<String>,
    success_transition_type: String,
    success_target_lane_id: Option<String>,
    failure_transition_type: String,
    failure_target_lane_id: Option<String>,
}

pub fn ensure_install_baseline_seeded(connection: &mut Connection) -> Result<(), String> {
    let catalog = load_catalog()?;
    let already_applied = connection
        .query_row(
            "SELECT version FROM installation_bootstrap_state WHERE key = ?1",
            [INSTALL_BASELINE_KEY],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to query installation bootstrap state: {error}"))?
        .is_some();
    if already_applied {
        return Ok(());
    }

    let should_seed = table_count(connection, "projects")? == 0
        && table_count(connection, "roles")? == 0
        && table_count(connection, "workflows")? == 0;
    let now = now_iso();
    let tx = connection
        .transaction()
        .map_err(|error| format!("Unable to start install seed transaction: {error}"))?;

    if should_seed {
        seed_project(&tx, &catalog.project, &now)?;
        seed_roles(&tx, &catalog.roles, &now)?;
        seed_workflows(&tx, &catalog.workflows, &now)?;
        let orchestra_root = default_orchestra_root()?;
        ensure_project_root_exists(&catalog.project.slug)?;
        let _ = project_settings::update_task_automation_settings_with_connection(
            &tx,
            Some(&orchestra_root),
            &catalog.project.slug,
            true,
        )?;
    }

    tx.execute(
        r#"
        INSERT INTO installation_bootstrap_state (key, version, applied_at)
        VALUES (?1, ?2, ?3)
        "#,
        params![INSTALL_BASELINE_KEY, catalog.version, now],
    )
    .map_err(|error| format!("Unable to persist installation bootstrap state: {error}"))?;

    tx.commit()
        .map_err(|error| format!("Unable to commit install seed transaction: {error}"))
}

fn load_catalog() -> Result<DefaultInstallBaselineCatalog, String> {
    serde_json::from_str(include_str!(
        "../../../src/seed/default-install-baseline.json"
    ))
    .map_err(|error| format!("Unable to parse default install baseline catalog: {error}"))
}

fn table_count(connection: &Connection, table: &str) -> Result<i64, String> {
    connection
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .map_err(|error| format!("Unable to count {table}: {error}"))
}

fn seed_project(tx: &Transaction<'_>, project: &SeedProject, now: &str) -> Result<(), String> {
    tx.execute(
        r#"
        INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?6)
        "#,
        params![project.id, project.slug, project.name, project.description, project.task_prefix, now],
    )
    .map_err(|error| format!("Unable to seed default project: {error}"))?;
    Ok(())
}

fn seed_roles(tx: &Transaction<'_>, roles: &[SeedRole], now: &str) -> Result<(), String> {
    for role in roles {
        let direct_permissions =
            serde_json::to_string(&role.direct_permissions).map_err(|error| {
                format!(
                    "Unable to encode permissions for role {}: {error}",
                    role.slug
                )
            })?;
        tx.execute(
            r#"
            INSERT INTO roles (
                id,
                slug,
                name,
                description,
                system_prompt,
                provider,
                model,
                thinking_level,
                capacity,
                direct_permissions,
                archived,
                created_at,
                updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, ?11, ?11)
            "#,
            params![
                role.id,
                role.slug,
                role.name,
                role.description,
                role.system_prompt,
                role.provider,
                role.model,
                role.thinking_level,
                role.capacity,
                direct_permissions,
                now,
            ],
        )
        .map_err(|error| format!("Unable to seed role {}: {error}", role.slug))?;
    }
    Ok(())
}

fn seed_workflows(
    tx: &Transaction<'_>,
    workflows: &[SeedWorkflow],
    now: &str,
) -> Result<(), String> {
    for workflow in workflows {
        tx.execute(
            r#"
            INSERT INTO workflows (id, slug, name, description, archived, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5)
            "#,
            params![
                workflow.id,
                workflow.slug,
                workflow.name,
                workflow.description,
                now
            ],
        )
        .map_err(|error| format!("Unable to seed workflow {}: {error}", workflow.slug))?;

        for lane in &workflow.lanes {
            tx.execute(
                r#"
                INSERT INTO workflow_lanes (
                    id,
                    workflow_id,
                    lane_key,
                    name,
                    description,
                    lane_order,
                    assigned_entity_type,
                    assigned_entity_id,
                    entry_prompt_template,
                    use_separate_worktree,
                    require_user_approval_on_success,
                    needs_work_target_lane_id,
                    success_transition_type,
                    success_target_lane_id,
                    failure_transition_type,
                    failure_target_lane_id,
                    user_intervention_target_lane_id,
                    created_at,
                    updated_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, NULL, ?17, ?17)
                "#,
                params![
                    lane.id,
                    workflow.id,
                    lane.key,
                    lane.name,
                    lane.description,
                    lane.order,
                    lane.assigned_entity_type,
                    lane.assigned_entity_id,
                    lane.entry_prompt_template,
                    if lane.use_separate_worktree { 1 } else { 0 },
                    if lane.require_user_approval_on_success { 1 } else { 0 },
                    lane.needs_work_target_lane_id,
                    lane.success_transition_type,
                    lane.success_target_lane_id,
                    lane.failure_transition_type,
                    lane.failure_target_lane_id,
                    now,
                ],
            )
            .map_err(|error| {
                format!(
                    "Unable to seed workflow lane {} for {}: {error}",
                    lane.key, workflow.slug
                )
            })?;
        }
    }
    Ok(())
}

fn ensure_project_root_exists(project_slug: &str) -> Result<(), String> {
    let orchestra_root = default_orchestra_root()?;
    let root = project_root(&orchestra_root, project_slug);
    fs::create_dir_all(&root).map_err(|error| {
        format!(
            "Unable to create project directory {}: {error}",
            root.display()
        )
    })
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        models::{RoleUpsertInput, WorkflowLane},
        services::{database, projects, roles, workflows},
    };
    use std::{
        env, fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn unique_temp_db(label: &str) -> PathBuf {
        let suffix = format!(
            "{}-{}-{}",
            label,
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time should move forward")
                .as_millis()
        );
        env::temp_dir().join(suffix).join("orchestra.db")
    }

    fn with_temp_storage_root<T>(label: &str, action: impl FnOnce(PathBuf) -> T) -> T {
        let _guard = crate::test_support::global_test_env_lock()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let previous_root = env::var_os("ORCHESTRA_STORAGE_ROOT");
        let root = env::temp_dir().join(format!(
            "install-seed-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time should move forward")
                .as_millis()
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

    #[test]
    fn seeds_fresh_install_with_project_roles_and_workflows() {
        let path = unique_temp_db("install-seed-fresh");
        database::initialize_database_at(&path).expect("database should initialize");
        let mut connection = Connection::open(&path).expect("database should open");

        ensure_install_baseline_seeded(&mut connection).expect("baseline should seed");

        let projects = projects::list_projects(&connection).expect("projects should list");
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].name, "Orchestra");
        assert_eq!(projects[0].default_repository_id, None);

        let role_slugs = roles::list_roles(&connection, false)
            .expect("roles should list")
            .into_iter()
            .map(|role| role.slug)
            .collect::<Vec<_>>();
        assert_eq!(
            role_slugs,
            vec![
                "architect".to_string(),
                "product-owner".to_string(),
                "project-manager".to_string(),
                "qa".to_string(),
                "senior-developer".to_string(),
            ]
        );

        let workflow_slugs = workflows::list_workflows(&connection, false)
            .expect("workflows should list")
            .into_iter()
            .map(|workflow| workflow.slug)
            .collect::<Vec<_>>();
        assert_eq!(
            workflow_slugs,
            vec![
                "development".to_string(),
                "planning".to_string(),
                "product-strategy".to_string(),
            ]
        );

        let development = workflows::get_workflow(&connection, "workflow-development")
            .expect("development workflow should load");
        let lane_refs = development
            .lanes
            .into_iter()
            .map(|lane: WorkflowLane| {
                (lane.key, lane.assigned_entity_type, lane.assigned_entity_id)
            })
            .collect::<Vec<_>>();
        assert_eq!(
            lane_refs,
            vec![
                ("plan".into(), "role".into(), Some("architect".into())),
                (
                    "implement".into(),
                    "role".into(),
                    Some("senior-developer".into())
                ),
                ("verify".into(), "role".into(), Some("qa".into())),
                ("review".into(), "user".into(), None),
            ]
        );
    }

    #[test]
    fn seeded_project_deletes_cleanly_and_does_not_reseed() {
        with_temp_storage_root("delete", |_| {
            let path = unique_temp_db("install-seed-delete");
            database::initialize_database_at(&path).expect("database should initialize");
            let mut connection = Connection::open(&path).expect("database should open");

            ensure_install_baseline_seeded(&mut connection).expect("baseline should seed");
            projects::delete_project(&connection, "orchestra")
                .expect("seeded project should delete");
            assert!(projects::list_projects(&connection)
                .expect("projects should list after delete")
                .is_empty());

            ensure_install_baseline_seeded(&mut connection)
                .expect("baseline state should prevent reseed");
            assert!(projects::list_projects(&connection)
                .expect("projects should still be empty")
                .is_empty());
        });
    }

    #[test]
    fn seeded_roles_and_workflows_remain_editable() {
        let path = unique_temp_db("install-seed-editable");
        database::initialize_database_at(&path).expect("database should initialize");
        let mut connection = Connection::open(&path).expect("database should open");

        ensure_install_baseline_seeded(&mut connection).expect("baseline should seed");

        let architect =
            roles::get_role(&connection, "role-architect").expect("architect should load");
        let updated_role = roles::update_role(
            &mut connection,
            &architect.id,
            RoleUpsertInput {
                name: architect.name.clone(),
                description: Some("Updated architect description".into()),
                system_prompt: Some("Updated architect prompt".into()),
                provider: architect.provider.clone(),
                model: architect.model.clone(),
                thinking_level: Some(architect.thinking_level.clone()),
                capacity: architect.capacity,
                compaction_window: None,
                policy_ids: architect.policy_ids.clone(),
                direct_permissions: architect.direct_permissions.clone(),
            },
        )
        .expect("seeded role should update");
        assert_eq!(
            updated_role.description.as_deref(),
            Some("Updated architect description")
        );

        let archived_workflow = workflows::archive_workflow(&connection, "workflow-planning")
            .expect("seeded workflow should archive");
        assert!(archived_workflow.archived);
    }
}
