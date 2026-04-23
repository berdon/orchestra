use std::{
    env, fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
};

use tauri::{path::BaseDirectory, AppHandle, Manager};

use crate::{
    models::{AuthorizationContext, OrchestraToolDefinition},
    services::{harness_settings, pi_sessions, tool_bridge::ToolBridgeConfig},
};

#[derive(Debug, Clone)]
pub struct InteractivePiLaunchSpec {
    pub executable: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
    pub temp_home_dir: Option<PathBuf>,
}

pub fn resolve_orchestra_extension_path(app: Option<&AppHandle>) -> Result<PathBuf, String> {
    if let Some(path) = env::var_os("ORCHESTRA_EXTENSION_PATH") {
        let path = PathBuf::from(path);
        if path.exists() {
            return Ok(path);
        }
    }

    if let Some(project_root) = env::var_os("ORCHESTRA_PROJECT_ROOT") {
        let fallback = PathBuf::from(project_root).join("extensions/orchestra-tools.ts");
        if fallback.exists() {
            return Ok(fallback);
        }
    }

    if let Some(app) = app {
        let path = app
            .path()
            .resolve("extensions/orchestra-tools.ts", BaseDirectory::Resource)
            .map_err(|error| {
                format!("Unable to resolve packaged Orchestra extension path: {error}")
            })?;
        if path.exists() {
            return Ok(path);
        }
    }

    let fallback = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")))
        .join("extensions/orchestra-tools.ts");
    if fallback.exists() {
        return Ok(fallback);
    }

    Err(format!(
        "Unable to resolve Orchestra extension path. Checked ORCHESTRA_EXTENSION_PATH, ORCHESTRA_PROJECT_ROOT/extensions/orchestra-tools.ts, packaged resources, and {}",
        fallback.display()
    ))
}

pub fn build_interactive_launch_spec(
    project_root: &Path,
    session_dir: &Path,
    session_path: &Path,
    session_id: &str,
    bridge_config: &ToolBridgeConfig,
    authorization_context: Option<&AuthorizationContext>,
    allowed_tools: &[OrchestraToolDefinition],
    app: Option<&AppHandle>,
) -> Result<InteractivePiLaunchSpec, String> {
    let executable = pi_sessions::resolve_pi_executable(None)?;
    let extension_path = resolve_orchestra_extension_path(app)?;
    let extra_extensions = harness_settings::get_pi_runtime_settings()?.extra_extensions;
    let temp_home_dir = prepare_terminal_home_dir(session_id, &executable)?;

    let mut args = vec![
        "--session".to_string(),
        session_path.display().to_string(),
        "--session-dir".to_string(),
        session_dir.display().to_string(),
        "--no-extensions".to_string(),
        "--extension".to_string(),
        extension_path.display().to_string(),
    ];
    for extension in extra_extensions {
        args.push("--extension".to_string());
        args.push(extension);
    }

    let mut env = vec![
        ("TERM".to_string(), "xterm-256color".to_string()),
        ("COLORTERM".to_string(), "truecolor".to_string()),
        (
            "ORCHESTRA_BRIDGE_URL".to_string(),
            bridge_config.url.clone(),
        ),
        (
            "ORCHESTRA_BRIDGE_TOKEN".to_string(),
            bridge_config.token.clone(),
        ),
        (
            "ORCHESTRA_BRIDGE_INSTANCE_ID".to_string(),
            bridge_config.instance_id.clone(),
        ),
        (
            "ORCHESTRA_BRIDGE_CLIENT_ID".to_string(),
            format!("orc-chat-{}", uuid::Uuid::new_v4().simple()),
        ),
        (
            "ORCHESTRA_BRIDGE_SESSION_ID".to_string(),
            session_id.to_string(),
        ),
        (
            "ORCHESTRA_ALLOWED_COMMANDS_JSON".to_string(),
            serde_json::to_string(allowed_tools)
                .map_err(|error| format!("Unable to serialize allowed tools: {error}"))?,
        ),
        (
            "ORCHESTRA_AUTH_CONTEXT_JSON".to_string(),
            serde_json::to_string(&authorization_context)
                .map_err(|error| format!("Unable to serialize authorization context: {error}"))?,
        ),
    ];

    if let Some(temp_home_dir) = temp_home_dir.as_ref() {
        env.push(("HOME".to_string(), temp_home_dir.display().to_string()));
        if let Some(prefix) = infer_npm_prefix(&executable, temp_home_dir) {
            let prefix = prefix.display().to_string();
            env.push(("NPM_CONFIG_PREFIX".to_string(), prefix.clone()));
            env.push(("npm_config_prefix".to_string(), prefix));
        }
    }

    Ok(InteractivePiLaunchSpec {
        executable,
        args,
        cwd: project_root.to_path_buf(),
        env,
        temp_home_dir,
    })
}

