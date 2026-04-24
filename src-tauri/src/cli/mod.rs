mod chat;
mod msg;
mod task;

use clap::{Parser, Subcommand};
use rusqlite::Connection;

use crate::{
    models::AgentDefinition,
    services::{self, agent_dispatch, agents, pi_sessions, projects, session_attachments},
};

pub const DEFAULT_AGENT_SELECTOR: &str = "supervisor";
const CLI_UNSUPPORTED_BRIDGE_COMMANDS: &[&str] = &[
    "send_mail",
    "stop_session_runtime",
    "approve_task_review",
    "mark_task_needs_work",
    "resume_task_lane",
    "pause_task_lane",
    "stop_task_activity",
];

#[derive(Debug, Parser)]
#[command(name = "orc", about = "Orchestra command-line interface")]
pub struct Cli {
    /// Project id or slug to scope CLI operations.
    #[arg(long = "project", global = true)]
    project: Option<String>,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Debug, Subcommand)]
enum Commands {
    /// Open an interactive terminal chat attached to an Orchestra agent session.
    Chat(chat::ChatArgs),
    /// Send a durable Orchestra mailbox message to an agent.
    Msg(msg::MsgArgs),
    /// Task and workflow operations.
    Task(task::TaskArgs),
}

#[derive(Debug, Clone)]
pub struct ResolvedAgentTarget {
    pub project_id: String,
    pub project_slug: String,
    pub context: pi_sessions::SessionContext,
    pub agent: AgentDefinition,
    pub runtime_state: crate::models::AgentRuntimeState,
    pub session_id: String,
    pub session_path: std::path::PathBuf,
}

pub fn run() -> Result<i32, String> {
    let cli = Cli::parse();
    let backend = services::backend_bootstrap::initialize_cli_backend()?;

    match cli.command {
        Commands::Chat(args) => chat::run(args, &backend, cli.project.as_deref()),
        Commands::Msg(args) => msg::run(args, cli.project.as_deref()),
        Commands::Task(args) => task::run(args, &backend, cli.project.as_deref()),
    }
}

pub(super) fn resolve_optional_project_id(
    connection: &Connection,
    requested_project: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(selector) = requested_project
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return projects::resolve_requested_or_default_project_id(connection, None);
    };

    if projects::get_project(connection, selector).is_ok() {
        return Ok(Some(selector.to_string()));
    }

    if let Some(project) = projects::get_project_by_slug(connection, selector)? {
        return Ok(Some(project.id));
    }

    Err(format!("Project {selector} was not found"))
}

pub(super) fn require_project_id(
    connection: &Connection,
    requested_project: Option<&str>,
    missing_message: &str,
) -> Result<String, String> {
    resolve_optional_project_id(connection, requested_project)?
        .ok_or_else(|| missing_message.to_string())
}

pub(super) fn resolve_agent_target(
    connection: &Connection,
    requested_project: Option<&str>,
    requested_agent: Option<&str>,
) -> Result<ResolvedAgentTarget, String> {
    let project_id = require_project_id(
        connection,
        requested_project,
        "Create a project first before using orc chat.",
    )?;
    let context = pi_sessions::session_context_for_project_id(&project_id)?;
    let agent_selector = requested_agent.unwrap_or(DEFAULT_AGENT_SELECTOR);
    let agent = resolve_agent(connection, &project_id, agent_selector)?;
    let runtime_state = agent_dispatch::ensure_main_session(
        &context.project_root,
        &context.session_dir,
        &project_id,
        &agent.id,
    )?;
    let session_id = runtime_state
        .main_session_id
        .clone()
        .ok_or_else(|| format!("Agent {} does not have a main session", agent.name))?;
    let session_path = pi_sessions::get_session_path(&context.session_dir, &session_id)?;
    let mut runtime_state = runtime_state;
    runtime_state.terminal_attached = session_attachments::session_terminal_attached(&session_id)?;

    Ok(ResolvedAgentTarget {
        project_slug: context.project_slug.clone(),
        project_id,
        context,
        agent,
        runtime_state,
        session_id,
        session_path,
    })
}

fn resolve_agent(
    connection: &Connection,
    project_id: &str,
    selector: &str,
) -> Result<AgentDefinition, String> {
    let trimmed = selector.trim();
    if trimmed.is_empty() {
        return Err("Agent name cannot be empty".into());
    }

    let mut matches = agents::list_agents_for_project(connection, false, Some(project_id))?
        .into_iter()
        .filter(|agent| agent.id == trimmed || agent.slug == trimmed)
        .collect::<Vec<_>>();

    if matches.is_empty() {
        return Err(format!(
            "Agent {trimmed} was not found in project {}. Try `orc chat --agent {}` with an existing agent slug or id.",
            project_id,
            DEFAULT_AGENT_SELECTOR,
        ));
    }

    let summary = matches.remove(0);
    agents::get_agent(connection, &summary.id)
}

