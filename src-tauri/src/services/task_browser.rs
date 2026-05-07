use rusqlite::{params, Connection, OptionalExtension};
use tauri::{
    AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use uuid::Uuid;

use crate::{
    models::{TaskBrowserSession, TaskCommentDomAnchor},
    services::{app_events, tasks},
};

const TASK_BROWSER_EVENT_NAME: &str = "orchestra:task-browser-change";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskBrowserPageState {
    pub current_url: String,
    pub page_title: Option<String>,
    pub inspect_mode: bool,
    pub dom_revision: i64,
    pub last_mutation_at: Option<String>,
    pub last_ready_state: Option<String>,
    pub selected_anchor: Option<TaskCommentDomAnchor>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskBrowserChangeEvent {
    pub task_id: String,
    pub browser_session_id: String,
    pub current_url: Option<String>,
    pub page_title: Option<String>,
    pub inspect_mode: bool,
    pub dom_revision: i64,
    pub last_mutation_at: Option<String>,
    pub reason: String,
}

pub fn build_window_label(task_id: &str) -> String {
    format!("task-browser-{task_id}")
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn serialize_selected_anchor(
    anchor: &Option<TaskCommentDomAnchor>,
) -> Result<Option<String>, String> {
    anchor
        .as_ref()
        .map(|value| {
            serde_json::to_string(value)
                .map_err(|error| format!("Unable to serialize selected browser anchor: {error}"))
        })
        .transpose()
}

fn parse_selected_anchor(raw: Option<String>) -> Result<Option<TaskCommentDomAnchor>, String> {
    raw.map(|value| {
        serde_json::from_str::<TaskCommentDomAnchor>(&value)
            .map_err(|error| format!("Unable to parse selected browser anchor: {error}"))
    })
    .transpose()
}

pub fn validate_browser_url(url: &str) -> Result<Url, String> {
    let trimmed = url.trim();
    if trimmed.eq_ignore_ascii_case("about:blank") {
        return Url::parse("about:blank")
            .map_err(|error| format!("url: Unable to parse about:blank: {error}"));
    }

    let parsed =
        Url::parse(trimmed).map_err(|error| format!("url: Invalid browser URL: {error}"))?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed),
        other => Err(format!(
            "url: Unsupported browser URL scheme `{other}`. Expected http or https."
        )),
    }
}

pub fn get_task_browser_session(
    connection: &Connection,
    task_id: &str,
) -> Result<Option<TaskBrowserSession>, String> {
    connection
        .query_row(
            "SELECT id, task_id, window_label, current_url, page_title, inspect_mode, dom_revision, last_mutation_at, last_ready_state, last_selected_anchor_json, created_at, updated_at FROM task_browser_sessions WHERE task_id = ?1",
            [task_id],
            |row| {
                let inspect_mode: i64 = row.get(5)?;
                let dom_revision: i64 = row.get(6)?;
                let selected_anchor_json: Option<String> = row.get(9)?;
                let last_selected_anchor = parse_selected_anchor(selected_anchor_json).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        9,
                        rusqlite::types::Type::Text,
                        Box::new(std::io::Error::new(std::io::ErrorKind::InvalidData, error)),
                    )
                })?;
                Ok(TaskBrowserSession {
                    id: row.get(0)?,
                    task_id: row.get(1)?,
                    window_label: row.get(2)?,
                    current_url: row.get(3)?,
                    page_title: row.get(4)?,
                    inspect_mode: inspect_mode != 0,
                    dom_revision,
                    last_mutation_at: row.get(7)?,
                    last_ready_state: row.get(8)?,
                    last_selected_anchor,
                    created_at: row.get(10)?,
                    updated_at: row.get(11)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("Unable to load task browser session for {task_id}: {error}"))
}

pub fn ensure_task_browser_session(
    connection: &mut Connection,
    task_id: &str,
) -> Result<TaskBrowserSession, String> {
    if let Some(existing) = get_task_browser_session(connection, task_id)? {
        return Ok(existing);
    }

    if !tasks::task_exists(connection, task_id)? {
        return Err(format!("Task {task_id} was not found"));
    }

    let now = now_iso();
    let session = TaskBrowserSession {
        id: format!("task-browser-session-{}", Uuid::new_v4().simple()),
        task_id: task_id.to_string(),
        window_label: build_window_label(task_id),
        current_url: Some("about:blank".into()),
        page_title: None,
        inspect_mode: false,
        dom_revision: 0,
        last_mutation_at: None,
        last_ready_state: Some("loading".into()),
        last_selected_anchor: None,
        created_at: now.clone(),
        updated_at: now,
    };

    connection.execute(
        "INSERT INTO task_browser_sessions (id, task_id, window_label, current_url, page_title, inspect_mode, dom_revision, last_mutation_at, last_ready_state, last_selected_anchor_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            session.id,
            session.task_id,
            session.window_label,
            session.current_url,
            session.page_title,
            if session.inspect_mode { 1 } else { 0 },
            session.dom_revision,
            session.last_mutation_at,
            session.last_ready_state,
            serialize_selected_anchor(&session.last_selected_anchor)?,
            session.created_at,
            session.updated_at,
        ],
    ).map_err(|error| format!("Unable to create task browser session for {task_id}: {error}"))?;

    Ok(session)
}

