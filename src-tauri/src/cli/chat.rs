use clap::Args;

use crate::services::{
    backend_bootstrap::CliBackend, database, live_sessions, pi_launch, session_attachments,
    tool_bridge,
};

#[derive(Debug, Clone, Args)]
pub struct ChatArgs {
    /// Agent id or slug to attach to. Defaults to supervisor.
    #[arg(short = 'a', long = "agent")]
    pub agent: Option<String>,
}

impl ChatArgs {
    pub fn requested_agent(&self) -> &str {
        self.agent
            .as_deref()
            .unwrap_or(super::DEFAULT_AGENT_SELECTOR)
    }
}

pub fn run(args: ChatArgs, backend: &CliBackend) -> Result<i32, String> {
    let connection = database::open_connection()?;
    let target = super::resolve_agent_target(&connection, args.agent.as_deref())?;

    if super::interactive_attach_blocked(&target.runtime_state) {
        return Err(format!(
            "{} is already busy in an active Orchestra session. Use `orc msg{} \"...\"` to send a message instead of attaching interactively.",
            target.agent.name,
            if args.agent.is_some() {
                format!(" --agent {}", args.requested_agent())
            } else {
                String::new()
            }
        ));
    }

    let authorization = live_sessions::authorization_context_for_session(&target.session_id)?;
    let allowed_tools = super::filter_cli_supported_tools(tool_bridge::list_bridge_tools(
        &connection,
        authorization.as_ref(),
    )?);
    drop(connection);

    session_attachments::claim_session_terminal_attachment(
        &target.session_id,
        "orc-chat",
        Some("orc chat"),
        std::process::id(),
    )?;

    backend.state.log(
        "info",
        "orc.chat.launch",
        &format!(
            "Launching orc chat for agent {} in project {} using session {}",
            target.agent.slug, target.project_slug, target.session_id
        ),
    );

    let spec = match pi_launch::build_interactive_launch_spec(
        super::runtime_cwd_or_project_root(&target),
        &target.context.session_dir,
        &target.session_path,
        &target.session_id,
        &backend.tool_bridge,
        authorization.as_ref(),
        &allowed_tools,
        None,
    ) {
        Ok(spec) => spec,
        Err(error) => {
            let _ = session_attachments::clear_session_terminal_attachment(&target.session_id);
            return Err(error);
        }
    };

    let temp_home = spec.temp_home_dir.clone();
    let mut child = match pi_launch::spawn_interactive_pi(&spec) {
        Ok(child) => child,
        Err(error) => {
            let _ = session_attachments::clear_session_terminal_attachment(&target.session_id);
            pi_launch::cleanup_temp_home_dir(temp_home.as_deref());
            return Err(error);
        }
    };
    let _ = session_attachments::update_session_terminal_attachment(
        &target.session_id,
        "orc-chat",
        Some("orc chat"),
        child.id(),
    );

    let status = child
        .wait()
        .map_err(|error| format!("Interactive pi session exited unexpectedly: {error}"));
    let _ = session_attachments::clear_session_terminal_attachment(&target.session_id);
    pi_launch::cleanup_temp_home_dir(temp_home.as_deref());
    let status = status?;

    if !status.success() {
        return Err(format!(
            "Interactive chat exited with status {}",
            status
                .code()
                .map(|code| code.to_string())
                .unwrap_or_else(|| "terminated by signal".into())
        ));
    }

    Ok(status.code().unwrap_or(0))
}