pub(super) fn interactive_attach_blocked(runtime_state: &crate::models::AgentRuntimeState) -> bool {
    runtime_state.status == "running"
        || runtime_state.current_queue_entry_id.is_some()
        || runtime_state.terminal_attached
}

pub(super) fn runtime_cwd_or_project_root(target: &ResolvedAgentTarget) -> &std::path::Path {
    target
        .runtime_state
        .runtime_cwd
        .as_deref()
        .map(std::path::Path::new)
        .unwrap_or(target.context.project_root.as_path())
}

pub(super) fn filter_cli_supported_tools(
    tools: Vec<crate::models::OrchestraToolDefinition>,
) -> Vec<crate::models::OrchestraToolDefinition> {
    tools
        .into_iter()
        .filter(|tool| !CLI_UNSUPPORTED_BRIDGE_COMMANDS.contains(&tool.name.as_str()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn chat_parser_defaults_to_supervisor() {
        let cli = Cli::try_parse_from(["orc", "chat"]).expect("chat should parse");
        match cli.command {
            Commands::Chat(args) => assert_eq!(args.requested_agent(), DEFAULT_AGENT_SELECTOR),
            _ => panic!("expected chat command"),
        }
    }

    #[test]
    fn chat_parser_accepts_long_agent_flag() {
        let cli =
            Cli::try_parse_from(["orc", "chat", "--agent", "data"]).expect("chat should parse");
        match cli.command {
            Commands::Chat(args) => assert_eq!(args.requested_agent(), "data"),
            _ => panic!("expected chat command"),
        }
    }

    #[test]
    fn msg_parser_defaults_to_supervisor_and_collects_message() {
        let cli = Cli::try_parse_from(["orc", "msg", "hello", "there"]).expect("msg should parse");
        match cli.command {
            Commands::Msg(args) => {
                assert_eq!(args.requested_agent(), DEFAULT_AGENT_SELECTOR);
                assert_eq!(args.message_body(), "hello there");
            }
            _ => panic!("expected msg command"),
        }
    }

    #[test]
    fn busy_detection_blocks_running_queued_or_attached_agents() {
        let base = crate::models::AgentRuntimeState {
            project_id: "project-1".into(),
            agent_id: "agent-1".into(),
            status: "idle".into(),
            main_session_id: Some("session-1".into()),
            runtime_cwd: None,
            current_queue_entry_id: None,
            last_dispatch_at: None,
            last_error: None,
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
            terminal_attached: false,
        };
        assert!(!interactive_attach_blocked(&base));

        let mut running = base.clone();
        running.status = "running".into();
        assert!(interactive_attach_blocked(&running));

        let mut queued = base.clone();
        queued.current_queue_entry_id = Some("queue-1".into());
        assert!(interactive_attach_blocked(&queued));

        let mut attached = base;
        attached.terminal_attached = true;
        assert!(interactive_attach_blocked(&attached));
    }

    #[test]
    fn clap_command_surface_includes_chat_msg_and_task() {
        let command = Cli::command();
        let names = command
            .get_subcommands()
            .map(|command| command.get_name().to_string())
            .collect::<Vec<_>>();
        assert!(names.contains(&"chat".to_string()));
        assert!(names.contains(&"msg".to_string()));
        assert!(names.contains(&"task".to_string()));
    }

    #[test]
    fn global_project_flag_parses_before_task_command() {
        let cli = Cli::try_parse_from(["orc", "--project", "orchestra", "task", "list"])
            .expect("task list should parse");
        assert_eq!(cli.project.as_deref(), Some("orchestra"));
        match cli.command {
            Commands::Task(_) => {}
            _ => panic!("expected task command"),
        }
    }

    #[test]
    fn task_show_parser_accepts_human_task_number() {
        let cli =
            Cli::try_parse_from(["orc", "task", "show", "ORC-67"]).expect("task show should parse");
        match cli.command {
            Commands::Task(task::TaskArgs {
                command: task::TaskCommand::Show(args),
            }) => {
                assert_eq!(args.task, "ORC-67");
                assert!(!args.json);
            }
            _ => panic!("expected task show command"),
        }
    }

    #[test]
    fn task_comment_parser_collects_message_and_interrupt_flag() {
        let cli = Cli::try_parse_from([
            "orc",
            "task",
            "comment",
            "67",
            "please",
            "re-check",
            "this",
            "--interrupt",
        ])
        .expect("task comment should parse");
        match cli.command {
            Commands::Task(task::TaskArgs {
                command: task::TaskCommand::Comment(args),
            }) => {
                assert_eq!(args.task, "67");
                assert_eq!(args.message, vec!["please", "re-check", "this"]);
                assert!(args.interrupt);
            }
            _ => panic!("expected task comment command"),
        }
    }
}