pub fn spawn_interactive_pi(spec: &InteractivePiLaunchSpec) -> Result<Child, String> {
    let mut command = Command::new(&spec.executable);
    pi_sessions::apply_user_shell_environment(&mut command);
    let child = command
        .args(&spec.args)
        .envs(spec.env.iter().map(|(key, value)| (key, value)))
        .current_dir(&spec.cwd)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| {
            format!(
                "Unable to launch interactive pi session {}: {error}",
                spec.executable.display()
            )
        })?;
    Ok(child)
}

pub fn cleanup_temp_home_dir(path: Option<&Path>) {
    if let Some(path) = path {
        let _ = fs::remove_dir_all(path);
    }
}

fn prepare_terminal_home_dir(
    session_id: &str,
    pi_executable: &Path,
) -> Result<Option<PathBuf>, String> {
    let real_home = env::var("HOME").map(PathBuf::from).ok();
    let agent_dir = real_home
        .as_ref()
        .map(|home| home.join(".pi").join("agent"))
        .filter(|dir| dir.exists());
    let Some(agent_dir) = agent_dir else {
        return Ok(None);
    };

    let temp_home_dir = env::temp_dir().join(format!(
        "orchestra-orc-home-{}-{}",
        sanitize_for_path(session_id),
        std::process::id()
    ));
    let temp_agent_dir = temp_home_dir.join(".pi").join("agent");
    fs::create_dir_all(&temp_agent_dir).map_err(|error| {
        format!(
            "Unable to create temporary orc agent directory {}: {error}",
            temp_agent_dir.display()
        )
    })?;

    copy_if_exists(
        &agent_dir.join("auth.json"),
        &temp_agent_dir.join("auth.json"),
    )?;
    copy_if_exists(
        &agent_dir.join("models.json"),
        &temp_agent_dir.join("models.json"),
    )?;
    copy_filtered_settings(
        &agent_dir.join("settings.json"),
        &temp_agent_dir.join("settings.json"),
    )?;

    if let Some(prefix) = infer_npm_prefix(pi_executable, &temp_home_dir) {
        let npmrc_path = temp_home_dir.join(".npmrc");
        fs::write(&npmrc_path, format!("prefix={}\n", prefix.display())).map_err(|error| {
            format!(
                "Unable to write temporary orc npmrc {}: {error}",
                npmrc_path.display()
            )
        })?;
    }

    Ok(Some(temp_home_dir))
}

fn sanitize_for_path(value: &str) -> String {
    value
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect()
}

fn copy_if_exists(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }
    fs::copy(source, destination).map(|_| ()).map_err(|error| {
        format!(
            "Unable to copy {} to {}: {error}",
            source.display(),
            destination.display()
        )
    })
}

fn copy_filtered_settings(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }

    let mut settings: serde_json::Value = serde_json::from_slice(
        &fs::read(source)
            .map_err(|error| format!("Unable to read {}: {error}", source.display()))?,
    )
    .map_err(|error| format!("Unable to parse {}: {error}", source.display()))?;

    if let Some(packages) = settings
        .get_mut("packages")
        .and_then(serde_json::Value::as_array_mut)
    {
        packages.retain(|entry| entry.as_str() != Some("npm:pi-powerline-footer"));
    }

    fs::write(
        destination,
        serde_json::to_vec_pretty(&settings)
            .map_err(|error| format!("Unable to serialize filtered settings: {error}"))?,
    )
    .map_err(|error| format!("Unable to write {}: {error}", destination.display()))
}

