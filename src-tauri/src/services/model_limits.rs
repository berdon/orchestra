use std::{
    collections::{HashMap, HashSet},
    fs,
    path::Path,
    time::Duration,
};

use chrono::Utc;
use reqwest::blocking::Client;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::Value;
use tauri::AppHandle;

use crate::{
    models::{
        HarnessModelLimitMetricValue, HarnessModelLimitPolicy, HarnessModelLimitState,
        HarnessModelLimitsSnapshot, HarnessModelRef, HarnessUsageSource, SessionModel,
    },
    services::{
        app_events, database, domain_events, harness_settings,
        live_sessions::maybe_runtime,
        orchestra_paths::{
            default_orchestra_root, orchestra_pi_auth_path, orchestra_pi_models_path,
        },
        task_runtime,
    },
    state::AppState,
};

const ZAI_USAGE_ENDPOINT_PATH: &str = "/monitor/usage/quota/limit";
const DEFAULT_SUCCESS_POLL_SECONDS: i64 = 300;
const DEFAULT_FAILURE_POLL_SECONDS: i64 = 120;

#[derive(Debug, Clone)]
struct PersistedModelLimitState {
    model_ref: HarnessModelRef,
    usage_source: HarnessUsageSource,
    capped: bool,
    last_checked_at: Option<String>,
    capped_at: Option<String>,
    cleared_at: Option<String>,
    last_error: Option<String>,
    reason: Option<String>,
    metrics: Vec<HarnessModelLimitMetricValue>,
}

#[derive(Debug, Clone)]
struct UsageSnapshot {
    metrics: Vec<HarnessModelLimitMetricValue>,
    source_label: String,
    raw_json: Value,
}

#[derive(Debug, Clone)]
struct EvaluationResult {
    capped: bool,
    reason: Option<String>,
    metrics: Vec<HarnessModelLimitMetricValue>,
}

#[derive(Debug, Clone)]
struct TaskEnforcementCandidate {
    task_id: String,
    session_id: Option<String>,
    worker_type: String,
    worker_id: Option<String>,
}

