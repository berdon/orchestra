use std::time::Duration;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use p256::{ecdsa::SigningKey, elliptic_curve::rand_core::OsRng};
use rusqlite::{params, Connection};
use tauri::{AppHandle, Manager};
use web_push::{
    request_builder, ContentEncoding, SubscriptionInfo, Urgency, VapidSignatureBuilder,
    WebPushError, WebPushMessageBuilder,
};

use crate::{
    models::{NotificationEventType, NotificationIntent, RemoteWebPushConfig},
    services::remote_access,
    state::AppState,
};

const STORED_WEB_PUSH_KIND: &str = "web_push";
const VAPID_SUBJECT: &str = "mailto:notifications@orchestra.invalid";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct StoredWebPushSubscription {
    kind: String,
    subscription: SubscriptionInfo,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct WebPushTarget {
    device_id: String,
    subscription: SubscriptionInfo,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WebPushNotificationPayload<'a> {
    version: u8,
    intent: &'a NotificationIntent,
}

fn generate_vapid_key_pair() -> (String, String) {
    let signing_key = SigningKey::random(&mut OsRng);
    let private_key = URL_SAFE_NO_PAD.encode(signing_key.to_bytes());
    let public_key = URL_SAFE_NO_PAD.encode(
        signing_key
            .verifying_key()
            .to_encoded_point(false)
            .as_bytes(),
    );
    (public_key, private_key)
}

fn get_or_create_vapid_key_pair(connection: &Connection) -> Result<(String, String), String> {
    let _ = remote_access::load_settings(connection)?;
    let existing = connection
        .query_row(
            r#"
            SELECT vapid_public_key, vapid_private_key
            FROM remote_access_settings
            WHERE id = ?1
            LIMIT 1
            "#,
            [remote_access::REMOTE_SETTINGS_ID],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                ))
            },
        )
        .map_err(|error| format!("Unable to load web push VAPID keys: {error}"))?;

    if let (Some(public_key), Some(private_key)) = existing {
        return Ok((public_key, private_key));
    }

    let (public_key, private_key) = generate_vapid_key_pair();
    connection
        .execute(
            r#"
            UPDATE remote_access_settings
            SET vapid_public_key = ?2,
                vapid_private_key = ?3,
                updated_at = ?4
            WHERE id = ?1
            "#,
            params![
                remote_access::REMOTE_SETTINGS_ID,
                public_key,
                private_key,
                crate::state::now_iso(),
            ],
        )
        .map_err(|error| format!("Unable to persist web push VAPID keys: {error}"))?;

    Ok((public_key, private_key))
}

pub fn load_remote_web_push_config(connection: &Connection) -> Result<RemoteWebPushConfig, String> {
    let (public_key, _) = get_or_create_vapid_key_pair(connection)?;
    Ok(RemoteWebPushConfig {
        supported: true,
        vapid_public_key: Some(public_key),
    })
}

fn parse_stored_web_push_subscription(raw: &str) -> Option<SubscriptionInfo> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    serde_json::from_str::<StoredWebPushSubscription>(trimmed)
        .ok()
        .filter(|stored| stored.kind == STORED_WEB_PUSH_KIND)
        .map(|stored| stored.subscription)
        .or_else(|| serde_json::from_str::<SubscriptionInfo>(trimmed).ok())
}

fn load_eligible_web_push_targets(
    connection: &Connection,
    _state: &AppState,
) -> Result<Vec<WebPushTarget>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, push_token
            FROM remote_devices
            WHERE revoked_at IS NULL
              AND push_token IS NOT NULL
            ORDER BY updated_at DESC, id ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare remote web push query: {error}"))?;

    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("Unable to query remote web push targets: {error}"))?;

    let mut targets = Vec::new();
    for row in rows {
        let (device_id, raw_token) =
            row.map_err(|error| format!("Unable to read remote web push target: {error}"))?;
        if let Some(subscription) = parse_stored_web_push_subscription(&raw_token) {
            targets.push(WebPushTarget {
                device_id,
                subscription,
            });
        }
    }

    Ok(targets)
}

fn intent_urgency(intent: &NotificationIntent) -> Urgency {
    match intent.event_type {
        NotificationEventType::MailboxMessageReceived => Urgency::Normal,
        NotificationEventType::TaskAwaitingUserApproval
        | NotificationEventType::TaskAwaitingUserIntervention
        | NotificationEventType::TaskAssignedToUser => Urgency::High,
    }
}

