use tauri::State;

use crate::{
    models::{
        AgentSkillLinks, AuthorizationContext, LocalSkillUpsertInput, RoleSkillLinks,
        SkillBindingInput, SkillDetail, SkillSummary, SkillsCatalogDiagnostics, WorkflowSkillLinks,
    },
    services::{command_authorization, database, skill_bindings, skills},
    state::AppState,
};

#[tauri::command]
pub fn list_skills(
    include_archived: Option<bool>,
    authorization: Option<AuthorizationContext>,
) -> Result<Vec<SkillSummary>, String> {
    let connection = database::open_connection()?;
    command_authorization::require_permission(&connection, authorization.as_ref(), "skills.read")?;
    skills::list_skills(&connection, include_archived.unwrap_or(false))
}

#[tauri::command]
pub fn get_skill(
    skill_id: String,
    authorization: Option<AuthorizationContext>,
) -> Result<SkillDetail, String> {
    let connection = database::open_connection()?;
    command_authorization::require_permission(&connection, authorization.as_ref(), "skills.read")?;
    skills::get_skill(&connection, &skill_id)
}

#[tauri::command]
pub fn get_skills_catalog_diagnostics(
    authorization: Option<AuthorizationContext>,
) -> Result<SkillsCatalogDiagnostics, String> {
    let connection = database::open_connection()?;
    command_authorization::require_permission(&connection, authorization.as_ref(), "skills.read")?;
    skills::get_skills_catalog_diagnostics(&connection)
}

#[tauri::command]
pub fn create_local_skill(
    state: State<'_, AppState>,
    input: LocalSkillUpsertInput,
    authorization: Option<AuthorizationContext>,
) -> Result<SkillDetail, String> {
    let mut connection = database::open_connection()?;
    command_authorization::require_permission(
        &connection,
        authorization.as_ref(),
        "skills.create",
    )?;
    let orchestra_root = skills::default_orchestra_root_for_skills()?;
    let skill = skills::create_local_skill(&mut connection, &orchestra_root, input)?;
    state.log(
        "info",
        "skill.created",
        &format!("Created local skill {}", skill.summary.id),
    );
    state.log_authorized_action(
        "auth.audit",
        "create_local_skill",
        authorization.as_ref(),
        Some("skills.create"),
        &skill.summary.id,
        "success",
    );
    Ok(skill)
}

#[tauri::command]
pub fn update_local_skill(
    state: State<'_, AppState>,
    skill_id: String,
    input: LocalSkillUpsertInput,
    authorization: Option<AuthorizationContext>,
) -> Result<SkillDetail, String> {
    let mut connection = database::open_connection()?;
    command_authorization::require_permission(
        &connection,
        authorization.as_ref(),
        "skills.update",
    )?;
    let orchestra_root = skills::default_orchestra_root_for_skills()?;
    let skill = skills::update_local_skill(&mut connection, &orchestra_root, &skill_id, input)?;
    state.log(
        "info",
        "skill.updated",
        &format!("Updated local skill {}", skill.summary.id),
    );
    state.log_authorized_action(
        "auth.audit",
        "update_local_skill",
        authorization.as_ref(),
        Some("skills.update"),
        &skill_id,
        "success",
    );
    Ok(skill)
}

#[tauri::command]
pub fn archive_local_skill(
    state: State<'_, AppState>,
    skill_id: String,
    authorization: Option<AuthorizationContext>,
) -> Result<SkillDetail, String> {
    let connection = database::open_connection()?;
    command_authorization::require_permission(
        &connection,
        authorization.as_ref(),
        "skills.archive",
    )?;
    let skill = skills::set_local_skill_archived(&connection, &skill_id, true)?;
    state.log(
        "info",
        "skill.archived",
        &format!("Archived local skill {}", skill.summary.id),
    );
    state.log_authorized_action(
        "auth.audit",
        "archive_local_skill",
        authorization.as_ref(),
        Some("skills.archive"),
        &skill_id,
        "success",
    );
    Ok(skill)
}

