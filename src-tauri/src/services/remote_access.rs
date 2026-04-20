use chrono::{Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    models::{
        RemoteAccessSettings, RemoteAccessSettingsInput, RemoteAuthResponse, RemoteDeviceRecord,
        RemotePairingCode, RemotePairingCodeInput, RemotePairingCompleteInput,
    },
    state::now_iso,
};

pub const REMOTE_SETTINGS_ID: &str = "singleton";
pub const DEFAULT_REMOTE_BIND_HOST: &str = "0.0.0.0";
pub const DEFAULT_REMOTE_PORT: u16 = 49500;
pub const DEFAULT_REMOTE_TAILSCALE_ENABLED: bool = false;
const PAIRING_TTL_MINUTES: i64 = 15;

pub fn effective_bind_host(settings: &RemoteAccessSettings) -> String {
    if settings.use_tailscale {
        "127.0.0.1".to_string()
    } else {
        settings.bind_host.clone()
    }
}

fn hash_secret(secret: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(secret.as_bytes());
    hex::encode(hasher.finalize())
}

fn normalize_pairing_code(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_uppercase()
}

fn generate_pairing_code() -> (String, String) {
    let raw = Uuid::new_v4().simple().to_string().to_ascii_uppercase();
    let normalized = raw[..8].to_string();
    let display = format!("{}-{}", &normalized[..4], &normalized[4..8]);
    (normalized, display)
}

fn generate_device_token() -> String {
    format!(
        "orc-remote-{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    )
}

fn ensure_settings_row(connection: &Connection) -> Result<(), String> {
    let now = now_iso();
    connection
        .execute(
            r#"
            INSERT INTO remote_access_settings (id, enabled, use_tailscale, bind_host, port, created_at, updated_at)
            VALUES (?1, 0, ?2, ?3, ?4, ?5, ?5)
            ON CONFLICT(id) DO NOTHING
            "#,
            params![
                REMOTE_SETTINGS_ID,
                if DEFAULT_REMOTE_TAILSCALE_ENABLED { 1 } else { 0 },
                DEFAULT_REMOTE_BIND_HOST,
                DEFAULT_REMOTE_PORT,
                now,
            ],
        )
        .map_err(|error| format!("Unable to ensure remote access settings row: {error}"))?;
    Ok(())
}

pub fn load_settings(connection: &Connection) -> Result<RemoteAccessSettings, String> {
    ensure_settings_row(connection)?;
    connection
        .query_row(
            r#"
            SELECT enabled, use_tailscale, bind_host, port
            FROM remote_access_settings
            WHERE id = ?1
            LIMIT 1
            "#,
            [REMOTE_SETTINGS_ID],
            |row| {
                Ok(RemoteAccessSettings {
                    enabled: row.get::<_, i64>(0)? != 0,
                    use_tailscale: row.get::<_, i64>(1)? != 0,
                    bind_host: row.get(2)?,
                    port: row.get::<_, i64>(3)? as u16,
                    base_url: None,
                    websocket_url: None,
                    lan_base_url: None,
                    web_url: None,
                    tailscale_url: None,
                    tailscale_web_url: None,
                    started_at: None,
                    last_error: None,
                })
            },
        )
        .map_err(|error| format!("Unable to load remote access settings: {error}"))
}

pub fn update_settings(
    connection: &Connection,
    input: RemoteAccessSettingsInput,
) -> Result<RemoteAccessSettings, String> {
    ensure_settings_row(connection)?;
    let current = load_settings(connection)?;
    let bind_host = input
        .bind_host
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(current.bind_host.as_str())
        .to_string();
    let use_tailscale = input.use_tailscale;
    let bind_host = if use_tailscale {
        "127.0.0.1".to_string()
    } else {
        bind_host
    };
    let port = input.port.unwrap_or(current.port).clamp(1, u16::MAX as u16);
    let now = now_iso();
    connection
        .execute(
            r#"
            UPDATE remote_access_settings
            SET enabled = ?2,
                use_tailscale = ?3,
                bind_host = ?4,
                port = ?5,
                updated_at = ?6
            WHERE id = ?1
            "#,
            params![
                REMOTE_SETTINGS_ID,
                if input.enabled { 1 } else { 0 },
                if use_tailscale { 1 } else { 0 },
                bind_host,
                i64::from(port),
                now,
            ],
        )
        .map_err(|error| format!("Unable to update remote access settings: {error}"))?;
    load_settings(connection)
}

fn cleanup_expired_pairing_codes(connection: &Connection) -> Result<(), String> {
    let now = now_iso();
    connection
        .execute(
            "DELETE FROM remote_pairing_codes WHERE consumed_at IS NOT NULL OR expires_at <= ?1",
            [now],
        )
        .map_err(|error| format!("Unable to cleanup expired pairing codes: {error}"))?;
    Ok(())
}

pub fn list_pairing_codes(connection: &Connection) -> Result<Vec<RemotePairingCode>, String> {
    cleanup_expired_pairing_codes(connection)?;
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, display_code, created_at, expires_at, consumed_at
            FROM remote_pairing_codes
            ORDER BY created_at DESC
            "#,
        )
        .map_err(|error| format!("Unable to prepare pairing code query: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(RemotePairingCode {
                id: row.get(0)?,
                code: None,
                display_code: row.get(1)?,
                created_at: row.get(2)?,
                expires_at: row.get(3)?,
                consumed_at: row.get(4)?,
            })
        })
        .map_err(|error| format!("Unable to query pairing codes: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read pairing codes: {error}"))
}