fn send_web_push_message(
    client: &reqwest::blocking::Client,
    private_key: &str,
    subscription: &SubscriptionInfo,
    intent: &NotificationIntent,
) -> Result<(), WebPushError> {
    let mut signature_builder = VapidSignatureBuilder::from_base64(private_key, subscription)?;
    signature_builder.add_claim("sub", VAPID_SUBJECT);
    let signature = signature_builder.build()?;

    let payload = serde_json::to_vec(&WebPushNotificationPayload { version: 1, intent })
        .map_err(|_| WebPushError::Unspecified)?;

    let mut message_builder = WebPushMessageBuilder::new(subscription);
    message_builder.set_ttl(60 * 60 * 24);
    message_builder.set_urgency(intent_urgency(intent));
    message_builder.set_payload(ContentEncoding::Aes128Gcm, payload.as_slice());
    message_builder.set_vapid_signature(signature);

    let request = request_builder::build_request::<Vec<u8>>(message_builder.build()?);
    let mut builder = client.request(reqwest::Method::POST, request.uri().to_string());
    for (name, value) in request.headers() {
        if let Ok(value) = value.to_str() {
            builder = builder.header(name.as_str(), value);
        }
    }
    let response = builder
        .body(request.body().clone())
        .send()
        .map_err(|_| WebPushError::Unspecified)?;
    let status = http02::StatusCode::from_u16(response.status().as_u16())
        .unwrap_or(http02::StatusCode::INTERNAL_SERVER_ERROR);
    let body = response
        .bytes()
        .map_err(|_| WebPushError::Unspecified)?
        .to_vec();
    request_builder::parse_response(status, body)
}

fn dispatch_web_push_notifications_with<SendFn>(
    connection: &Connection,
    targets: Vec<WebPushTarget>,
    intent: &NotificationIntent,
    send: SendFn,
) -> Result<bool, String>
where
    SendFn: Fn(&WebPushTarget, &NotificationIntent) -> Result<(), WebPushError>,
{
    if targets.is_empty() {
        return Ok(false);
    }

    let mut delivered = 0usize;
    let mut failures = Vec::new();

    for target in targets {
        match send(&target, intent) {
            Ok(()) => delivered += 1,
            Err(WebPushError::EndpointNotValid(_)) | Err(WebPushError::EndpointNotFound(_)) => {
                let _ = remote_access::set_device_push_token(connection, &target.device_id, None);
                failures.push(format!("{}:subscription_invalid", target.device_id));
            }
            Err(error) => failures.push(format!(
                "{}:{}",
                target.device_id,
                error.short_description()
            )),
        }
    }

    if delivered > 0 {
        Ok(true)
    } else if !failures.is_empty() {
        Err(format!(
            "Unable to deliver remote web push notification {}: {}",
            intent.id,
            failures.join(", ")
        ))
    } else {
        Ok(false)
    }
}

pub fn deliver_remote_web_push_notification(
    app: &AppHandle,
    connection: &Connection,
    intent: &NotificationIntent,
) -> Result<bool, String> {
    let state = app.state::<AppState>();
    let targets = load_eligible_web_push_targets(connection, state.inner())?;
    if targets.is_empty() {
        return Ok(false);
    }
    let (_, private_key) = get_or_create_vapid_key_pair(connection)?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| format!("Unable to build remote web push client: {error}"))?;

    dispatch_web_push_notifications_with(connection, targets, intent, |target, intent| {
        send_web_push_message(&client, &private_key, &target.subscription, intent)
    })
}

#[cfg(test)]
mod tests {
    use super::{
        dispatch_web_push_notifications_with, load_eligible_web_push_targets,
        parse_stored_web_push_subscription, StoredWebPushSubscription, WebPushTarget,
    };
    use crate::{
        models::{
            NotificationEventType, NotificationIntent, RemotePairingCodeInput,
            RemotePairingCompleteInput,
        },
        services::{database, remote_access, tool_bridge},
        state::AppState,
    };
    use rusqlite::{params, Connection};
    use web_push::{request_builder, SubscriptionInfo};

    fn seed_device(connection: &Connection, id: &str, push_token: Option<&str>) {
        let now = crate::state::now_iso();
        connection
            .execute(
                r#"
                INSERT INTO remote_devices (id, label, platform, push_token, created_at, updated_at, last_seen_at, revoked_at)
                VALUES (?1, ?2, 'browser', ?3, ?4, ?4, ?4, NULL)
                "#,
                params![id, format!("Device {id}"), push_token, now],
            )
            .expect("device should seed");
    }

    fn subscription() -> SubscriptionInfo {
        SubscriptionInfo::new(
            "https://push.example.test/send/abc",
            "BA1Hxzyi1R7z6qY7cmR1g9xNx7V1Gwb7VwQeXW1p9moeqsV6bSVLQn2GX7VtT-LfFQ7vEW7fVrS3fy4H3R2mS70",
            "m7fC4G3m5zvW1o9d3gP9sQ",
        )
    }