#[derive(Debug, Clone)]
struct SessionModelSnapshotRecord {
    provider: String,
    model_id: String,
    api: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct StoredModelsFile {
    #[serde(default)]
    providers: HashMap<String, StoredProviderConfig>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct StoredProviderConfig {
    base_url: Option<String>,
}

pub fn get_harness_model_limits_snapshot() -> Result<HarnessModelLimitsSnapshot, String> {
    let orchestra_root = default_orchestra_root()?;
    let policies = harness_settings::get_harness_model_limit_policies_in(&orchestra_root)?;
    let connection = database::open_connection()?;
    let mut states = load_model_limit_states(
        &connection,
        &policies
            .iter()
            .map(|policy| model_key(&policy.model_ref))
            .collect::<Vec<_>>(),
    )?;

    let persisted_keys = states
        .iter()
        .map(|state| model_key(&state.model_ref))
        .collect::<HashSet<_>>();
    for policy in &policies {
        if policy.usage_source.adapter == "unsupported"
            && !persisted_keys.contains(&model_key(&policy.model_ref))
        {
            states.push(harness_settings::unsupported_model_limit_state(
                &policy.model_ref,
            ));
        }
    }

    Ok(HarnessModelLimitsSnapshot { policies, states })
}

pub fn save_harness_model_limit_policy(
    model_ref: HarnessModelRef,
    rolling_5h_percent: Option<i64>,
    weekly_percent: Option<i64>,
) -> Result<HarnessModelLimitsSnapshot, String> {
    let orchestra_root = default_orchestra_root()?;
    let policies = harness_settings::save_harness_model_limit_policy_in(
        &orchestra_root,
        model_ref.clone(),
        rolling_5h_percent,
        weekly_percent,
    )?;
    let connection = database::open_connection()?;
    if rolling_5h_percent.is_none() && weekly_percent.is_none() {
        delete_model_limit_state(&connection, &model_ref)?;
    }
    let mut states = load_model_limit_states(
        &connection,
        &policies
            .iter()
            .map(|policy| model_key(&policy.model_ref))
            .collect::<Vec<_>>(),
    )?;
    if rolling_5h_percent.is_some() || weekly_percent.is_some() {
        if let Some(policy) = policies
            .iter()
            .find(|policy| harness_settings::same_model_ref(&policy.model_ref, &model_ref))
        {
            if policy.usage_source.adapter == "unsupported"
                && !states
                    .iter()
                    .any(|state| harness_settings::same_model_ref(&state.model_ref, &model_ref))
            {
                states.push(harness_settings::unsupported_model_limit_state(&model_ref));
            }
        }
    }
    Ok(HarnessModelLimitsSnapshot { policies, states })
}

pub fn process_usage_checks(app: AppHandle, state: &AppState) -> Result<usize, String> {
    let orchestra_root = default_orchestra_root()?;
    let policies = harness_settings::get_harness_model_limit_policies_in(&orchestra_root)?;
    if policies.is_empty() {
        return Ok(0);
    }

    let grouped = group_policies_by_usage_source(policies);
    let mut actions = 0;
    let connection = database::open_connection()?;

    for ((adapter, scope_key), group_policies) in grouped {
        if adapter == "unsupported" {
            continue;
        }
        if !scope_poll_due(&connection, &adapter, &scope_key)? {
            continue;
        }

        match adapter.as_str() {
            "zai_quota" => {
                match fetch_zai_usage_snapshot(
                    &orchestra_root,
                    &group_policies[0].model_ref.provider,
                ) {
                    Ok(snapshot) => {
                        save_provider_usage_snapshot(
                            &connection,
                            &adapter,
                            &scope_key,
                            "ready",
                            Some(&snapshot.raw_json),
                            None,
                            success_poll_interval_seconds(),
                        )?;
                        for policy in group_policies {
                            let previous_state =
                                load_model_limit_state(&connection, &policy.model_ref)?;
                            let evaluation = evaluate_policy(&policy, &snapshot)?;
                            let next_state =
                                build_next_state(&policy, previous_state.as_ref(), &evaluation);
                            save_model_limit_state(&connection, &next_state)?;
                            if evaluation.capped {
                                actions += enforce_capped_model(
                                    &app,
                                    state,
                                    &connection,
                                    &policy.model_ref,
                                    next_state
                                        .reason
                                        .as_deref()
                                        .unwrap_or("Harness model limit exceeded."),
                                )?;
                            }
                        }
                    }
                    Err(error) => {
                        save_provider_usage_snapshot(
                            &connection,
                            &adapter,
                            &scope_key,
                            "error",
                            None,
                            Some(error.as_str()),
                            failure_poll_interval_seconds(),
                        )?;
                        for policy in group_policies {
                            let previous_state =
                                load_model_limit_state(&connection, &policy.model_ref)?;
                            let next_state =
                                preserve_state_with_error(&policy, previous_state.as_ref(), &error);
                            save_model_limit_state(&connection, &next_state)?;
                        }
                        state.log(
                            "warn",
                            "harness.model_limits.poll.failed",
                            &format!(
                                "Unable to refresh provider usage for {} / {}: {}",
                                adapter, scope_key, error
                            ),
                        );
                    }
                }
            }
            _ => {}
        }
    }

    Ok(actions)
}

pub fn record_session_model_snapshot(
    session_id: &str,
    model: &SessionModel,
    source: &str,
) -> Result<(), String> {
    let connection = database::open_connection()?;
    upsert_session_model_snapshot(
        &connection,
        session_id,
        &model.provider,
        &model.id,
        Some(model.api.as_str()),
        source,
    )
}

pub fn ensure_session_message_allowed(state: &AppState, session_id: &str) -> Result<(), String> {
    let connection = database::open_connection()?;
    let snapshot = load_or_capture_session_model_snapshot(&connection, state, session_id)?;
    let Some(snapshot) = snapshot else {
        return Ok(());
    };
    let Some(limit_state) = load_model_limit_state(
        &connection,
        &HarnessModelRef {
            provider: snapshot.provider,
            model_id: snapshot.model_id,
            api: snapshot.api,
        },
    )?
    else {
        return Ok(());
    };
    if !limit_state.capped {
        return Ok(());
    }

    Err(format!(
        "Harness blocked this prompt because the current model is capped. {}",
        limit_state
            .reason
            .unwrap_or_else(|| "Auto-paused by Harness model limit.".into())
    ))
}

fn group_policies_by_usage_source(
    policies: Vec<HarnessModelLimitPolicy>,
) -> HashMap<(String, String), Vec<HarnessModelLimitPolicy>> {
    let mut grouped = HashMap::<(String, String), Vec<HarnessModelLimitPolicy>>::new();
    for policy in policies {
        let key = (
            policy.usage_source.adapter.clone(),
            policy.usage_source.scope_key.clone(),
        );
        grouped.entry(key).or_default().push(policy);
    }
    grouped
}

fn success_poll_interval_seconds() -> i64 {
    if std::env::var("ORCHESTRA_DESKTOP_E2E").is_ok() {
        0
    } else {
        DEFAULT_SUCCESS_POLL_SECONDS
    }
}

fn failure_poll_interval_seconds() -> i64 {
    if std::env::var("ORCHESTRA_DESKTOP_E2E").is_ok() {
        0
    } else {
        DEFAULT_FAILURE_POLL_SECONDS
    }
}

fn scope_poll_due(connection: &Connection, adapter: &str, scope_key: &str) -> Result<bool, String> {
    let next_poll_after = connection
        .query_row(
            "SELECT next_poll_after FROM provider_usage_snapshots WHERE adapter = ?1 AND scope_key = ?2 LIMIT 1",
            params![adapter, scope_key],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to load provider usage snapshot timing for {adapter}/{scope_key}: {error}"))?
        .flatten();
    let Some(next_poll_after) = next_poll_after else {
        return Ok(true);
    };
    Ok(next_poll_after <= Utc::now().to_rfc3339())
}

fn fetch_zai_usage_snapshot(
    orchestra_root: &Path,
    provider_id: &str,
) -> Result<UsageSnapshot, String> {
    let api_key = load_provider_api_key(orchestra_root, provider_id)?;
    let base_url = resolve_zai_usage_base_url(orchestra_root, provider_id)?;
    let url = format!(
        "{}{}",
        base_url.trim_end_matches('/'),
        ZAI_USAGE_ENDPOINT_PATH
    );
    let client = Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("Unable to build Z.ai usage client: {error}"))?;
    let response = client
        .get(&url)
        .bearer_auth(api_key)
        .header("Accept-Language", "en-US")
        .send()
        .map_err(|error| format!("Unable to call Z.ai usage API {}: {error}", url))?;
    let status = response.status();
    let body = response
        .text()
        .map_err(|error| format!("Unable to read Z.ai usage API response {}: {error}", url))?;
    if !status.is_success() {
        return Err(format!(
            "Z.ai usage API {} returned {}: {}",
            url,
            status,
            truncate_error_body(&body)
        ));
    }
    let payload: Value = serde_json::from_str(&body)
        .map_err(|error| format!("Unable to parse Z.ai usage response {}: {error}", url))?;
    if payload.get("success").and_then(Value::as_bool) == Some(false) {
        return Err(format!(
            "Z.ai usage API reported failure: {}",
            payload
                .get("msg")
                .and_then(Value::as_str)
                .unwrap_or("unknown error")
        ));
    }
    let metrics = normalize_zai_quota_metrics(&payload)?;
    Ok(UsageSnapshot {
        metrics,
        source_label: format!("z.ai {}", ZAI_USAGE_ENDPOINT_PATH),
        raw_json: payload,
    })
}

fn normalize_zai_quota_metrics(
    payload: &Value,
) -> Result<Vec<HarnessModelLimitMetricValue>, String> {
    let limits = payload
        .pointer("/data/limits")
        .and_then(Value::as_array)
        .ok_or_else(|| "Z.ai usage response is missing data.limits".to_string())?;
    let mut metrics = Vec::new();
    for limit in limits {
        let limit_type = limit.get("type").and_then(Value::as_str).unwrap_or("");
        let unit = limit
            .get("unit")
            .and_then(Value::as_i64)
            .unwrap_or_default();
        let Some(percentage) = parse_integer_metric(limit.get("percentage")) else {
            continue;
        };
        let next_reset_at = limit
            .get("nextResetTime")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        match (limit_type, unit) {
            ("TOKENS_LIMIT", 3) => metrics.push(HarnessModelLimitMetricValue {
                metric_key: "rolling_5h_percent".into(),
                value: percentage,
                unit: "percent".into(),
                next_reset_at,
            }),
            ("TOKENS_LIMIT", 6) => metrics.push(HarnessModelLimitMetricValue {
                metric_key: "weekly_percent".into(),
                value: percentage,
                unit: "percent".into(),
                next_reset_at,
            }),
            _ => {}
        }
    }
    Ok(metrics)
}

fn evaluate_policy(
    policy: &HarnessModelLimitPolicy,
    snapshot: &UsageSnapshot,
) -> Result<EvaluationResult, String> {
    for rule in &policy.rules {
        let Some(metric) = snapshot
            .metrics
            .iter()
            .find(|metric| metric.metric_key == rule.metric_key)
        else {
            continue;
        };
        if metric.value >= rule.threshold_value {
            let reason = format!(
                "Auto-paused by Harness model limit: {}/{} exceeded {} ({}% >= configured {}%). Source: {}.{}",
                policy.model_ref.provider,
                policy.model_ref.model_id,
                rule.metric_key,
                metric.value,
                rule.threshold_value,
                snapshot.source_label,
                metric
                    .next_reset_at
                    .as_deref()
                    .map(|value| format!(" Reset at {}.", value))
                    .unwrap_or_default()
            );
            return Ok(EvaluationResult {
                capped: true,
                reason: Some(reason),
                metrics: snapshot.metrics.clone(),
            });
        }
    }

    Ok(EvaluationResult {
        capped: false,
        reason: None,
        metrics: snapshot.metrics.clone(),
    })
}

fn build_next_state(
    policy: &HarnessModelLimitPolicy,
    previous_state: Option<&PersistedModelLimitState>,
    evaluation: &EvaluationResult,
) -> PersistedModelLimitState {
    let now = Utc::now().to_rfc3339();
    PersistedModelLimitState {
        model_ref: policy.model_ref.clone(),
        usage_source: policy.usage_source.clone(),
        capped: evaluation.capped,
        last_checked_at: Some(now.clone()),
        capped_at: if evaluation.capped {
            previous_state
                .and_then(|state| state.capped_at.clone())
                .or(Some(now.clone()))
        } else {
            previous_state.and_then(|state| state.capped_at.clone())
        },
        cleared_at: if !evaluation.capped && previous_state.is_some_and(|state| state.capped) {
            Some(now.clone())
        } else {
            previous_state.and_then(|state| state.cleared_at.clone())
        },
        last_error: None,
        reason: evaluation.reason.clone(),
        metrics: evaluation.metrics.clone(),
    }
}

fn preserve_state_with_error(
    policy: &HarnessModelLimitPolicy,
    previous_state: Option<&PersistedModelLimitState>,
    error: &str,
) -> PersistedModelLimitState {
    PersistedModelLimitState {
        model_ref: policy.model_ref.clone(),
        usage_source: policy.usage_source.clone(),
        capped: previous_state.is_some_and(|state| state.capped),
        last_checked_at: previous_state.and_then(|state| state.last_checked_at.clone()),
        capped_at: previous_state.and_then(|state| state.capped_at.clone()),
        cleared_at: previous_state.and_then(|state| state.cleared_at.clone()),
        last_error: Some(error.to_string()),
        reason: previous_state.and_then(|state| state.reason.clone()),
        metrics: previous_state
            .map(|state| state.metrics.clone())
            .unwrap_or_default(),
    }
}

fn enforce_capped_model(
    app: &AppHandle,
    state: &AppState,
    connection: &Connection,
    model_ref: &HarnessModelRef,
    reason: &str,
) -> Result<usize, String> {
    let task_candidates = find_task_enforcement_candidates(connection, model_ref)?;
    let task_session_ids = task_candidates
        .iter()
        .filter_map(|candidate| candidate.session_id.clone())
        .collect::<HashSet<_>>();

    let mut actions = 0;
    let mut processed_task_ids = HashSet::new();
    for candidate in task_candidates {
        if !processed_task_ids.insert(candidate.task_id.clone()) {
            continue;
        }
        let previous_assignment =
            task_runtime::get_current_lane_assignment(connection, &candidate.task_id)?;
        let task = match task_runtime::pause_task_lane(
            connection,
            &candidate.task_id,
            Some(reason.to_string()),
        ) {
            Ok(task) => task,
            Err(error) if error.contains("is not active or queued and cannot be paused") => {
                continue;
            }
            Err(error) => return Err(error),
        };
        if let Some(session_id) = previous_assignment
            .as_ref()
            .and_then(|assignment| assignment.session_id.as_deref())
        {
            stop_live_session_runtime(state, session_id)?;
            let _ = app_events::emit_session_change(
                app,
                "harness.model_limits.task_paused",
                [session_id.to_string()],
            );
        }
        record_task_pause_event(
            connection,
            &task.id,
            &task.project_id,
            previous_assignment
                .as_ref()
                .map(|assignment| assignment.id.clone()),
            reason,
        );
        let _ = app_events::emit_task_change(
            app,
            "harness.model_limits.task_paused",
            [task.id.clone()],
        );
        state.log(
            "warn",
            "harness.model_limits.task_paused",
            &format!("Paused task {} because {}", task.id, reason),
        );
        actions += 1;
    }

    for session_id in find_standalone_session_ids(connection, model_ref)? {
        if task_session_ids.contains(&session_id) {
            continue;
        }
        if stop_live_session_runtime(state, &session_id)? {
            record_session_pause_event(connection, &session_id, reason);
            let _ = app_events::emit_session_change(
                app,
                "harness.model_limits.session_paused",
                [session_id.clone()],
            );
            state.log(
                "warn",
                "harness.model_limits.session_paused",
                &format!(
                    "Paused standalone session {} because {}",
                    session_id, reason
                ),
            );
            actions += 1;
        }
    }

    Ok(actions)
}

fn find_task_enforcement_candidates(
    connection: &Connection,
    model_ref: &HarnessModelRef,
) -> Result<Vec<TaskEnforcementCandidate>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT tla.task_id, tla.session_id, tla.worker_type, tla.worker_id
            FROM task_lane_assignments tla
            JOIN tasks t ON t.id = tla.task_id
            WHERE tla.status IN ('active', 'queued')
              AND t.status NOT IN ('completed', 'canceled')
            "#,
        )
        .map_err(|error| format!("Unable to prepare model-limit task candidate query: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(TaskEnforcementCandidate {
                task_id: row.get::<_, String>(0)?,
                session_id: row.get::<_, Option<String>>(1)?,
                worker_type: row.get::<_, String>(2)?,
                worker_id: row.get::<_, Option<String>>(3)?,
            })
        })
        .map_err(|error| format!("Unable to query model-limit task candidates: {error}"))?;

    let mut matches = Vec::new();
    for row in rows {
        let candidate =
            row.map_err(|error| format!("Unable to read model-limit task candidate: {error}"))?;
        let matched = if let Some(session_id) = candidate.session_id.as_deref() {
            load_session_model_snapshot(connection, session_id)?
                .map(|snapshot| {
                    snapshot.provider == model_ref.provider
                        && snapshot.model_id == model_ref.model_id
                })
                .unwrap_or(false)
        } else {
            load_worker_default_model(
                connection,
                &candidate.worker_type,
                candidate.worker_id.as_deref(),
            )?
            .is_some_and(|(provider, model_id)| {
                provider == model_ref.provider && model_id == model_ref.model_id
            })
        };
        if matched {
            matches.push(candidate);
        }
    }
    Ok(matches)
}