pub fn update_task_browser_session_page_state(
    connection: &Connection,
    task_id: &str,
    session_id: &str,
    state: TaskBrowserPageState,
) -> Result<TaskBrowserSession, String> {
    let Some(existing) = get_task_browser_session(connection, task_id)? else {
        return Err(format!("Task browser session for {task_id} was not found"));
    };
    if existing.id != session_id {
        return Err(format!(
            "Task browser session mismatch for {task_id}: expected {}, got {session_id}",
            existing.id
        ));
    }

    let updated_at = now_iso();
    let selected_anchor_json = serialize_selected_anchor(&state.selected_anchor)?;
    connection.execute(
        "UPDATE task_browser_sessions SET current_url = ?2, page_title = ?3, inspect_mode = ?4, dom_revision = ?5, last_mutation_at = ?6, last_ready_state = ?7, last_selected_anchor_json = ?8, updated_at = ?9 WHERE id = ?1",
        params![
            existing.id,
            state.current_url,
            state.page_title,
            if state.inspect_mode { 1 } else { 0 },
            state.dom_revision.max(0),
            state.last_mutation_at,
            state.last_ready_state,
            selected_anchor_json,
            updated_at,
        ],
    ).map_err(|error| format!("Unable to update task browser session {}: {error}", existing.id))?;

    Ok(TaskBrowserSession {
        id: existing.id,
        task_id: existing.task_id,
        window_label: existing.window_label,
        current_url: Some(state.current_url),
        page_title: state.page_title,
        inspect_mode: state.inspect_mode,
        dom_revision: state.dom_revision.max(0),
        last_mutation_at: state.last_mutation_at,
        last_ready_state: state.last_ready_state,
        last_selected_anchor: state.selected_anchor,
        created_at: existing.created_at,
        updated_at,
    })
}

pub fn set_task_browser_inspect_mode_value(
    connection: &Connection,
    task_id: &str,
    enabled: bool,
) -> Result<TaskBrowserSession, String> {
    let Some(existing) = get_task_browser_session(connection, task_id)? else {
        return Err(format!("Task browser session for {task_id} was not found"));
    };
    let updated_at = now_iso();
    connection
        .execute(
            "UPDATE task_browser_sessions SET inspect_mode = ?2, updated_at = ?3 WHERE id = ?1",
            params![existing.id, if enabled { 1 } else { 0 }, updated_at],
        )
        .map_err(|error| {
            format!("Unable to update task browser inspect mode for {task_id}: {error}")
        })?;

    Ok(TaskBrowserSession {
        inspect_mode: enabled,
        updated_at,
        ..existing
    })
}