pub fn create_pairing_code(
    connection: &Connection,
    _input: RemotePairingCodeInput,
) -> Result<RemotePairingCode, String> {
    cleanup_expired_pairing_codes(connection)?;
    let (normalized_code, display_code) = generate_pairing_code();
    let created_at = now_iso();
    let expires_at = (Utc::now() + Duration::minutes(PAIRING_TTL_MINUTES)).to_rfc3339();
    let id = format!("remote-pair-{}", Uuid::new_v4().simple());
    connection
        .execute(
            r#"
            INSERT INTO remote_pairing_codes (id, code_hash, display_code, created_at, expires_at, consumed_at)
            VALUES (?1, ?2, ?3, ?4, ?5, NULL)
            "#,
            params![
                id,
                hash_secret(&normalized_code),
                display_code,
                created_at,
                expires_at,
            ],
        )
        .map_err(|error| format!("Unable to create pairing code: {error}"))?;

    Ok(RemotePairingCode {
        id,
        code: Some(display_code.clone()),
        display_code,
        created_at,
        expires_at,
        consumed_at: None,
    })
}

fn read_device(connection: &Connection, device_id: &str) -> Result<RemoteDeviceRecord, String> {
    connection
        .query_row(
            r#"
            SELECT d.id, d.label, d.platform, d.created_at, d.updated_at, d.last_seen_at, d.revoked_at,
                   d.push_token IS NOT NULL
            FROM remote_devices d
            WHERE d.id = ?1
            LIMIT 1
            "#,
            [device_id],
            |row| {
                Ok(RemoteDeviceRecord {
                    id: row.get(0)?,
                    label: row.get(1)?,
                    platform: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                    last_seen_at: row.get(5)?,
                    revoked_at: row.get(6)?,
                    push_token_configured: row.get::<_, i64>(7)? != 0,
                    active_client_count: 0,
                })
            },
        )
        .map_err(|error| format!("Unable to read remote device {device_id}: {error}"))
}

pub fn list_devices(connection: &Connection) -> Result<Vec<RemoteDeviceRecord>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT d.id, d.label, d.platform, d.created_at, d.updated_at, d.last_seen_at, d.revoked_at,
                   d.push_token IS NOT NULL
            FROM remote_devices d
            ORDER BY d.revoked_at IS NOT NULL ASC, d.updated_at DESC, d.created_at DESC
            "#,
        )
        .map_err(|error| format!("Unable to prepare remote devices query: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(RemoteDeviceRecord {
                id: row.get(0)?,
                label: row.get(1)?,
                platform: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
                last_seen_at: row.get(5)?,
                revoked_at: row.get(6)?,
                push_token_configured: row.get::<_, i64>(7)? != 0,
                active_client_count: 0,
            })
        })
        .map_err(|error| format!("Unable to query remote devices: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read remote devices: {error}"))
}

pub fn revoke_device(
    connection: &Connection,
    device_id: &str,
) -> Result<RemoteDeviceRecord, String> {
    let now = now_iso();
    connection
        .execute(
            "UPDATE remote_devices SET revoked_at = ?2, updated_at = ?2 WHERE id = ?1",
            params![device_id, now],
        )
        .map_err(|error| format!("Unable to revoke remote device {device_id}: {error}"))?;
    connection
        .execute(
            "UPDATE remote_device_tokens SET revoked_at = ?2, updated_at = ?2 WHERE device_id = ?1 AND revoked_at IS NULL",
            params![device_id, now],
        )
        .map_err(|error| format!("Unable to revoke remote device tokens for {device_id}: {error}"))?;
    read_device(connection, device_id)
}

pub fn set_device_push_token(
    connection: &Connection,
    device_id: &str,
    push_token: Option<&str>,
) -> Result<RemoteDeviceRecord, String> {
    let now = now_iso();
    connection
        .execute(
            "UPDATE remote_devices SET push_token = ?2, updated_at = ?3 WHERE id = ?1",
            params![
                device_id,
                push_token.map(str::trim).filter(|value| !value.is_empty()),
                now
            ],
        )
        .map_err(|error| {
            format!("Unable to update push token for remote device {device_id}: {error}")
        })?;
    read_device(connection, device_id)
}

