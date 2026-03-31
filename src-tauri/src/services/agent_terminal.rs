use std::{path::Path, process::{Child, Command}};

use crate::services::pi_sessions;

fn shell_escape(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'").replace('\n', " "))
}

fn resolve_pi_executable() -> String {
    std::env::var("ORCHESTRA_PI_EXECUTABLE").unwrap_or_else(|_| "pi".to_string())
}

fn build_default_command(session_path: &Path, session_dir: &Path, runtime_cwd: &Path) -> (String, Vec<String>) {
    let pi_executable = resolve_pi_executable();
    (
        std::env::var("ORCHESTRA_GHOSTTY_BIN").unwrap_or_else(|_| "ghostty".to_string()),
        vec![
            "--working-directory".into(),
            runtime_cwd.display().to_string(),
            "-e".into(),
            pi_executable,
            "--session".into(),
            session_path.display().to_string(),
            "--session-dir".into(),
            session_dir.display().to_string(),
        ],
    )
}

fn build_template_command(
    template: &str,
    session_id: &str,
    session_path: &Path,
    session_dir: &Path,
    runtime_cwd: &Path,
) -> (String, Vec<String>) {
    let pi_executable = resolve_pi_executable();
    let command = template
        .replace("{session_id}", &shell_escape(session_id))
        .replace("{session_path}", &shell_escape(&session_path.display().to_string()))
        .replace("{session_dir}", &shell_escape(&session_dir.display().to_string()))
        .replace("{cwd}", &shell_escape(&runtime_cwd.display().to_string()))
        .replace("{pi}", &shell_escape(&pi_executable));
    ("sh".into(), vec!["-lc".into(), command])
}

pub fn open_agent_terminal_window(session_id: &str, session_dir: &Path, runtime_cwd: &Path) -> Result<Child, String> {
    let session_path = pi_sessions::get_session_path(session_dir, session_id)?;
    let (program, args) = if let Ok(template) = std::env::var("ORCHESTRA_AGENT_TERMINAL_TEMPLATE") {
        build_template_command(&template, session_id, &session_path, session_dir, runtime_cwd)
    } else {
        build_default_command(&session_path, session_dir, runtime_cwd)
    };

    Command::new(&program)
        .args(&args)
        .spawn()
        .map_err(|error| format!("Unable to launch agent terminal window using {}: {error}", program))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn template_command_expands_session_placeholders() {
        let session_path = PathBuf::from("/tmp/session.jsonl");
        let session_dir = PathBuf::from("/tmp/sessions");
        let cwd = PathBuf::from("/tmp/project");
        let (program, args) = build_template_command(
            "printf %s {session_id} {session_path} {session_dir} {cwd} {pi}",
            "session-1",
            &session_path,
            &session_dir,
            &cwd,
        );

        assert_eq!(program, "sh");
        let rendered = args.last().cloned().expect("template command should exist");
        assert!(rendered.contains("session-1"));
        assert!(rendered.contains("/tmp/session.jsonl"));
        assert!(rendered.contains("/tmp/sessions"));
        assert!(rendered.contains("/tmp/project"));
    }

    #[test]
    fn opens_agent_terminal_from_template_command() {
        let root = std::env::temp_dir().join(format!("agent-terminal-{}", uuid::Uuid::new_v4().simple()));
        let session_dir = root.join("sessions");
        std::fs::create_dir_all(&session_dir).expect("session dir should exist");
        let stored = pi_sessions::create_session_file(&root, &session_dir, Some("Agent terminal"), false)
            .expect("session file should create");

        std::env::set_var("ORCHESTRA_AGENT_TERMINAL_TEMPLATE", "sleep 0.1");
        let child = open_agent_terminal_window(&stored.record.id, &session_dir, &root).expect("terminal should launch");
        assert!(child.id() > 0);
        std::env::remove_var("ORCHESTRA_AGENT_TERMINAL_TEMPLATE");
    }
}
