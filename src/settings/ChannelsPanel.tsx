import { useEffect, useMemo, useState } from "react";

import {
  createChannel,
  deleteChannel,
  getChannel,
  listChannelActivity,
  listChannels,
  listTelegramChatCandidates,
  updateChannel,
  validateTelegramBot,
} from "../lib/channels";
import { listProjects } from "../lib/projects";
import { reportClientError } from "../lib/tauri";
import type {
  ChannelActivityEntry,
  ChannelDetail,
  ChannelUpsertInput,
  ProjectSummary,
  TelegramBotValidation,
  TelegramChatCandidate,
} from "../types";

function createDraft(defaultProjectId: string | null): ChannelUpsertInput {
  return {
    kind: "telegram",
    name: "Telegram",
    enabled: false,
    targetAgentId: "agent-supervisor",
    defaultProjectId,
    telegram: {
      botToken: "",
      apiBaseUrl: "",
      chatId: "",
      chatTitle: "",
      chatType: "private",
      commandsEnabled: true,
    },
  };
}

export function ChannelsPanel() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [channels, setChannels] = useState<ChannelDetail[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(null);
  const [channelDetail, setChannelDetail] = useState<ChannelDetail | null>(null);
  const [draft, setDraft] = useState<ChannelUpsertInput>(createDraft(null));
  const [activity, setActivity] = useState<ChannelActivityEntry[]>([]);
  const [chatCandidates, setChatCandidates] = useState<TelegramChatCandidate[]>([]);
  const [botValidation, setBotValidation] = useState<TelegramBotValidation | null>(null);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [detectingChats, setDetectingChats] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedChannel = useMemo(
    () => channels.find((channel) => channel.id === selectedChannelId) ?? null,
    [channels, selectedChannelId],
  );

  async function loadCatalog() {
    setLoading(true);
    setError(null);
    try {
      const [nextProjects, nextChannels] = await Promise.all([listProjects(), listChannels()]);
      setProjects(nextProjects);
      setChannels(nextChannels as ChannelDetail[]);
      setSelectedChannelId((current) =>
        current && nextChannels.some((channel) => channel.id === current)
          ? current
          : nextChannels[0]?.id ?? null,
      );
      if (!creating) {
        setDraft((current) =>
          current.defaultProjectId ? current : createDraft(nextProjects[0]?.id ?? null),
        );
      }
    } catch (nextError) {
      setError(await reportClientError("ui.channels.catalog.load", nextError, "Unable to load channels."));
    } finally {
      setLoading(false);
    }
  }

  async function loadChannelDetail(channelId: string) {
    setLoading(true);
    setError(null);
    try {
      const [detail, nextActivity] = await Promise.all([
        getChannel(channelId),
        listChannelActivity(channelId, 25),
      ]);
      setChannelDetail(detail);
      setActivity(nextActivity);
      setDraft({
        kind: detail.kind,
        name: detail.name,
        enabled: detail.enabled,
        targetAgentId: detail.targetAgentId,
        defaultProjectId: detail.defaultProjectId ?? projects[0]?.id ?? null,
        telegram: {
          botToken: "",
          apiBaseUrl: detail.telegram?.apiBaseUrl ?? "",
          chatId: detail.telegram?.chatId ?? "",
          chatTitle: detail.telegram?.chatTitle ?? "",
          chatType: detail.telegram?.chatType ?? "private",
          commandsEnabled: detail.telegram?.commandsEnabled ?? true,
        },
      });
      setBotValidation(
        detail.telegram?.botUsername
          ? {
              botId: detail.id,
              username: detail.telegram.botUsername,
              displayName: detail.telegram.botUsername,
            }
          : null,
      );
      setCreating(false);
      setChatCandidates([]);
    } catch (nextError) {
      setError(
        await reportClientError("ui.channels.detail.load", nextError, "Unable to load channel detail."),
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadCatalog();
  }, []);

  useEffect(() => {
    if (selectedChannel?.id) {
      void loadChannelDetail(selectedChannel.id);
    }
  }, [selectedChannel?.id]);

  function updateTelegramDraft(patch: Partial<NonNullable<ChannelUpsertInput["telegram"]>>) {
    setDraft((current) => ({
      ...current,
      telegram: {
        botToken: current.telegram?.botToken ?? "",
        apiBaseUrl: current.telegram?.apiBaseUrl ?? "",
        chatId: current.telegram?.chatId ?? "",
        chatTitle: current.telegram?.chatTitle ?? "",
        chatType: current.telegram?.chatType ?? "private",
        commandsEnabled: current.telegram?.commandsEnabled ?? true,
        ...patch,
      },
    }));
  }

  async function handleValidateBot() {
    const botToken = draft.telegram?.botToken?.trim();
    if (!botToken) {
      setError("Telegram bot token is required.");
      return;
    }

    setValidating(true);
    setError(null);
    try {
      const validation = await validateTelegramBot(botToken, draft.telegram?.apiBaseUrl ?? null);
      setBotValidation(validation);
      setDraft((current) => ({
        ...current,
        name: current.name?.trim() ? current.name : `Telegram · ${validation.displayName}`,
      }));
    } catch (nextError) {
      setError(
        await reportClientError(
          "ui.channels.telegram.validate_bot",
          nextError,
          "Unable to validate Telegram bot.",
        ),
      );
    } finally {
      setValidating(false);
    }
  }

  async function handleDetectChats() {
    const botToken = draft.telegram?.botToken?.trim();
    if (!botToken) {
      setError("Telegram bot token is required before detecting chats.");
      return;
    }

    setDetectingChats(true);
    setError(null);
    try {
      setChatCandidates(await listTelegramChatCandidates(botToken, draft.telegram?.apiBaseUrl ?? null));
    } catch (nextError) {
      setError(
        await reportClientError(
          "ui.channels.telegram.detect_chats",
          nextError,
          "Unable to detect Telegram chats.",
        ),
      );
    } finally {
      setDetectingChats(false);
    }
  }

  async function handleSaveChannel() {
    setSaving(true);
    setError(null);
    try {
      const saved = selectedChannel?.id && !creating
        ? await updateChannel(selectedChannel.id, draft)
        : await createChannel(draft);
      await loadCatalog();
      setSelectedChannelId(saved.id);
      setCreating(false);
    } catch (nextError) {
      setError(await reportClientError("ui.channels.save", nextError, "Unable to save channel."));
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteChannel() {
    if (!selectedChannel?.id) {
      return;
    }
    const confirmed = window.confirm(`Delete channel "${selectedChannel.name}"?`);
    if (!confirmed) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await deleteChannel(selectedChannel.id);
      setSelectedChannelId(null);
      setChannelDetail(null);
      setDraft(createDraft(projects[0]?.id ?? null));
      setCreating(true);
      await loadCatalog();
    } catch (nextError) {
      setError(await reportClientError("ui.channels.delete", nextError, "Unable to delete channel."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="task-shell">
      <aside className="task-nav-panel">
        <div className="panel__header panel__header--stacked">
          <div>
            <p className="eyebrow">External channels</p>
            <h3>Channels</h3>
          </div>
          <button
            className="primary-button"
            data-role="new-channel"
            type="button"
            onClick={() => {
              setCreating(true);
              setChannelDetail(null);
              setSelectedChannelId(null);
              setDraft(createDraft(projects[0]?.id ?? null));
              setBotValidation(null);
              setChatCandidates([]);
              setActivity([]);
            }}
          >
            Add channel
          </button>
        </div>

        {loading ? <p className="muted-copy">Loading channels…</p> : null}
        {error ? <p className="error-copy">{error}</p> : null}

        <nav className="task-list" aria-label="Channels" data-role="channel-list">
          {channels.map((channel) => (
            <a
              key={channel.id}
              href="#"
              className={selectedChannelId === channel.id ? "task-list-link task-list-link--active" : "task-list-link"}
              onClick={(event) => {
                event.preventDefault();
                setSelectedChannelId(channel.id);
              }}
            >
              <span className="task-list-link__eyebrow">{channel.kind}</span>
              <strong>{channel.name}</strong>
            </a>
          ))}
        </nav>
      </aside>

      <section className="panel task-detail-panel">
        <div className="task-detail-stack">
          <div className="panel__header panel__header--session-detail">
            <div>
              <p className="eyebrow">Channel detail</p>
              <h3>{creating ? "New channel" : channelDetail?.name ?? "Select a channel"}</h3>
              <p className="muted-copy">
                Configure an external transport that asynchronously talks to the single supervisor session.
                Plain text messages go to the supervisor; Telegram commands control project/model/session behavior.
              </p>
            </div>
            <div className="row-actions">
              {selectedChannel?.id && !creating ? (
                <button className="secondary-button" data-role="delete-channel" type="button" disabled={saving} onClick={() => void handleDeleteChannel()}>
                  Delete channel
                </button>
              ) : null}
              <button className="primary-button" data-role="save-channel" type="button" disabled={saving} onClick={() => void handleSaveChannel()}>
                {saving ? "Saving…" : creating ? "Create channel" : "Save channel"}
              </button>
            </div>
          </div>

          <section className="task-section task-section--compact">
            <div className="task-section__header">
              <div>
                <p className="eyebrow">Step 1</p>
                <h4>Choose channel type</h4>
                <p className="muted-copy">Telegram is the first real transport and talks to the supervisor session.</p>
              </div>
            </div>
            <div className="filter-chip-row" role="tablist" aria-label="Channel kinds">
              <button className="filter-chip filter-chip--active" data-role="channel-kind-telegram" type="button">Telegram</button>
            </div>
          </section>

          <div className="task-editor-grid">
            <label className="field-group">
              <span className="field-group__label">Channel name</span>
              <input className="text-input" data-role="channel-name" value={draft.name ?? ""} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
            </label>
            <label className="field-group">
              <span className="field-group__label">Default project</span>
              <select className="text-input" data-role="channel-default-project" value={draft.defaultProjectId ?? ""} onChange={(event) => setDraft((current) => ({ ...current, defaultProjectId: event.target.value || null }))}>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
              </select>
            </label>
          </div>

          <section className="task-section task-section--compact" data-role="telegram-step-token">
            <div className="task-section__header">
              <div>
                <p className="eyebrow">Step 2</p>
                <h4>Create your Telegram bot</h4>
                <p className="muted-copy">Open Telegram, message @BotFather, run /newbot, choose a name and a username ending in bot, then paste the bot token here.</p>
              </div>
              <button className="secondary-button" data-role="validate-telegram-bot" type="button" disabled={validating} onClick={() => void handleValidateBot()}>
                {validating ? "Validating…" : "Validate bot"}
              </button>
            </div>
            <div className="task-editor-grid">
              <label className="field-group task-editor-grid__full">
                <span className="field-group__label">Bot token</span>
                <input className="text-input" data-role="telegram-bot-token" type="password" value={draft.telegram?.botToken ?? ""} onChange={(event) => updateTelegramDraft({ botToken: event.target.value })} />
              </label>
              <label className="field-group task-editor-grid__full">
                <span className="field-group__label">API base URL (optional)</span>
                <input className="text-input" data-role="telegram-api-base-url" value={draft.telegram?.apiBaseUrl ?? ""} onChange={(event) => updateTelegramDraft({ apiBaseUrl: event.target.value })} />
              </label>
            </div>
            {botValidation ? <p className="muted-copy" data-role="telegram-bot-validation">Validated bot: @{botValidation.username}</p> : null}
          </section>

          <section className="task-section task-section--compact" data-role="telegram-step-chat">
            <div className="task-section__header">
              <div>
                <p className="eyebrow">Step 3</p>
                <h4>Bind a chat</h4>
                <p className="muted-copy">Open a chat with your bot, send /start, then return here and detect recent chats.</p>
              </div>
              <button className="secondary-button" data-role="detect-telegram-chats" type="button" disabled={detectingChats} onClick={() => void handleDetectChats()}>
                {detectingChats ? "Detecting…" : "Detect chats"}
              </button>
            </div>
            <div className="task-editor-grid">
              <label className="field-group task-editor-grid__full">
                <span className="field-group__label">Detected chat</span>
                <select
                  className="text-input"
                  data-role="telegram-chat-select"
                  value={draft.telegram?.chatId ?? ""}
                  onChange={(event) => {
                    const candidate = chatCandidates.find((entry) => entry.chatId === event.target.value) ?? null;
                    updateTelegramDraft({
                      chatId: candidate?.chatId ?? "",
                      chatTitle: candidate?.title ?? "",
                      chatType: candidate?.chatType ?? "private",
                    });
                  }}
                >
                  <option value="">Select a chat</option>
                  {chatCandidates.map((candidate) => (
                    <option key={candidate.chatId} value={candidate.chatId}>{candidate.title}</option>
                  ))}
                </select>
              </label>
            </div>
          </section>

          <section className="task-section task-section--compact">
            <div className="task-section__header">
              <div>
                <p className="eyebrow">Step 4</p>
                <h4>Enable behavior</h4>
              </div>
            </div>
            <div className="task-editor-grid">
              <label className="checkbox-field task-editor-grid__full">
                <input data-role="telegram-commands-enabled" type="checkbox" checked={draft.telegram?.commandsEnabled ?? true} onChange={(event) => updateTelegramDraft({ commandsEnabled: event.target.checked })} />
                <span>Enable Telegram commands (/help, /status, /project, /model, /stop, /resume)</span>
              </label>
              <label className="checkbox-field task-editor-grid__full">
                <input data-role="channel-enabled" type="checkbox" checked={Boolean(draft.enabled)} onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))} />
                <span>Enable channel runtime</span>
              </label>
            </div>
          </section>

          {channelDetail ? (
            <section className="task-section task-section--compact">
              <div className="task-section__header">
                <div>
                  <p className="eyebrow">Activity</p>
                  <h4>Recent channel activity</h4>
                </div>
              </div>
              <div className="task-section-list" data-role="channel-activity-list">
                {activity.length ? activity.map((entry) => (
                  <article key={entry.id} className="task-history-card">
                    <div className="workflow-section__header">
                      <strong>{entry.direction} · {entry.messageKind}</strong>
                      <span className="status-badge status-badge--neutral status-badge--compact">{entry.status}</span>
                    </div>
                    <p className="pre-wrap">{entry.body}</p>
                  </article>
                )) : <p className="muted-copy">No activity yet.</p>}
              </div>
            </section>
          ) : null}
        </div>
      </section>
    </section>
  );
}
