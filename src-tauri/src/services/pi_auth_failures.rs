use serde::Serialize;
use serde_json::Value;

pub const EMBEDDED_MODEL_AUTH_ERROR_PREFIX: &str = "__ORCHESTRA_MODEL_AUTH_ERROR__:";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedPiAuthFailure {
    pub kind: String,
    pub code: String,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    pub message: String,
    pub detail: String,
    pub settings_tab: String,
    pub settings_detail_tab: String,
    pub raw_message: String,
}

pub fn classify_model_auth_failure(
    raw_error: &str,
    provider_id: Option<&str>,
    model_id: Option<&str>,
) -> Option<NormalizedPiAuthFailure> {
    let raw_message = raw_error.trim();
    if raw_message.is_empty() {
        return None;
    }

    let normalized = raw_message.to_ascii_lowercase();
    let inferred_provider_id = provider_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| infer_provider_id(&normalized));
    let provider_name = inferred_provider_id
        .as_deref()
        .map(display_name_for_provider);

    if !is_auth_related(&normalized, inferred_provider_id.as_deref()) {
        return None;
    }

    let reason = if is_missing_auth(&normalized) {
        "missing"
    } else if is_expired_auth(&normalized) {
        "expired"
    } else if is_invalid_auth(&normalized) {
        "invalid"
    } else {
        "unknown"
    };

    let provider_label = provider_name
        .clone()
        .unwrap_or_else(|| "the selected provider".to_string());
    let message = match reason {
        "missing" => format!(
            "The selected model can’t run because {provider_label} isn’t connected in Harness."
        ),
        "expired" => format!(
            "The selected model can’t run because the {provider_label} sign-in has expired."
        ),
        "invalid" => format!(
            "The selected model can’t run because the {provider_label} credentials are invalid."
        ),
        _ => format!(
            "The selected model can’t run because Harness couldn’t authenticate {provider_label}."
        ),
    };
    let detail = match provider_name.as_deref() {
        Some(provider_name) => {
            format!("Reconnect {provider_name} in Settings → Harness → Setup, then retry.")
        }
        None => "Reconnect the provider in Settings → Harness → Setup, then retry.".into(),
    };

    Some(NormalizedPiAuthFailure {
        kind: "model_auth_required".into(),
        code: "model_auth_required".into(),
        reason: reason.into(),
        provider_id: inferred_provider_id,
        provider_name,
        model_id: model_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        message,
        detail,
        settings_tab: "harness".into(),
        settings_detail_tab: "setup".into(),
        raw_message: raw_message.into(),
    })
}

pub fn encode_embedded_model_auth_error(
    raw_error: &str,
    provider_id: Option<&str>,
    model_id: Option<&str>,
) -> String {
    match classify_model_auth_failure(raw_error, provider_id, model_id) {
        Some(details) => serde_json::to_string(&details)
            .map(|serialized| format!("{EMBEDDED_MODEL_AUTH_ERROR_PREFIX}{serialized}"))
            .unwrap_or_else(|_| raw_error.trim().to_string()),
        None => raw_error.trim().to_string(),
    }
}

pub fn attach_normalized_model_auth_error(
    event: &mut Value,
    raw_error: &str,
    provider_id: Option<&str>,
    model_id: Option<&str>,
) -> Option<NormalizedPiAuthFailure> {
    let normalized = classify_model_auth_failure(raw_error, provider_id, model_id)?;
    if let Some(object) = event.as_object_mut() {
        object.insert(
            "normalizedError".into(),
            serde_json::to_value(&normalized).unwrap_or(Value::Null),
        );
    }
    Some(normalized)
}

fn infer_provider_id(normalized_error: &str) -> Option<String> {
    if normalized_error.contains("openai-codex")
        || normalized_error.contains("openai codex")
        || normalized_error.contains("codex")
    {
        return Some("openai-codex".into());
    }
    if normalized_error.contains("github copilot")
        || normalized_error.contains("github-copilot")
        || normalized_error.contains("copilot")
    {
        return Some("github-copilot".into());
    }
    if normalized_error.contains("anthropic") {
        return Some("anthropic".into());
    }
    if normalized_error.contains("google gemini cli")
        || normalized_error.contains("google-gemini-cli")
    {
        return Some("google-gemini-cli".into());
    }
    if normalized_error.contains("openai") {
        return Some("openai".into());
    }
    None
}

