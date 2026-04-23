use clap::Args;

use crate::{
    models::SendMailboxMessageInput,
    services::{database, messages},
};

#[derive(Debug, Clone, Args)]
pub struct MsgArgs {
    /// Agent id or slug to message. Defaults to supervisor.
    #[arg(short = 'a', long = "agent")]
    pub agent: Option<String>,

    /// Message text to deliver to the target agent.
    #[arg(required = true, num_args = 1..)]
    pub message: Vec<String>,
}

impl MsgArgs {
    pub fn requested_agent(&self) -> &str {
        self.agent
            .as_deref()
            .unwrap_or(super::DEFAULT_AGENT_SELECTOR)
    }

    pub fn message_body(&self) -> String {
        self.message.join(" ")
    }
}

pub fn run(args: MsgArgs) -> Result<i32, String> {
    let connection = database::open_connection()?;
    let target = super::resolve_agent_target(&connection, args.agent.as_deref())?;
    let delivery_mode = messages::resolve_agent_mail_delivery_mode(
        &connection,
        &target.project_id,
        &target.agent.id,
    )?
    .to_string();

    let message = messages::send_mailbox_message_from_user_without_app(
        &connection,
        SendMailboxMessageInput {
            project_id: Some(target.project_id.clone()),
            task_id: None,
            recipient_type: "agent".into(),
            recipient_id: Some(target.agent.id.clone()),
            sender_label: None,
            body: args.message_body(),
            priority: None,
        },
    )?;

    println!(
        "Queued {} delivery for {} ({}) via mailbox delivery {}.",
        delivery_mode,
        target.agent.name,
        args.requested_agent(),
        message.delivery_id,
    );

    Ok(0)
}
