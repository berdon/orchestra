use tauri::State;

use crate::{
    models::{
        AgentSkillLinks, LocalSkillUpsertInput, RoleSkillLinks, SkillBindingInput, SkillDetail,
        SkillSummary, WorkflowSkillLinks,
    },
    services::{database, skill_bindings, skills},
    state::AppState,
};

#[tauri::command]
pub fn list_skills(include_archived: Option<bool>) -> Result<Vec<SkillSummary>, String> {
    let connection = database::open_connection()?;
    skills::list_skills(&connection, include_archived.unwrap_or(false))
}

#[tauri::command]
pub fn get_skill(skill_id: String) -> Result<SkillDetail, String> {
    let connection = database::open_connection()?;
    skills::get_skill(&connection, &skill_id)
}

#[tauri::command]
pub fn create_local_skill(
    state: State<'_, AppState>,
    input: LocalSkillUpsertInput,
) -> Result<SkillDetail, String> {
    let mut connection = database::open_connection()?;
    let orchestra_root = skills::default_orchestra_root_for_skills()?;
    let skill = skills::create_local_skill(&mut connection, &orchestra_root, input)?;
    state.log(
        "info",
        "skill.created",
        &format!("Created local skill {}", skill.summary.id),
    );
    Ok(skill)
}

#[tauri::command]
pub fn update_local_skill(
    state: State<'_, AppState>,
    skill_id: String,
    input: LocalSkillUpsertInput,
) -> Result<SkillDetail, String> {
    let mut connection = database::open_connection()?;
    let orchestra_root = skills::default_orchestra_root_for_skills()?;
    let skill = skills::update_local_skill(&mut connection, &orchestra_root, &skill_id, input)?;
    state.log(
        "info",
        "skill.updated",
        &format!("Updated local skill {}", skill.summary.id),
    );
    Ok(skill)
}

#[tauri::command]
pub fn archive_local_skill(
    state: State<'_, AppState>,
    skill_id: String,
) -> Result<SkillDetail, String> {
    let connection = database::open_connection()?;
    let skill = skills::set_local_skill_archived(&connection, &skill_id, true)?;
    state.log(
        "info",
        "skill.archived",
        &format!("Archived local skill {}", skill.summary.id),
    );
    Ok(skill)
}

#[tauri::command]
pub fn unarchive_local_skill(
    state: State<'_, AppState>,
    skill_id: String,
) -> Result<SkillDetail, String> {
    let connection = database::open_connection()?;
    let skill = skills::set_local_skill_archived(&connection, &skill_id, false)?;
    state.log(
        "info",
        "skill.unarchived",
        &format!("Unarchived local skill {}", skill.summary.id),
    );
    Ok(skill)
}

#[tauri::command]
pub fn delete_local_skill(
    state: State<'_, AppState>,
    skill_id: String,
) -> Result<SkillDetail, String> {
    let connection = database::open_connection()?;
    let skill = skills::delete_local_skill(&connection, &skill_id)?;
    state.log(
        "info",
        "skill.deleted",
        &format!("Deleted local skill {}", skill.summary.id),
    );
    Ok(skill)
}

#[tauri::command]
pub fn refresh_external_skills(state: State<'_, AppState>) -> Result<Vec<SkillSummary>, String> {
    let mut connection = database::open_connection()?;
    let external_root = skills::default_external_skills_dir()?;
    let refreshed = skills::refresh_external_skills(&mut connection, &external_root)?;
    state.log(
        "info",
        "skill.refresh_external",
        &format!("Refreshed external skills from {}", external_root.display()),
    );
    Ok(refreshed)
}

#[tauri::command]
pub fn set_skill_bindings(
    state: State<'_, AppState>,
    skill_id: String,
    bindings: Vec<SkillBindingInput>,
) -> Result<SkillDetail, String> {
    let mut connection = database::open_connection()?;
    skill_bindings::set_skill_bindings(&mut connection, &skill_id, bindings)?;
    let skill = skills::get_skill(&connection, &skill_id)?;
    state.log(
        "info",
        "skill.bindings.updated",
        &format!("Updated bindings for skill {}", skill.summary.id),
    );
    Ok(skill)
}

#[tauri::command]
pub fn get_role_skill_links(role_id: String) -> Result<RoleSkillLinks, String> {
    let connection = database::open_connection()?;
    skill_bindings::get_role_skill_links(&connection, &role_id)
}

#[tauri::command]
pub fn get_agent_skill_links(agent_id: String) -> Result<AgentSkillLinks, String> {
    let connection = database::open_connection()?;
    skill_bindings::get_agent_skill_links(&connection, &agent_id)
}

#[tauri::command]
pub fn get_workflow_skill_links(workflow_id: String) -> Result<WorkflowSkillLinks, String> {
    let connection = database::open_connection()?;
    skill_bindings::get_workflow_skill_links(&connection, &workflow_id)
}