fn find_standalone_session_ids(
    connection: &Connection,
    model_ref: &HarnessModelRef,
) -> Result<Vec<String>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT session_id
            FROM session_model_snapshots
            WHERE provider = ?1 AND model_id = ?2
            ORDER BY updated_at DESC
            "#,
        )
        .map_err(|error| format!("Unable to prepare standalone session model query: {error}"))?;
    let rows = statement
        .query_map(params![model_ref.provider, model_ref.model_id], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|error| format!("Unable to query standalone session model snapshots: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to collect standalone session ids: {error}"))
}

fn load_worker_default_model(
    connection: &Connection,
    worker_type: &str,
    worker_id: Option<&str>,
) -> Result<Option<(String, String)>, String> {
    let Some(worker_id) = worker_id else {
        return Ok(None);
    };
    match worker_type {
        "role" => connection
            .query_row(
                "SELECT provider, model FROM roles WHERE id = ?1 LIMIT 1",
                [worker_id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("Unable to load role model default {worker_id}: {error}"))
            .map(|record| record.and_then(|(provider, model)| provider.zip(model))),
        "agent" => connection
            .query_row(
                "SELECT provider, model FROM agents WHERE id = ?1 LIMIT 1",
                [worker_id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("Unable to load agent model default {worker_id}: {error}"))
            .map(|record| record.and_then(|(provider, model)| provider.zip(model))),
        _ => Ok(None),
    }
}

fn stop_live_session_runtime(state: &AppState, session_id: &str) -> Result<bool, String> {
    let had_runtime = if let Some(runtime) = state.remove_session_runtime(session_id)? {
        runtime.abort_active_run();
        true
    } else {
        false
    };
    state.clear_active_session_run(session_id)?;
    Ok(had_runtime)
}

fn load_or_capture_session_model_snapshot(
    connection: &Connection,
    state: &AppState,
    session_id: &str,
) -> Result<Option<SessionModelSnapshotRecord>, String> {
    if let Some(snapshot) = load_session_model_snapshot(connection, session_id)? {
        return Ok(Some(snapshot));
    }
    let Some(runtime) = maybe_runtime(&state.session_runtimes, session_id) else {
        return Ok(None);
    };
    let model_state = runtime.get_model_state()?;
    let Some(model) = model_state.current_model else {
        return Ok(None);
    };
    upsert_session_model_snapshot(
        connection,
        session_id,
        &model.provider,
        &model.id,
        Some(model.api.as_str()),
        "runtime_observed",
    )?;
    load_session_model_snapshot(connection, session_id)
}

fn load_session_model_snapshot(
    connection: &Connection,
    session_id: &str,
) -> Result<Option<SessionModelSnapshotRecord>, String> {
    connection
        .query_row(
            r#"
            SELECT provider, model_id, api
            FROM session_model_snapshots
            WHERE session_id = ?1
            LIMIT 1
            "#,
            [session_id],
            |row| {
                Ok(SessionModelSnapshotRecord {
                    provider: row.get::<_, String>(0)?,
                    model_id: row.get::<_, String>(1)?,
                    api: row.get::<_, Option<String>>(2)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("Unable to load session model snapshot {session_id}: {error}"))
}

fn upsert_session_model_snapshot(
    connection: &Connection,
    session_id: &str,
    provider: &str,
    model_id: &str,
    api: Option<&str>,
    source: &str,
) -> Result<(), String> {
    let now = Utc::now().to_rfc3339();
    connection
        .execute(
            r#"
            INSERT INTO session_model_snapshots (session_id, provider, model_id, api, source, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(session_id) DO UPDATE SET
                provider = excluded.provider,
                model_id = excluded.model_id,
                api = excluded.api,
                source = excluded.source,
                updated_at = excluded.updated_at
            "#,
            params![session_id, provider, model_id, api, source, now],
        )
        .map_err(|error| format!("Unable to save session model snapshot {session_id}: {error}"))?;
    Ok(())
}

fn load_model_limit_states(
    connection: &Connection,
    model_keys: &[String],
) -> Result<Vec<HarnessModelLimitState>, String> {
    let mut states = Vec::new();
    for model_key in model_keys {
        let Some(state) = load_model_limit_state_by_key(connection, model_key)? else {
            continue;
        };
        states.push(to_api_state(state));
    }
    Ok(states)
}

fn load_model_limit_state(
    connection: &Connection,
    model_ref: &HarnessModelRef,
) -> Result<Option<PersistedModelLimitState>, String> {
    load_model_limit_state_by_key(connection, &model_key(model_ref))
}

fn load_model_limit_state_by_key(
    connection: &Connection,
    model_key: &str,
) -> Result<Option<PersistedModelLimitState>, String> {
    connection
        .query_row(
            r#"
            SELECT provider, model_id, api, adapter, scope_key, is_capped, last_checked_at, capped_at, cleared_at, last_error, reason, metrics_json
            FROM model_limit_states
            WHERE model_key = ?1
            LIMIT 1
            "#,
            [model_key],
            |row| {
                let metrics_json = row.get::<_, Option<String>>(11)?;
                let metrics = metrics_json
                    .as_deref()
                    .map(|value| serde_json::from_str::<Vec<HarnessModelLimitMetricValue>>(value))
                    .transpose()
                    .map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            11,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })?
                    .unwrap_or_default();
                Ok(PersistedModelLimitState {
                    model_ref: HarnessModelRef {
                        provider: row.get::<_, String>(0)?,
                        model_id: row.get::<_, String>(1)?,
                        api: row.get::<_, Option<String>>(2)?,
                    },
                    usage_source: HarnessUsageSource {
                        adapter: row.get::<_, String>(3)?,
                        scope_key: row.get::<_, String>(4)?,
                    },
                    capped: row.get::<_, i64>(5)? != 0,
                    last_checked_at: row.get::<_, Option<String>>(6)?,
                    capped_at: row.get::<_, Option<String>>(7)?,
                    cleared_at: row.get::<_, Option<String>>(8)?,
                    last_error: row.get::<_, Option<String>>(9)?,
                    reason: row.get::<_, Option<String>>(10)?,
                    metrics,
                })
            },
        )
        .optional()
        .map_err(|error| format!("Unable to load model limit state {model_key}: {error}"))
}

fn save_model_limit_state(
    connection: &Connection,
    state: &PersistedModelLimitState,
) -> Result<(), String> {
    connection
        .execute(
            r#"
            INSERT INTO model_limit_states (
                model_key, provider, model_id, api, adapter, scope_key, is_capped,
                last_checked_at, capped_at, cleared_at, last_error, reason, metrics_json, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
            ON CONFLICT(model_key) DO UPDATE SET
                provider = excluded.provider,
                model_id = excluded.model_id,
                api = excluded.api,
                adapter = excluded.adapter,
                scope_key = excluded.scope_key,
                is_capped = excluded.is_capped,
                last_checked_at = excluded.last_checked_at,
                capped_at = excluded.capped_at,
                cleared_at = excluded.cleared_at,
                last_error = excluded.last_error,
                reason = excluded.reason,
                metrics_json = excluded.metrics_json,
                updated_at = excluded.updated_at
            "#,
            params![
                model_key(&state.model_ref),
                state.model_ref.provider,
                state.model_ref.model_id,
                state.model_ref.api,
                state.usage_source.adapter,
                state.usage_source.scope_key,
                if state.capped { 1 } else { 0 },
                state.last_checked_at,
                state.capped_at,
                state.cleared_at,
                state.last_error,
                state.reason,
                serde_json::to_string(&state.metrics)
                    .map_err(|error| format!("Unable to serialize model limit metrics: {error}"))?,
                Utc::now().to_rfc3339(),
            ],
        )
        .map_err(|error| {
            format!(
                "Unable to save model limit state {}: {error}",
                model_key(&state.model_ref)
            )
        })?;
    Ok(())
}

fn delete_model_limit_state(
    connection: &Connection,
    model_ref: &HarnessModelRef,
) -> Result<(), String> {
    connection
        .execute(
            "DELETE FROM model_limit_states WHERE model_key = ?1",
            [model_key(model_ref)],
        )
        .map_err(|error| {
            format!(
                "Unable to delete model limit state {}: {error}",
                model_key(model_ref)
            )
        })?;
    Ok(())
}

fn save_provider_usage_snapshot(
    connection: &Connection,
    adapter: &str,
    scope_key: &str,
    status: &str,
    raw_json: Option<&Value>,
    error_message: Option<&str>,
    next_poll_after_seconds: i64,
) -> Result<(), String> {
    let checked_at = Utc::now().to_rfc3339();
    let next_poll_after =
        (Utc::now() + chrono::Duration::seconds(next_poll_after_seconds)).to_rfc3339();
    connection
        .execute(
            r#"
            INSERT INTO provider_usage_snapshots (
                adapter, scope_key, checked_at, status, raw_json, error_message, next_poll_after
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(adapter, scope_key) DO UPDATE SET
                checked_at = excluded.checked_at,
                status = excluded.status,
                raw_json = excluded.raw_json,
                error_message = excluded.error_message,
                next_poll_after = excluded.next_poll_after
            "#,
            params![
                adapter,
                scope_key,
                checked_at,
                status,
                raw_json
                    .map(serde_json::to_string)
                    .transpose()
                    .map_err(|error| format!(
                        "Unable to serialize provider usage snapshot JSON: {error}"
                    ))?,
                error_message,
                next_poll_after,
            ],
        )
        .map_err(|error| {
            format!("Unable to save provider usage snapshot {adapter}/{scope_key}: {error}")
        })?;
    Ok(())
}

fn record_task_pause_event(
    connection: &Connection,
    task_id: &str,
    project_id: &str,
    assignment_id: Option<String>,
    reason: &str,
) {
    let _ = domain_events::record_event(
        connection,
        domain_events::DomainEventInput {
            project_id: Some(project_id.to_string()),
            topic: "task.model_limit_paused".into(),
            entity_type: "task".into(),
            entity_id: Some(task_id.to_string()),
            payload: serde_json::json!({
                "taskId": task_id,
                "assignmentId": assignment_id,
                "reason": reason,
                "action": "harness_model_limit_pause"
            }),
        },
    );
}

fn record_session_pause_event(connection: &Connection, session_id: &str, reason: &str) {
    let project_id = session_project_id(connection, session_id);
    let _ = domain_events::record_event(
        connection,
        domain_events::DomainEventInput {
            project_id,
            topic: "session.model_limit_paused".into(),
            entity_type: "session".into(),
            entity_id: Some(session_id.to_string()),
            payload: serde_json::json!({
                "sessionId": session_id,
                "reason": reason,
                "action": "harness_model_limit_pause"
            }),
        },
    );
}

fn session_project_id(connection: &Connection, session_id: &str) -> Option<String> {
    let context =
        crate::services::pi_sessions::find_session_context_for_session(session_id).ok()?;
    connection
        .query_row(
            "SELECT id FROM projects WHERE slug = ?1 LIMIT 1",
            [context.project_slug],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten()
}

fn load_provider_api_key(orchestra_root: &Path, provider_id: &str) -> Result<String, String> {
    let auth_path = orchestra_pi_auth_path(orchestra_root);
    let content = fs::read_to_string(&auth_path).map_err(|error| {
        format!(
            "Unable to read Orchestra-managed Pi auth.json {}: {error}",
            auth_path.display()
        )
    })?;
    let value: Value = serde_json::from_str(&content).map_err(|error| {
        format!(
            "Unable to parse Pi auth.json {}: {error}",
            auth_path.display()
        )
    })?;
    value
        .get(provider_id)
        .and_then(|entry| entry.get("key"))
        .and_then(Value::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            format!(
                "No API key is configured for provider {} in Settings → Harness.",
                provider_id
            )
        })
}

fn resolve_zai_usage_base_url(orchestra_root: &Path, provider_id: &str) -> Result<String, String> {
    let models_path = orchestra_pi_models_path(orchestra_root);
    if let Ok(content) = fs::read_to_string(&models_path) {
        if let Ok(parsed) = serde_json::from_str::<StoredModelsFile>(&content) {
            if let Some(provider) = parsed.providers.get(provider_id) {
                if let Some(base_url) = provider.base_url.as_deref() {
                    return Ok(derive_zai_usage_base_url(base_url));
                }
            }
        }
    }
    Ok("https://api.z.ai/api".into())
}

fn derive_zai_usage_base_url(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if let Some(stripped) = trimmed.strip_suffix("/v1") {
        return stripped.to_string();
    }
    if let Some((prefix, _)) = trimmed.split_once("/v1/") {
        return prefix.to_string();
    }
    trimmed.to_string()
}

fn parse_integer_metric(value: Option<&Value>) -> Option<i64> {
    value.and_then(Value::as_i64).or_else(|| {
        value
            .and_then(Value::as_f64)
            .map(|value| value.round() as i64)
    })
}

fn truncate_error_body(body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.len() <= 200 {
        trimmed.to_string()
    } else {
        format!("{}…", &trimmed[..200])
    }
}

fn model_key(model_ref: &HarnessModelRef) -> String {
    format!(
        "{}::{}::{}",
        model_ref.provider,
        model_ref.model_id,
        model_ref.api.clone().unwrap_or_default()
    )
}

fn to_api_state(state: PersistedModelLimitState) -> HarnessModelLimitState {
    HarnessModelLimitState {
        model_ref: state.model_ref,
        usage_source: state.usage_source,
        capped: state.capped,
        last_checked_at: state.last_checked_at,
        capped_at: state.capped_at,
        cleared_at: state.cleared_at,
        last_error: state.last_error,
        reason: state.reason,
        metrics: state.metrics,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        models::HarnessModelLimitRule,
        services::{database::apply_migrations, harness_settings},
    };
    use std::{
        env,
        net::TcpListener,
        path::PathBuf,
        thread,
        time::{SystemTime, UNIX_EPOCH},
    };

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
        env::temp_dir().join(suffix)
    }

    #[test]
    fn derives_zai_usage_base_from_v1_provider_url() {
        assert_eq!(
            derive_zai_usage_base_url("https://api.z.ai/api/v1"),
            "https://api.z.ai/api"
        );
        assert_eq!(
            derive_zai_usage_base_url("http://127.0.0.1:9999/api/v1"),
            "http://127.0.0.1:9999/api"
        );
    }

    #[test]
    fn normalizes_zai_quota_metrics() {
        let metrics = normalize_zai_quota_metrics(&serde_json::json!({
            "success": true,
            "data": {
                "limits": [
                    {"type": "TOKENS_LIMIT", "unit": 3, "percentage": 91, "nextResetTime": "2026-05-02T03:00:00Z"},
                    {"type": "TOKENS_LIMIT", "unit": 6, "percentage": 77, "nextResetTime": "2026-05-08T03:00:00Z"}
                ]
            }
        }))
        .expect("metrics should parse");

        assert_eq!(metrics.len(), 2);
        assert_eq!(metrics[0].metric_key, "rolling_5h_percent");
        assert_eq!(metrics[0].value, 91);
        assert_eq!(metrics[1].metric_key, "weekly_percent");
        assert_eq!(metrics[1].value, 77);
    }

    #[test]
    fn evaluates_policy_to_capped_when_metric_exceeds_threshold() {
        let policy = HarnessModelLimitPolicy {
            model_ref: HarnessModelRef {
                provider: "zai".into(),
                model_id: "glm-4.6".into(),
                api: Some("openai-compatible".into()),
            },
            usage_source: harness_settings::usage_source_for_model(&HarnessModelRef {
                provider: "zai".into(),
                model_id: "glm-4.6".into(),
                api: Some("openai-compatible".into()),
            }),
            rules: vec![HarnessModelLimitRule {
                metric_key: "rolling_5h_percent".into(),
                threshold_kind: "percent".into(),
                threshold_value: 90,
                action: "pause".into(),
            }],
            updated_at: None,
        };
        let snapshot = UsageSnapshot {
            metrics: vec![HarnessModelLimitMetricValue {
                metric_key: "rolling_5h_percent".into(),
                value: 92,
                unit: "percent".into(),
                next_reset_at: Some("2026-05-02T03:00:00Z".into()),
            }],
            source_label: "z.ai /monitor/usage/quota/limit".into(),
            raw_json: serde_json::json!({}),
        };

        let evaluation = evaluate_policy(&policy, &snapshot).expect("policy should evaluate");
        assert!(evaluation.capped);
        assert!(evaluation
            .reason
            .as_deref()
            .is_some_and(|reason| reason.contains("rolling_5h_percent")));
    }

    #[test]
    fn stores_and_loads_session_model_snapshots() {
        let connection = Connection::open_in_memory().expect("in-memory db should open");
        apply_migrations(&connection).expect("migrations should apply");

        upsert_session_model_snapshot(
            &connection,
            "session-1",
            "zai",
            "glm-4.6",
            Some("openai-compatible"),
            "runtime_observed",
        )
        .expect("snapshot should save");

        let snapshot = load_session_model_snapshot(&connection, "session-1")
            .expect("snapshot should load")
            .expect("snapshot should exist");
        assert_eq!(snapshot.provider, "zai");
        assert_eq!(snapshot.model_id, "glm-4.6");
        assert_eq!(snapshot.api.as_deref(), Some("openai-compatible"));
    }

    #[test]
    fn fetches_zai_usage_from_mock_server() {
        let root = unique_temp_dir("model-limits-zai");
        fs::create_dir_all(crate::services::orchestra_paths::orchestra_pi_agent_dir(
            &root,
        ))
        .expect("agent dir should create");
        fs::write(
            orchestra_pi_auth_path(&root),
            serde_json::json!({"zai": {"type": "api_key", "key": "token-123"}}).to_string(),
        )
        .expect("auth should write");

        let listener = TcpListener::bind("127.0.0.1:0").expect("listener should bind");
        let address = listener
            .local_addr()
            .expect("listener address should resolve");
        let server = tiny_http::Server::from_listener(listener, None).expect("server should start");
        let server_handle = thread::spawn(move || {
            if let Some(request) = server.incoming_requests().next() {
                assert_eq!(request.url(), "/api/monitor/usage/quota/limit");
                let response = tiny_http::Response::from_string(
                    serde_json::json!({
                        "code": 200,
                        "success": true,
                        "data": {
                            "limits": [
                                {"type": "TOKENS_LIMIT", "unit": 3, "percentage": 88, "nextResetTime": "2026-05-02T03:00:00Z"},
                                {"type": "TOKENS_LIMIT", "unit": 6, "percentage": 54, "nextResetTime": "2026-05-08T03:00:00Z"}
                            ]
                        }
                    })
                    .to_string(),
                );
                let _ = request.respond(response);
            }
        });

        fs::write(
            orchestra_pi_models_path(&root),
            serde_json::json!({
                "providers": {
                    "zai": {
                        "baseUrl": format!("http://{}/api/v1", address),
                        "api": "openai-completions",
                        "models": [{"id": "glm-4.6"}]
                    }
                }
            })
            .to_string(),
        )
        .expect("models should write");

        let snapshot = fetch_zai_usage_snapshot(&root, "zai").expect("snapshot should load");
        assert_eq!(snapshot.metrics.len(), 2);
        assert_eq!(snapshot.metrics[0].value, 88);
        server_handle.join().expect("server thread should join");
    }
}