pub fn consume_pairing_code(
    connection: &Connection,
    input: RemotePairingCompleteInput,
) -> Result<RemoteAuthResponse, String> {
    cleanup_expired_pairing_codes(connection)?;
    let normalized_code = normalize_pairing_code(&input.code);
    if normalized_code.is_empty() {
        return Err("Pairing code is required".into());
    }

    let pairing_id = connection
        .query_row(
            r#"
            SELECT id
            FROM remote_pairing_codes
            WHERE code_hash = ?1 AND consumed_at IS NULL AND expires_at > ?2
            LIMIT 1
            "#,
            params![hash_secret(&normalized_code), now_iso()],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to lookup pairing code: {error}"))?
        .ok_or_else(|| "Pairing code is invalid or expired".to_string())?;

    let device_id = format!("remote-device-{}", Uuid::new_v4().simple());
    let token_id = format!("remote-token-{}", Uuid::new_v4().simple());
    let issued_token = generate_device_token();
    let now = now_iso();
    let label = input
        .label
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Mobile device")
        .to_string();
    let platform = input
        .platform
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown")
        .to_string();

    connection
        .execute(
            r#"
            INSERT INTO remote_devices (id, label, platform, push_token, created_at, updated_at, last_seen_at, revoked_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?5, NULL)
            "#,
            params![
                device_id,
                label,
                platform,
                input.push_token.as_deref().map(str::trim).filter(|value| !value.is_empty()),
                now,
            ],
        )
        .map_err(|error| format!("Unable to create remote device: {error}"))?;
    connection
        .execute(
            r#"
            INSERT INTO remote_device_tokens (id, device_id, token_hash, created_at, updated_at, last_used_at, revoked_at)
            VALUES (?1, ?2, ?3, ?4, ?4, ?4, NULL)
            "#,
            params![token_id, device_id, hash_secret(&issued_token), now],
        )
        .map_err(|error| format!("Unable to create remote device token: {error}"))?;
    connection
        .execute(
            "UPDATE remote_pairing_codes SET consumed_at = ?2 WHERE id = ?1",
            params![pairing_id, now],
        )
        .map_err(|error| format!("Unable to mark pairing code as consumed: {error}"))?;

    Ok(RemoteAuthResponse {
        device: read_device(connection, &device_id)?,
        token: issued_token,
        base_url: None,
        websocket_url: None,
        default_project_id: Some("orchestra".into()),
    })
}

pub fn authenticate_token(
    connection: &Connection,
    token: &str,
) -> Result<RemoteDeviceRecord, String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("Missing remote device token".into());
    }

    let hashed = hash_secret(token);
    let now = now_iso();
    let device_id = connection
        .query_row(
            r#"
            SELECT d.id
            FROM remote_device_tokens t
            JOIN remote_devices d ON d.id = t.device_id
            WHERE t.token_hash = ?1 AND t.revoked_at IS NULL AND d.revoked_at IS NULL
            LIMIT 1
            "#,
            [hashed],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to validate remote device token: {error}"))?
        .ok_or_else(|| "Invalid remote device token".to_string())?;

    connection
        .execute(
            "UPDATE remote_device_tokens SET last_used_at = ?2, updated_at = ?2 WHERE token_hash = ?1",
            params![hash_secret(token), now],
        )
        .map_err(|error| format!("Unable to update remote token last-used timestamp: {error}"))?;
    connection
        .execute(
            "UPDATE remote_devices SET last_seen_at = ?2, updated_at = ?2 WHERE id = ?1",
            params![device_id, now],
        )
        .map_err(|error| format!("Unable to update remote device last-seen timestamp: {error}"))?;

    read_device(connection, &device_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::database;

    #[test]
    fn creates_and_consumes_pairing_code_into_device_token() {
        let connection = Connection::open_in_memory().expect("in-memory db should open");
        database::apply_migrations(&connection).expect("migrations should succeed");

        let pairing = create_pairing_code(
            &connection,
            RemotePairingCodeInput {
                label: None,
                platform: None,
            },
        )
        .expect("pairing code should create");

        let auth = consume_pairing_code(
            &connection,
            RemotePairingCompleteInput {
                code: pairing
                    .code
                    .clone()
                    .expect("pairing code should be returned once"),
                label: Some("Test phone".into()),
                platform: Some("ios".into()),
                push_token: Some("push-token".into()),
            },
        )
        .expect("pairing code should consume into a device");

        assert_eq!(auth.device.label, "Test phone");
        assert_eq!(auth.device.platform, "ios");
        assert!(auth.device.push_token_configured);
        assert!(authenticate_token(&connection, &auth.token).is_ok());
    }

    #[test]
    fn revoking_device_invalidates_existing_tokens() {
        let connection = Connection::open_in_memory().expect("in-memory db should open");
        database::apply_migrations(&connection).expect("migrations should succeed");

        let pairing = create_pairing_code(
            &connection,
            RemotePairingCodeInput {
                label: None,
                platform: None,
            },
        )
        .expect("pairing code should create");
        let auth = consume_pairing_code(
            &connection,
            RemotePairingCompleteInput {
                code: pairing
                    .code
                    .clone()
                    .expect("pairing code should be returned once"),
                label: Some("Android phone".into()),
                platform: Some("android".into()),
                push_token: None,
            },
        )
        .expect("pairing should succeed");

        revoke_device(&connection, &auth.device.id).expect("device should revoke");
        assert!(authenticate_token(&connection, &auth.token).is_err());
    }
}