#[tauri::command]
pub fn unarchive_local_skill(
    state: State<'_, AppState>,
    skill_id: String,
    authorization: Option<AuthorizationContext>,
) -> Result<SkillDetail, String> {
    let connection = database::open_connection()?;
    command_authorization::require_permission(
        &connection,
        authorization.as_ref(),
        "skills.archive",
    )?;
    let skill = skills::set_local_skill_archived(&connection, &skill_id, false)?;
    state.log(
        "info",
        "skill.unarchived",
        &format!("Unarchived local skill {}", skill.summary.id),
    );
    state.log_authorized_action(
        "auth.audit",
        "unarchive_local_skill",
        authorization.as_ref(),
        Some("skills.archive"),
        &skill_id,
        "success",
    );
    Ok(skill)
}

#[tauri::command]
pub fn delete_local_skill(
    state: State<'_, AppState>,
    skill_id: String,
    authorization: Option<AuthorizationContext>,
) -> Result<SkillDetail, String> {
    let connection = database::open_connection()?;
    command_authorization::require_permission(
        &connection,
        authorization.as_ref(),
        "skills.delete",
    )?;
    let skill = skills::delete_local_skill(&connection, &skill_id)?;
    state.log(
        "info",
        "skill.deleted",
        &format!("Deleted local skill {}", skill.summary.id),
    );
    state.log_authorized_action(
        "auth.audit",
        "delete_local_skill",
        authorization.as_ref(),
        Some("skills.delete"),
        &skill_id,
        "success",
    );
    Ok(skill)
}

#[tauri::command]
pub fn refresh_external_skills(
    state: State<'_, AppState>,
    authorization: Option<AuthorizationContext>,
) -> Result<Vec<SkillSummary>, String> {
    let mut connection = database::open_connection()?;
    command_authorization::require_permission(
        &connection,
        authorization.as_ref(),
        "skills.update",
    )?;
    let external_root = skills::default_external_skills_dir()?;
    let refreshed = skills::refresh_external_skills(&mut connection, &external_root)?;
    state.log(
        "info",
        "skill.refresh_external",
        &format!("Refreshed external skills from {}", external_root.display()),
    );
    state.log_authorized_action(
        "auth.audit",
        "refresh_external_skills",
        authorization.as_ref(),
        Some("skills.update"),
        &external_root.display().to_string(),
        "success",
    );
    Ok(refreshed)
}

#[tauri::command]
pub fn set_skill_bindings(
    state: State<'_, AppState>,
    skill_id: String,
    bindings: Vec<SkillBindingInput>,
    authorization: Option<AuthorizationContext>,
) -> Result<SkillDetail, String> {
    let mut connection = database::open_connection()?;
    command_authorization::require_permission(
        &connection,
        authorization.as_ref(),
        "skills.assign",
    )?;
    skill_bindings::set_skill_bindings(&mut connection, &skill_id, bindings)?;
    let skill = skills::get_skill(&connection, &skill_id)?;
    state.log(
        "info",
        "skill.bindings.updated",
        &format!("Updated bindings for skill {}", skill.summary.id),
    );
    state.log_authorized_action(
        "auth.audit",
        "set_skill_bindings",
        authorization.as_ref(),
        Some("skills.assign"),
        &skill_id,
        "success",
    );
    Ok(skill)
}

#[tauri::command]
pub fn get_role_skill_links(
    role_id: String,
    authorization: Option<AuthorizationContext>,
) -> Result<RoleSkillLinks, String> {
    let connection = database::open_connection()?;
    command_authorization::require_permission(&connection, authorization.as_ref(), "skills.read")?;
    skill_bindings::get_role_skill_links(&connection, &role_id)
}

#[tauri::command]
pub fn get_agent_skill_links(
    agent_id: String,
    authorization: Option<AuthorizationContext>,
) -> Result<AgentSkillLinks, String> {
    let connection = database::open_connection()?;
    command_authorization::require_permission(&connection, authorization.as_ref(), "skills.read")?;
    skill_bindings::get_agent_skill_links(&connection, &agent_id)
}

#[tauri::command]
pub fn get_workflow_skill_links(
    workflow_id: String,
    authorization: Option<AuthorizationContext>,
) -> Result<WorkflowSkillLinks, String> {
    let connection = database::open_connection()?;
    command_authorization::require_permission(&connection, authorization.as_ref(), "skills.read")?;
    skill_bindings::get_workflow_skill_links(&connection, &workflow_id)
}