fn infer_npm_prefix(pi_executable: &Path, temp_home_dir: &Path) -> Option<PathBuf> {
    if let Ok(prefix) = env::var("NPM_CONFIG_PREFIX") {
        let path = PathBuf::from(prefix);
        if path.exists() {
            return Some(path);
        }
    }
    if let Ok(prefix) = env::var("npm_config_prefix") {
        let path = PathBuf::from(prefix);
        if path.exists() {
            return Some(path);
        }
    }

    let parent = pi_executable.parent()?;
    if parent.file_name()? == "bin" {
        return parent
            .parent()
            .map(Path::to_path_buf)
            .filter(|path| path.exists());
    }

    Some(temp_home_dir.join(".npm-global"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::OrchestraToolDefinition;
    use crate::services::tool_bridge::ToolBridgeConfig;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_dir(label: &str) -> PathBuf {
        env::temp_dir().join(format!(
            "{}-{}-{}",
            label,
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time should move forward")
                .as_millis()
        ))
    }

    #[test]
    fn launch_spec_includes_session_target_and_bridge_env() {
        let project_root = unique_temp_dir("orc-launch-project");
        let session_dir = project_root.join("sessions");
        fs::create_dir_all(&session_dir).expect("session dir should exist");
        let session_path = session_dir.join("session.jsonl");
        fs::write(&session_path, "{}\n").expect("session file should exist");
        let bridge = ToolBridgeConfig::test_config();

        let spec = build_interactive_launch_spec(
            &project_root,
            &session_dir,
            &session_path,
            "session-1",
            &bridge,
            Some(&AuthorizationContext {
                actor_type: "agent".into(),
                actor_id: "agent-supervisor".into(),
            }),
            &[OrchestraToolDefinition {
                name: "list_tasks".into(),
                description: "List tasks".into(),
                required_permission: "tasks.read".into(),
            }],
            None,
        )
        .expect("launch spec should build");

        assert!(spec.args.windows(2).any(|window| {
            window == ["--session".to_string(), session_path.display().to_string()]
        }));
        assert!(spec.args.windows(2).any(|window| {
            window
                == [
                    "--session-dir".to_string(),
                    session_dir.display().to_string(),
                ]
        }));
        assert!(spec.args.iter().any(|value| value == "--extension"));
        assert!(spec
            .env
            .iter()
            .any(|(key, value)| key == "ORCHESTRA_BRIDGE_URL" && value == "http://127.0.0.1:1"));
        assert!(spec
            .env
            .iter()
            .any(|(key, value)| key == "ORCHESTRA_BRIDGE_SESSION_ID" && value == "session-1"));
        assert!(spec
            .env
            .iter()
            .any(|(key, value)| key == "ORCHESTRA_AUTH_CONTEXT_JSON"
                && value.contains("agent-supervisor")));
    }

    #[cfg(unix)]
    #[test]
    fn spawn_interactive_pi_passes_bridge_env_to_child() {
        use std::os::unix::fs::PermissionsExt;

        let root = unique_temp_dir("orc-launch-child");
        fs::create_dir_all(&root).expect("root should exist");
        let capture = root.join("capture.txt");
        let executable = root.join("fake-pi.sh");
        fs::write(
            &executable,
            format!(
                "#!/bin/sh\nprintf '%s\n' \"$@\" > '{}'\nprintf 'bridge=%s\n' \"$ORCHESTRA_BRIDGE_URL\" >> '{}'\nprintf 'session=%s\n' \"$ORCHESTRA_BRIDGE_SESSION_ID\" >> '{}'\n",
                capture.display(),
                capture.display(),
                capture.display(),
            ),
        )
        .expect("fake pi should be writable");
        let mut permissions = fs::metadata(&executable)
            .expect("metadata should exist")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&executable, permissions).expect("fake pi should be executable");

        let spec = InteractivePiLaunchSpec {
            executable,
            args: vec!["--session".into(), "/tmp/session.jsonl".into()],
            cwd: root.clone(),
            env: vec![
                ("ORCHESTRA_BRIDGE_URL".into(), "http://127.0.0.1:9".into()),
                ("ORCHESTRA_BRIDGE_SESSION_ID".into(), "session-9".into()),
            ],
            temp_home_dir: None,
        };

        let status = spawn_interactive_pi(&spec)
            .expect("child should spawn")
            .wait()
            .expect("child should exit");
        assert!(status.success());

        let captured = fs::read_to_string(&capture).expect("capture file should exist");
        assert!(captured.contains("--session"));
        assert!(captured.contains("bridge=http://127.0.0.1:9"));
        assert!(captured.contains("session=session-9"));
    }
}