    fn stored_subscription_json() -> String {
        serde_json::to_string(&StoredWebPushSubscription {
            kind: "web_push".into(),
            subscription: subscription(),
        })
        .expect("subscription should serialize")
    }

    fn notification_intent() -> NotificationIntent {
        NotificationIntent {
            id: "notification-1".into(),
            event_type: NotificationEventType::TaskAssignedToUser,
            title: "Orchestra — Task assigned to you".into(),
            body: "Body".into(),
            tag: "task-attention:task.assigned_to_user:task-1".into(),
            project_id: Some("project-1".into()),
            task_id: Some("task-1".into()),
            delivery_id: None,
            action: None,
            occurred_at: "2026-05-05T00:00:00Z".into(),
        }
    }

    #[test]
    fn parses_stored_web_push_subscription_wrapper() {
        let parsed = parse_stored_web_push_subscription(&stored_subscription_json())
            .expect("wrapped subscription should parse");
        assert_eq!(parsed, subscription());
    }

    #[test]
    fn load_targets_include_subscribed_hosted_web_devices_even_when_foreground() {
        let connection = Connection::open_in_memory().expect("db should open");
        database::apply_migrations(&connection).expect("migrations should apply");
        seed_device(
            &connection,
            "device-foreground",
            Some(&stored_subscription_json()),
        );
        seed_device(
            &connection,
            "device-background",
            Some(&stored_subscription_json()),
        );
        seed_device(&connection, "device-legacy", Some("native-token"));

        let state = AppState::new(tool_bridge::dummy_tool_bridge_config(
            "web-push-active-client-test",
        ));
        state
            .register_remote_client(
                "client-1",
                "hosted_web",
                Some("device-foreground".into()),
                Some("Foreground Browser".into()),
                None,
            )
            .expect("client should register");
        state
            .register_remote_client(
                "client-2",
                "hosted_web",
                Some("device-background".into()),
                Some("Background Browser".into()),
                None,
            )
            .expect("second client should register");
        state
            .set_remote_client_foregrounded("client-2", false)
            .expect("backgrounded state should update");

        let targets =
            load_eligible_web_push_targets(&connection, &state).expect("targets should load");
        assert_eq!(targets.len(), 2);
        assert_eq!(targets[0].device_id, "device-background");
        assert_eq!(targets[1].device_id, "device-foreground");
    }

    #[test]
    fn dispatch_clears_stale_subscriptions_without_failing_other_targets() {
        let connection = Connection::open_in_memory().expect("db should open");
        database::apply_migrations(&connection).expect("migrations should apply");
        seed_device(
            &connection,
            "device-stale",
            Some(&stored_subscription_json()),
        );
        seed_device(
            &connection,
            "device-good",
            Some(&stored_subscription_json()),
        );

        let targets = vec![
            WebPushTarget {
                device_id: "device-stale".into(),
                subscription: subscription(),
            },
            WebPushTarget {
                device_id: "device-good".into(),
                subscription: subscription(),
            },
        ];

        let delivered = dispatch_web_push_notifications_with(
            &connection,
            targets,
            &notification_intent(),
            |target, _intent| {
                if target.device_id == "device-stale" {
                    request_builder::parse_response(http02::StatusCode::GONE, vec![])
                } else {
                    Ok(())
                }
            },
        )
        .expect("fanout should succeed when one target delivers");

        assert!(delivered);
        let stale_token: Option<String> = connection
            .query_row(
                "SELECT push_token FROM remote_devices WHERE id = 'device-stale'",
                [],
                |row| row.get(0),
            )
            .expect("stale device should remain readable");
        assert!(stale_token.is_none());
    }

    #[test]
    fn remote_access_pairing_still_accepts_existing_push_token_field() {
        let connection = Connection::open_in_memory().expect("db should open");
        database::apply_migrations(&connection).expect("migrations should apply");
        let pairing = remote_access::create_pairing_code(
            &connection,
            RemotePairingCodeInput {
                label: Some("Browser".into()),
                platform: Some("browser".into()),
            },
        )
        .expect("pairing code should create");
        let auth = remote_access::consume_pairing_code(
            &connection,
            RemotePairingCompleteInput {
                code: pairing.code.expect("code should exist"),
                label: Some("Browser".into()),
                platform: Some("browser".into()),
                push_token: Some(stored_subscription_json()),
            },
        )
        .expect("pairing should consume");
        assert!(auth.device.push_token_configured);
    }
}