fn display_name_for_provider(provider_id: &str) -> String {
    match provider_id {
        "anthropic" => "Anthropic".into(),
        "github-copilot" => "GitHub Copilot".into(),
        "google" => "Google".into(),
        "google-antigravity" => "Google Antigravity".into(),
        "google-gemini-cli" => "Google Gemini CLI".into(),
        "openai" => "OpenAI".into(),
        "openai-codex" => "OpenAI Codex".into(),
        _ => provider_id
            .split(['-', '_'])
            .filter(|segment| !segment.is_empty())
            .map(|segment| {
                let mut chars = segment.chars();
                match chars.next() {
                    Some(first) => {
                        format!("{}{}", first.to_ascii_uppercase(), chars.as_str())
                    }
                    None => String::new(),
                }
            })
            .collect::<Vec<_>>()
            .join(" "),
    }
}

fn is_auth_related(normalized_error: &str, provider_id: Option<&str>) -> bool {
    let auth_keywords = [
        "auth",
        "authenticate",
        "authentication",
        "api key",
        "api-key",
        "credential",
        "credentials",
        "token",
        "oauth",
        "sign in",
        "sign-in",
        "signed in",
        "login",
        "logged in",
        "unauthorized",
        "forbidden",
        "401",
        "403",
        "not connected",
        "not authenticated",
        "reconnect",
    ];
    let mentions_auth = auth_keywords
        .iter()
        .any(|keyword| normalized_error.contains(keyword));
    if mentions_auth {
        return true;
    }

    matches!(provider_id, Some("openai-codex") | Some("github-copilot"))
        && (normalized_error.contains("missing")
            || normalized_error.contains("expired")
            || normalized_error.contains("invalid"))
}

fn is_missing_auth(normalized_error: &str) -> bool {
    [
        "missing auth",
        "missing credential",
        "missing credentials",
        "missing api key",
        "api key required",
        "credentials required",
        "credential required",
        "not connected",
        "not authenticated",
        "not logged in",
        "not signed in",
        "login required",
        "sign in required",
        "must connect",
        "must authenticate",
        "connect ",
        "no credential",
        "no credentials",
        "no auth",
        "auth required",
    ]
    .iter()
    .any(|keyword| normalized_error.contains(keyword))
}

fn is_expired_auth(normalized_error: &str) -> bool {
    [
        "expired",
        "has expired",
        "token expired",
        "session expired",
        "sign-in expired",
        "reauth",
        "re-auth",
        "refresh your credentials",
    ]
    .iter()
    .any(|keyword| normalized_error.contains(keyword))
}

fn is_invalid_auth(normalized_error: &str) -> bool {
    [
        "invalid",
        "unauthorized",
        "forbidden",
        "401",
        "403",
        "incorrect api key",
        "bad credentials",
        "credentials are wrong",
        "authentication failed",
        "revoked",
    ]
    .iter()
    .any(|keyword| normalized_error.contains(keyword))
}

#[cfg(test)]
mod tests {
    use super::{
        classify_model_auth_failure, encode_embedded_model_auth_error,
        EMBEDDED_MODEL_AUTH_ERROR_PREFIX,
    };

    #[test]
    fn classifies_missing_openai_codex_auth() {
        let failure = classify_model_auth_failure(
            "OpenAI Codex missing credential in auth.json",
            None,
            Some("gpt-5.4"),
        )
        .expect("missing auth should classify");

        assert_eq!(failure.reason, "missing");
        assert_eq!(failure.provider_id.as_deref(), Some("openai-codex"));
        assert_eq!(failure.provider_name.as_deref(), Some("OpenAI Codex"));
        assert_eq!(failure.model_id.as_deref(), Some("gpt-5.4"));
        assert!(failure.message.contains("isn’t connected in Harness"));
        assert!(failure.detail.contains("Settings → Harness → Setup"));
    }

    #[test]
    fn classifies_expired_provider_auth() {
        let failure = classify_model_auth_failure(
            "Authentication failed because the OpenAI Codex token expired",
            Some("openai-codex"),
            None,
        )
        .expect("expired auth should classify");

        assert_eq!(failure.reason, "expired");
        assert!(failure.message.contains("sign-in has expired"));
    }

    #[test]
    fn classifies_invalid_provider_auth() {
        let failure = classify_model_auth_failure(
            "OpenAI Codex unauthorized (401 invalid credentials)",
            Some("openai-codex"),
            None,
        )
        .expect("invalid auth should classify");

        assert_eq!(failure.reason, "invalid");
        assert!(failure.message.contains("credentials are invalid"));
    }

    #[test]
    fn ignores_unrelated_runtime_errors() {
        assert!(classify_model_auth_failure("Pi RPC process exited unexpectedly", None, None)
            .is_none());
    }

    #[test]
    fn encodes_embedded_model_auth_errors_with_prefix() {
        let encoded = encode_embedded_model_auth_error(
            "OpenAI Codex missing credential in auth.json",
            Some("openai-codex"),
            None,
        );
        assert!(encoded.starts_with(EMBEDDED_MODEL_AUTH_ERROR_PREFIX));
    }
}