fn inject_browser_bridge(
    window: &WebviewWindow,
    task_id: &str,
    session: &TaskBrowserSession,
) -> Result<(), String> {
    let task_id_json = serde_json::to_string(task_id)
        .map_err(|error| format!("Unable to serialize browser task id: {error}"))?;
    let session_id_json = serde_json::to_string(&session.id)
        .map_err(|error| format!("Unable to serialize browser session id: {error}"))?;
    let inspect_mode_json = if session.inspect_mode {
        "true"
    } else {
        "false"
    };
    let keep_tauri_internals_json = if std::env::var("ORCHESTRA_DESKTOP_E2E")
        .map(|value| value == "1")
        .unwrap_or(false)
    {
        "true"
    } else {
        "false"
    };
    let script = format!(
        r#"
(() => {{
  const internal = window.__TAURI_INTERNALS__;
  const invoke = internal && typeof internal.invoke === 'function'
    ? internal.invoke.bind(internal)
    : null;
  if (!invoke) {{
    return;
  }}

  const KEEP_TAURI_INTERNALS = {keep_tauri_internals_json};
  if (!KEEP_TAURI_INTERNALS) {{
    try {{
      delete window.__TAURI_INTERNALS__;
      Object.defineProperty(window, '__TAURI_INTERNALS__', {{
        value: undefined,
        configurable: false,
        writable: false,
        enumerable: false,
      }});
    }} catch (_error) {{}}
  }}

  const TASK_ID = {task_id_json};
  const SESSION_ID = {session_id_json};
  const INITIAL_INSPECT_MODE = {inspect_mode_json};
  const REPORT_COMMAND = 'task_browser_page_state_changed';
  window.__ORCHESTRA_WINDOW_KIND__ = 'task-browser';

  const state = window.__ORCHESTRA_BROWSER_STATE__ = window.__ORCHESTRA_BROWSER_STATE__ || {{
    domRevision: 0,
    lastMutationAt: null,
    inspectMode: false,
    selectedAnchor: null,
  }};

  let hoverBox = null;
  let shadowRoot = null;
  let pendingReport = null;
  let latestHovered = null;

  function debounceReport(reason) {{
    if (pendingReport) {{
      window.clearTimeout(pendingReport);
    }}
    pendingReport = window.setTimeout(() => {{
      pendingReport = null;
      reportState(reason);
    }}, 80);
  }}

  async function reportState(reason) {{
    try {{
      await invoke(REPORT_COMMAND, {{
        taskId: TASK_ID,
        sessionId: SESSION_ID,
        statePayload: {{
          currentUrl: String(window.location.href || ''),
          pageTitle: document.title || null,
          inspectMode: Boolean(state.inspectMode),
          domRevision: Number(state.domRevision || 0),
          lastMutationAt: state.lastMutationAt || null,
          lastReadyState: document.readyState || null,
          selectedAnchor: state.selectedAnchor || null,
          reason,
        }},
      }});
    }} catch (_error) {{}}
  }}

  function ensureOverlay() {{
    if (hoverBox && shadowRoot) {{
      return;
    }}
    const host = document.createElement('div');
    host.setAttribute('data-orchestra-browser-overlay-host', 'true');
    host.style.position = 'fixed';
    host.style.inset = '0';
    host.style.pointerEvents = 'none';
    host.style.zIndex = '2147483647';
    document.documentElement.appendChild(host);
    shadowRoot = host.attachShadow({{ mode: 'open' }});
    const style = document.createElement('style');
    style.textContent = `
      .hover-box {{
        position: fixed;
        border: 2px solid rgba(59, 130, 246, 0.95);
        background: rgba(59, 130, 246, 0.12);
        box-shadow: 0 0 0 999999px rgba(15, 23, 42, 0.08);
        border-radius: 6px;
        pointer-events: none;
        display: none;
      }}
      .hover-box[data-selected="true"] {{
        border-color: rgba(16, 185, 129, 0.98);
        background: rgba(16, 185, 129, 0.14);
      }}
    `;
    hoverBox = document.createElement('div');
    hoverBox.className = 'hover-box';
    shadowRoot.append(style, hoverBox);
  }}

  function hideHoverBox() {{
    if (hoverBox) {{
      hoverBox.style.display = 'none';
      hoverBox.removeAttribute('data-selected');
    }}
  }}

  function positionHoverBox(target, selected = false) {{
    ensureOverlay();
    if (!hoverBox || !target) {{
      return;
    }}
    const rect = target.getBoundingClientRect();
    hoverBox.style.display = rect.width > 0 && rect.height > 0 ? 'block' : 'none';
    hoverBox.style.left = `${{Math.max(0, rect.left)}}px`;
    hoverBox.style.top = `${{Math.max(0, rect.top)}}px`;
    hoverBox.style.width = `${{Math.max(0, rect.width)}}px`;
    hoverBox.style.height = `${{Math.max(0, rect.height)}}px`;
    if (selected) {{
      hoverBox.setAttribute('data-selected', 'true');
    }} else {{
      hoverBox.removeAttribute('data-selected');
    }}
  }}

  function textPreview(element) {{
    const value = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
    return value ? value.slice(0, 240) : null;
  }}

  function cssPath(element) {{
    const segments = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {{
      let segment = current.tagName.toLowerCase();
      if (current.id) {{
        segment += `#${{CSS.escape(current.id)}}`;
        segments.unshift(segment);
        break;
      }}
      const siblings = current.parentElement
        ? Array.from(current.parentElement.children).filter((child) => child.tagName === current.tagName)
        : [];
      if (siblings.length > 1) {{
        const index = siblings.indexOf(current) + 1;
        segment += `:nth-of-type(${{index}})`;
      }}
      segments.unshift(segment);
      current = current.parentElement;
    }}
    return segments.join(' > ') || null;
  }}

  function xpathFor(element) {{
    const segments = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE) {{
      const tag = current.tagName.toLowerCase();
      const siblings = current.parentNode
        ? Array.from(current.parentNode.childNodes).filter((node) => node.nodeType === Node.ELEMENT_NODE && node.tagName === current.tagName)
        : [];
      const index = siblings.length > 1 ? `[${{siblings.indexOf(current) + 1}}]` : '';
      segments.unshift(`${{tag}}${{index}}`);
      current = current.parentElement;
    }}
    return `/${{segments.join('/')}}`;
  }}

  function ordinalPath(element) {{
    const segments = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE) {{
      const tag = current.tagName.toLowerCase();
      const index = current.parentElement ? Array.from(current.parentElement.children).filter((child) => child.tagName === current.tagName).indexOf(current) : 0;
      segments.unshift({{ tag, index: Math.max(0, index) }});
      current = current.parentElement;
    }}
    return segments;
  }}

  function snapshot(element) {{
    const attributes = {{}};
    for (const attr of Array.from(element.attributes || [])) {{
      if (!attr.name.startsWith('on')) {{
        attributes[attr.name] = attr.value;
      }}
    }}
    return {{
      tagName: element.tagName.toLowerCase(),
      id: element.id || null,
      classList: Array.from(element.classList || []),
      textPreview: textPreview(element),
      attributes,
      outerHtmlSnippet: (element.outerHTML || '').slice(0, 400),
    }};
  }}

  function buildAnchor(element) {{
    return {{
      kind: 'dom',
      browserSessionId: SESSION_ID,
      url: String(window.location.href || ''),
      pageTitle: document.title || null,
      domRevision: Number(state.domRevision || 0),
      locator: {{
        cssPath: cssPath(element),
        xpath: xpathFor(element),
        role: element.getAttribute('role') || null,
        accessibleName: element.getAttribute('aria-label') || element.getAttribute('title') || null,
        textSnippet: textPreview(element),
        testId: element.getAttribute('data-testid') || element.getAttribute('data-test-id') || null,
        ordinalPath: ordinalPath(element),
      }},
      snapshot: snapshot(element),
    }};
  }}

  function resolveAnchor(anchor) {{
    if (!anchor || anchor.kind !== 'dom') {{
      return null;
    }}
    const locator = anchor.locator || {{}};
    if (locator.testId) {{
      const byTestId = document.querySelector(`[data-testid="${{CSS.escape(locator.testId)}}"], [data-test-id="${{CSS.escape(locator.testId)}}"]`);
      if (byTestId) {{
        return byTestId;
      }}
    }}
    if (locator.cssPath) {{
      try {{
        const byCss = document.querySelector(locator.cssPath);
        if (byCss) {{
          return byCss;
        }}
      }} catch (_error) {{}}
    }}
    if (locator.xpath) {{
      try {{
        const result = document.evaluate(locator.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        if (result.singleNodeValue instanceof HTMLElement) {{
          return result.singleNodeValue;
        }}
      }} catch (_error) {{}}
    }}
    return null;
  }}

  function clearSelection() {{
    state.selectedAnchor = null;
    if (latestHovered) {{
      positionHoverBox(latestHovered, false);
    }} else {{
      hideHoverBox();
    }}
    debounceReport('selection_cleared');
  }}

  function setInspectMode(enabled) {{
    state.inspectMode = Boolean(enabled);
    if (!state.inspectMode) {{
      hideHoverBox();
    }} else if (latestHovered) {{
      positionHoverBox(latestHovered, Boolean(state.selectedAnchor));
    }}
    debounceReport('inspect_mode');
  }}

  function handlePointerMove(event) {{
    if (!state.inspectMode) {{
      return;
    }}
    const target = event.target instanceof HTMLElement ? event.target : event.target && event.target.parentElement;
    if (!target || target.closest('[data-orchestra-browser-overlay-host="true"]')) {{
      return;
    }}
    latestHovered = target;
    positionHoverBox(target, Boolean(state.selectedAnchor && resolveAnchor(state.selectedAnchor) === target));
  }}

  function handleClick(event) {{
    if (!state.inspectMode) {{
      return;
    }}
    const target = event.target instanceof HTMLElement ? event.target : event.target && event.target.parentElement;
    if (!target || target.closest('[data-orchestra-browser-overlay-host="true"]')) {{
      return;
    }}
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    state.selectedAnchor = buildAnchor(target);
    positionHoverBox(target, true);
    debounceReport('selection');
  }}

  function handleKeydown(event) {{
    if (event.key === 'Escape' && state.inspectMode) {{
      event.preventDefault();
      clearSelection();
      setInspectMode(false);
    }}
  }}

  ensureOverlay();
  document.removeEventListener('pointermove', handlePointerMove, true);
  document.removeEventListener('click', handleClick, true);
  document.removeEventListener('keydown', handleKeydown, true);
  document.addEventListener('pointermove', handlePointerMove, true);
  document.addEventListener('click', handleClick, true);
  document.addEventListener('keydown', handleKeydown, true);

  if (!window.__ORCHESTRA_BROWSER_MUTATION_OBSERVER__) {{
    const mutationObserver = new MutationObserver(() => {{
      state.domRevision = Number(state.domRevision || 0) + 1;
      state.lastMutationAt = new Date().toISOString();
      debounceReport('mutation');
    }});
    const root = document.documentElement || document.body;
    if (root) {{
      mutationObserver.observe(root, {{ subtree: true, childList: true, attributes: true, characterData: true }});
    }}
    window.__ORCHESTRA_BROWSER_MUTATION_OBSERVER__ = mutationObserver;
  }}

  const titleObserverTarget = document.querySelector('title') || document.head;
  if (titleObserverTarget && !window.__ORCHESTRA_BROWSER_TITLE_OBSERVER__) {{
    const titleObserver = new MutationObserver(() => debounceReport('title'));
    titleObserver.observe(titleObserverTarget, {{ subtree: true, childList: true, characterData: true }});
    window.__ORCHESTRA_BROWSER_TITLE_OBSERVER__ = titleObserver;
  }}

  Object.defineProperty(window, '__ORCHESTRA_BROWSER_BRIDGE__', {{
    value: {{
      __orchestraSessionId: SESSION_ID,
      setInspectMode,
      clearSelection,
      revealAnchor(anchor) {{
        const target = resolveAnchor(anchor);
        if (!target) {{
          return false;
        }}
        target.scrollIntoView({{ block: 'center', inline: 'center', behavior: 'smooth' }});
        latestHovered = target;
        state.selectedAnchor = buildAnchor(target);
        positionHoverBox(target, true);
        debounceReport('reveal_anchor');
        return true;
      }},
    }},
    configurable: false,
    writable: false,
  }});

  setInspectMode(INITIAL_INSPECT_MODE);
  debounceReport('bridge_ready');
}})();
"#
    );
    window
        .eval(script)
        .map_err(|error| format!("Unable to inject task browser bridge: {error}"))
}

fn create_task_browser_window(
    app: &AppHandle,
    task_id: &str,
    session: &TaskBrowserSession,
) -> Result<WebviewWindow, String> {
    let task = {
        let connection = crate::services::database::open_connection()?;
        tasks::get_task(&connection, task_id)?
    };
    let initial_url =
        validate_browser_url(session.current_url.as_deref().unwrap_or("about:blank"))?;
    let task_id_for_load = task_id.to_string();
    let session_fallback = session.clone();
    let app_for_load = app.clone();
    let window = WebviewWindowBuilder::new(
        app,
        &session.window_label,
        WebviewUrl::External(initial_url),
    )
    .title(&format!("{} · Browser", task.number))
    .inner_size(1320.0, 860.0)
    .resizable(true)
    .visible(true)
    .on_page_load(move |window, payload| {
        if payload.event() == tauri::webview::PageLoadEvent::Finished {
            let session_for_page = crate::services::database::open_connection()
                .ok()
                .and_then(|connection| {
                    get_task_browser_session(&connection, &task_id_for_load)
                        .ok()
                        .flatten()
                })
                .unwrap_or_else(|| session_fallback.clone());
            let _ = inject_browser_bridge(&window, &task_id_for_load, &session_for_page);
            let _ = app_events::emit_window_event(
                &app_for_load,
                TASK_BROWSER_EVENT_NAME,
                &TaskBrowserChangeEvent {
                    task_id: task_id_for_load.clone(),
                    browser_session_id: session_for_page.id.clone(),
                    current_url: Some(payload.url().to_string()),
                    page_title: None,
                    inspect_mode: session_for_page.inspect_mode,
                    dom_revision: session_for_page.dom_revision,
                    last_mutation_at: session_for_page.last_mutation_at.clone(),
                    reason: "page_load".into(),
                },
            );
        }
    })
    .build()
    .map_err(|error| format!("Unable to create task browser window: {error}"))?;

    let task_id_for_close = task_id.to_string();
    let session_id_for_close = session.id.clone();
    let app_for_close = app.clone();
    window.on_window_event(move |event| {
        if matches!(
            event,
            WindowEvent::Destroyed | WindowEvent::CloseRequested { .. }
        ) {
            let _ = app_events::emit_window_event(
                &app_for_close,
                TASK_BROWSER_EVENT_NAME,
                &TaskBrowserChangeEvent {
                    task_id: task_id_for_close.clone(),
                    browser_session_id: session_id_for_close.clone(),
                    current_url: None,
                    page_title: None,
                    inspect_mode: false,
                    dom_revision: 0,
                    last_mutation_at: None,
                    reason: "window_closed".into(),
                },
            );
        }
    });

    Ok(window)
}

pub fn show_task_browser(app: &AppHandle, task_id: &str) -> Result<TaskBrowserSession, String> {
    let mut connection = crate::services::database::open_connection()?;
    let session = ensure_task_browser_session(&mut connection, task_id)?;

    let window = if let Some(existing) = app.get_webview_window(&session.window_label) {
        existing
    } else {
        create_task_browser_window(app, task_id, &session)?
    };

    window
        .show()
        .map_err(|error| format!("Unable to show task browser window: {error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("Unable to focus task browser window: {error}"))?;

    Ok(session)
}

pub fn navigate_task_browser(
    app: &AppHandle,
    task_id: &str,
    url: &str,
) -> Result<TaskBrowserSession, String> {
    let mut connection = crate::services::database::open_connection()?;
    let session = ensure_task_browser_session(&mut connection, task_id)?;
    let parsed = validate_browser_url(url)?;
    let window = if let Some(existing) = app.get_webview_window(&session.window_label) {
        existing
    } else {
        create_task_browser_window(app, task_id, &session)?
    };

    window
        .navigate(parsed.clone())
        .map_err(|error| format!("Unable to navigate task browser window: {error}"))?;

    let updated_at = now_iso();
    connection.execute(
        "UPDATE task_browser_sessions SET current_url = ?2, page_title = NULL, last_ready_state = ?3, updated_at = ?4 WHERE id = ?1",
        params![session.id, parsed.to_string(), "loading", updated_at],
    ).map_err(|error| format!("Unable to persist task browser navigation: {error}"))?;

    Ok(TaskBrowserSession {
        current_url: Some(parsed.to_string()),
        page_title: None,
        last_ready_state: Some("loading".into()),
        updated_at,
        ..session
    })
}

pub fn set_task_browser_inspect_mode(
    app: &AppHandle,
    task_id: &str,
    enabled: bool,
) -> Result<TaskBrowserSession, String> {
    let mut connection = crate::services::database::open_connection()?;
    ensure_task_browser_session(&mut connection, task_id)?;
    let updated_session = set_task_browser_inspect_mode_value(&connection, task_id, enabled)?;
    let window = if let Some(existing) = app.get_webview_window(&updated_session.window_label) {
        existing
    } else {
        create_task_browser_window(app, task_id, &updated_session)?
    };
    window
        .eval(format!(
            "window.__ORCHESTRA_BROWSER_BRIDGE__?.setInspectMode({});",
            if enabled { "true" } else { "false" }
        ))
        .map_err(|error| format!("Unable to update task browser inspect mode: {error}"))?;
    Ok(updated_session)
}

pub fn reveal_task_browser_dom_anchor(
    app: &AppHandle,
    task_id: &str,
    anchor: &TaskCommentDomAnchor,
) -> Result<TaskBrowserSession, String> {
    let session = show_task_browser(app, task_id)?;
    if let Some(window) = app.get_webview_window(&session.window_label) {
        let anchor_json = serde_json::to_string(anchor)
            .map_err(|error| format!("Unable to serialize browser anchor: {error}"))?;
        window
            .eval(format!(
                "window.__ORCHESTRA_BROWSER_BRIDGE__?.revealAnchor({anchor_json});"
            ))
            .map_err(|error| format!("Unable to reveal task browser anchor: {error}"))?;
    }
    Ok(session)
}

pub fn emit_task_browser_change(
    app: &AppHandle,
    session: &TaskBrowserSession,
    reason: impl Into<String>,
) -> Result<(), String> {
    app_events::emit_window_event(
        app,
        TASK_BROWSER_EVENT_NAME,
        &TaskBrowserChangeEvent {
            task_id: session.task_id.clone(),
            browser_session_id: session.id.clone(),
            current_url: session.current_url.clone(),
            page_title: session.page_title.clone(),
            inspect_mode: session.inspect_mode,
            dom_revision: session.dom_revision,
            last_mutation_at: session.last_mutation_at.clone(),
            reason: reason.into(),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::database;

    #[test]
    fn validates_browser_urls() {
        assert!(validate_browser_url("https://example.com").is_ok());
        assert!(validate_browser_url("http://127.0.0.1:3000").is_ok());
        assert!(validate_browser_url("about:blank").is_ok());
        assert!(validate_browser_url("file:///tmp/test.html").is_err());
        assert!(validate_browser_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn creates_task_browser_session_once_per_task() {
        let mut connection = database::open_connection().expect("connection");
        let task = tasks::create_task(
            &mut connection,
            Some("project-3248d9960c2b453e9d7e1b6894db2409"),
            crate::models::TaskUpsertInput {
                title: "Browser task".into(),
                description: None,
                task_type: "feature".into(),
                tags: Vec::new(),
                status: "ready".into(),
                priority: "P2".into(),
                workflow_id: None,
                current_lane_id: None,
                assignee_type: "unassigned".into(),
                assignee_id: None,
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: Some(10),
                archived: Some(false),
            },
        )
        .expect("task");

        let first = ensure_task_browser_session(&mut connection, &task.id).expect("first session");
        let second =
            ensure_task_browser_session(&mut connection, &task.id).expect("second session");
        assert_eq!(first.id, second.id);
        assert_eq!(first.window_label, build_window_label(&task.id));
    }
}
