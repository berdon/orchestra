# ORC-49 source control settings + prompting section plan

## Review update

After review, the storage recommendation changed.

Most of Orchestra’s first-class app configuration already lives in SQLite, not ad hoc JSON files:

- projects / repositories
- agents / roles / policies
- workflows
- tasks / comments / dependencies / todos / lane state
- remote access settings

The file-backed settings that exist today are the exception, not the rule:

- pi session transcripts and other filesystem-managed runtime artifacts under `~/.orchestra`
- global PI runtime boot settings in `.orchestra/settings.json`
- legacy per-project prompt / automation / worker-overlay settings in project `settings.json`

Because **Source Control** and **Prompting** are user-facing product settings rather than runtime artifacts, this plan now recommends putting the new first-class settings in the **database**, with migration/import from the existing legacy file-backed prompt settings.

## Problem summary

Orchestra already has most of the plumbing needed for project-scoped prompt customization, but the current shape does not satisfy the new source-control + prompting requirements:

- `src/types.ts` and `src/App.tsx` only expose `Settings → General`; there is no first-class `Settings → Source Control` or `Settings → Prompting` surface.
- `src/settings/GeneralPanel.tsx` currently mixes appearance, prompt-template editing, PI runtime settings, diagnostics, notifications, and logs in one panel.
- `src/lib/projectSettings.ts` and `src-tauri/src/services/project_settings.rs` currently store prompt-template settings in a legacy project `general` bucket inside a project settings JSON file.
- `src-tauri/src/services/task_runtime.rs` builds the lane prompt from task/workflow/worker data plus `{WORKER.CONTEXT}`, but it has no concept of source-control identity defaults, project overrides, or resolved git identity context.
- The current file-backed prompt settings are a legacy implementation detail, not a strong product reason to keep adding more user-facing settings outside the DB.

## Design goals

1. Add a clear global home for default git identity templates.
2. Add per-project overrides with deterministic precedence.
3. Define deterministic template semantics for `{role}` and `{agent}`.
4. Make source-control context visible to agents by default, not only after users discover a new token.
5. Move prompt-template editing out of `General` without breaking existing saved project prompt templates.
6. Keep new first-class settings in the database unless there is a strong runtime reason not to.
7. Limit file-backed state to runtime/session artifacts and existing specialized local-runtime config.
8. Keep mock/browser and Tauri behavior aligned.
9. Cover persistence, precedence, migration, and prompt propagation with tests.

## Where settings should live

### Recommended split

**Database-backed**
- global Source Control defaults
- project Prompting settings
- project task automation settings
- project Source Control overrides

**File-backed**
- PI runtime boot settings already managed by `harness_settings.rs`
- pi session/transcript/workspace artifacts
- existing worker overlay prompt files for now, unless separately migrated later

### Why the new settings should live in SQLite

These settings are:

- first-class UI configuration
- read and written through the app itself
- naturally scoped to global app state or a specific project
- good candidates for validation, migration, backup, and inspection alongside the rest of Orchestra state

Storing them in the DB gives better consistency with the rest of the app, avoids introducing another root JSON settings owner, and makes future querying/export simpler.

### Why not expand file-backed settings here

The main reasons to prefer files do **not** apply strongly to this feature:

- Source Control defaults are not runtime transcripts or large append-only artifacts.
- Prompting settings are not a process-boot concern like PI runtime extension loading.
- Adding more product settings to JSON would further entrench a split model where some first-class settings live in DB and others in scattered files for historical reasons.

## Proposed settings model

### 1. Global source-control settings: new SQLite table

Add a singleton table for global source-control defaults.

Recommended table:

```sql
CREATE TABLE source_control_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  git_user_name_template TEXT,
  git_email_template TEXT,
  updated_at TEXT
);
```

Notes:

- One row only.
- `NULL` means unset.
- This is intentionally separate from PI runtime boot settings in `.orchestra/settings.json`.

### 2. Project prompting / automation / source-control settings: new SQLite table

Add one project-scoped settings table that consolidates the current prompt template setting, existing automation flag, and new source-control overrides.

Recommended table:

```sql
CREATE TABLE project_runtime_settings (
  project_id TEXT PRIMARY KEY,
  task_session_context_template TEXT,
  auto_dispatch_on_blocker_completion INTEGER NOT NULL DEFAULT 1,
  git_user_name_template TEXT,
  git_email_template TEXT,
  updated_at TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);
```

Why this shape:

- Prompting, project automation, and per-project source control are all project-scoped runtime/editor settings.
- It avoids creating three tiny tables for highly related settings.
- It gives a clean migration target for the current file-backed project settings.

### 3. Legacy project settings JSON becomes migration input, not the long-term home

Current `project_settings.json` data is still relevant because it already stores:

- `general.taskSessionContextTemplate`
- `general.autoDispatchOnBlockerCompletion`
- worker overlay prompts

Recommended direction for this task:

- import legacy prompt / automation values from project settings JSON into `project_runtime_settings`
- keep worker overlays file-backed for now so the task does not broaden into an unrelated overlay-storage migration
- after migration, read prompt / automation / source-control settings from the DB

This keeps scope controlled while moving the settings touched by this task onto the primary persistence layer.

## Source-control template resolution spec

### Supported variables

Initial supported variables:

- `{role}`
- `{agent}`

Recommended semantics: both variables resolve to **worker slugs**, not display names.

Why slugs:

- stable and already used across Orchestra runtime prompts (`architect`, `reviewer`, etc.)
- predictable for emails and filenames
- avoids spaces/punctuation surprises in `git user.email`

### Variable availability by worker context

| Worker context | `{role}` | `{agent}` |
| --- | --- | --- |
| Role-owned lane/session | current role slug | empty string |
| Agent-owned lane/session | empty string | current agent slug |
| No worker context / preview-without-worker | empty string | empty string |

There is no extra precedence layer here: worker/session context only provides substitution values. It does **not** override the configured template.

### Resolution algorithm

For each field (`gitUserNameTemplate`, `gitEmailTemplate`):

1. Choose the effective template using field-level precedence:
   - project override if non-empty
   - else global default if non-empty
   - else unset
2. Replace supported variables:
   - `{role}` → role slug or `""`
   - `{agent}` → agent slug or `""`
3. Leave any unknown `{...}` placeholders unchanged in raw runtime resolution output.
4. Trim surrounding whitespace from the final resolved value; if empty after trim, treat the resolved value as unset.

### Unknown variables

Recommended behavior:

- UI save/update flows should treat unknown placeholders as a validation **error** and block save.
- Runtime resolution should remain non-destructive and leave unknown placeholders literal if they somehow already exist in legacy persisted data.

This gives users actionable feedback without making already-saved legacy data fatal.

### Missing variables

Missing supported variables resolve to an empty string.

Examples:

- Template `Orchestra {role}` in an agent context → `Orchestra`
- Template `orchestra+{agent}@example.com` in a role context → `orchestra+@example.com`

That means previewing matters; the UI should make these results obvious.

## Preview + validation UX

### Global `Settings → Source Control`

The global panel should include:

1. **Default git user name template** input
2. **Default git email template** input
3. a small variable table for `{role}` / `{agent}`
4. a preview table with at least these rows:
   - Role preview (`{role}=architect`, `{agent}=`)
   - Agent preview (`{role}=`, `{agent}=reviewer`)
   - No-worker preview (`{role}=`, `{agent}=`)

Each preview row should show:

- resolved `git user.name`
- resolved `git user.email`
- field origin badge (`Global default` in the global screen)
- warning state when the resolved result is empty or the email does not look email-shaped

### Project `Settings → Projects`

The project detail panel should add a **Source control** section with:

- `Git user name override` input
- `Git email override` input
- helper copy: “Leave blank to inherit the global default from Settings → Source Control.”
- the same preview rows as the global screen, but showing **effective** values after global + project precedence
- origin badges per field (`Project override`, `Global default`, `Unset`)

### Validation policy

Recommended validation split:

**Hard errors**
- unknown template variables

**Soft warnings**
- resolved name is empty in one or more preview contexts
- resolved email is empty or does not resemble an email in one or more preview contexts

Soft warnings should not block save because a project may intentionally only target role or agent workers.

## Precedence rules

Precedence should be field-by-field, not section-wide.

For `git user.name` and `git user.email` independently:

1. project override template, if non-empty
2. global source-control default template, if non-empty
3. unset

Then runtime worker context resolves `{role}` / `{agent}` inside the chosen template.

Important clarification for acceptance criterion #6:

- there is **no** additional session/runtime config layer overriding source-control settings in this task
- runtime context only supplies worker substitution values
- if a future session-specific override is added, it should sit above project overrides, but that is out of scope here

## Prompting integration

### New prompt-template tokens

Add explicit source-control prompt tokens to `ProjectSessionPromptSettings.availableTokens` / `available_session_prompt_tokens()`:

- `{SOURCE_CONTROL.CONTEXT}` — rendered block summarizing effective git identity
- `{SOURCE_CONTROL.GIT.USER_NAME}` — resolved `git user.name`
- `{SOURCE_CONTROL.GIT.EMAIL}` — resolved `git user.email`

Recommended rendered block:

```text
Source control identity:
- git user.name: Orchestra architect (global default)
- git user.email: client+architect@example.com (project override)
```

If values are unset, render that explicitly instead of silently omitting the section:

```text
Source control identity:
- git user.name: not configured
- git user.email: not configured
```

### Backward compatibility for existing saved prompt templates

Existing user-saved prompt templates may already contain `{WORKER.CONTEXT}` but will not know about the new explicit source-control tokens.

To keep current templates useful without silently rewriting user-authored prompt text:

- update the **default** template to include `{SOURCE_CONTROL.CONTEXT}` immediately after `{WORKER.CONTEXT}`
- during prompt assembly, if the saved template does **not** contain any `SOURCE_CONTROL` token, append the rendered source-control block to `{WORKER.CONTEXT}` as a compatibility fallback

That gives:

- new/default templates an explicit source-control section
- old templates with `{WORKER.CONTEXT}` automatic source-control visibility
- fully custom templates the option to place explicit source-control tokens wherever they want

### Prompting panel scope

Prompt-template settings are still **active-project scoped**, even after moving from General to Prompting.

The new panel should say that clearly in the header/copy so users understand:

- `Settings → Prompting` edits the prompt template for the currently selected project
- global source-control defaults live in `Settings → Source Control`
- project source-control overrides live in `Settings → Projects`

## UI changes

### Settings navigation

Add two new settings tabs:

- `Source Control`
- `Prompting`

Recommended navigation outcome:

- remove prompt-template editing from `General`
- keep `General` focused on appearance, PI runtime settings, diagnostics, notifications, and logs
- add command-palette entries for `Settings → Source Control` and `Settings → Prompting`
- update the existing `Settings → General` command palette subtitle so it no longer mentions prompt controls

### Discoverability details

To make the move obvious:

- `Prompting` panel should include copy like “Prompt settings moved here from Settings → General.”
- `General` panel can include a small non-blocking note/link pointing users to `Prompting`
- `Source Control` panel should say “Global defaults. Project overrides live in Settings → Projects.”
- `Projects` source-control section should say “Overrides apply only to this project.”

## Persistence + migration plan

### Tauri / Rust

1. Add SQLite migration(s) for:
   - `source_control_settings`
   - `project_runtime_settings`
2. Add DB-backed services/queries for global source-control settings.
3. Add DB-backed services/queries for project prompt / automation / source-control settings.
4. On first read or migration, import legacy values from project `settings.json`:
   - `general.taskSessionContextTemplate`
   - `general.autoDispatchOnBlockerCompletion`
5. Keep worker overlay prompts on the legacy file-backed path for now.
6. After import, treat the DB as the source of truth for the settings touched by this task.

### Browser/mock path

Update the mock/local-storage side to mirror the new behavior conceptually:

- `src/lib/projectSettings.ts` should migrate legacy `orchestra.mock.project-settings` payloads into a shape that reflects `project_runtime_settings`
- `src/lib/tauri.ts` helpers that read project automation settings should stop assuming the old `general.autoDispatchOnBlockerCompletion` nesting
- global source-control defaults should use their own mock storage entry instead of being piggybacked onto the PI runtime settings blob

## Suggested file-level implementation slices

### Frontend

- `src/types.ts`
  - add source-control settings/result types
  - add new settings-tab ids
- `src/App.tsx`
  - register new settings tabs
  - load/save prompting settings separately from source-control settings
  - render new panels
  - keep `General` loading behavior scoped to diagnostics/runtime concerns
- `src/settings/GeneralPanel.tsx`
  - remove prompt editor
  - optionally add a moved-to-Prompting notice
- `src/settings/PromptingPanel.tsx` (new)
  - move current session-prompt UI here
  - show active-project scope + new source-control tokens
- `src/settings/SourceControlPanel.tsx` (new)
  - global default git identity templates + preview/validation UI
- `src/settings/ProjectsPanel.tsx`
  - add project override section + effective preview/origin badges
- `src/lib/projectSettings.ts`
  - shift prompt / automation / source-control persistence toward a DB-backed model on the Tauri path
  - migrate browser mock storage away from the legacy `general` nesting
- `src/lib/sourceControlSettings.ts` (preferred new helper)
  - fetch/update global source-control defaults
- `src/lib/commandPalette.ts`
  - add `Prompting` / `Source Control` items
- `src/lib/tauri.ts`
  - update mock helpers that currently assume legacy project-settings nesting

### Tauri / Rust

- `src-tauri/src/services/database.rs`
  - add new tables and migration helpers
- `src-tauri/src/models.rs`
  - add global/project source-control settings models and prompt token models as needed
- `src-tauri/src/services/project_settings.rs`
  - move prompt / automation / source-control reads and writes to SQLite-backed storage
  - import legacy file-backed values when needed
  - keep worker overlay support intact
  - extend available prompt tokens
- `src-tauri/src/services/source_control_settings.rs` (preferred new service)
  - persist global source-control defaults in SQLite
- `src-tauri/src/services/task_runtime.rs`
  - resolve effective source-control identity during lane prompt build
  - inject compatibility fallback for existing `{WORKER.CONTEXT}` templates
  - expose explicit `SOURCE_CONTROL.*` tokens
- `src-tauri/src/commands/project_settings.rs`
  - add project source-control get/update commands and point prompt/automation commands at DB-backed storage
- `src-tauri/src/commands/app.rs` or a new command module
  - add global source-control get/update commands
- `src-tauri/src/lib.rs`
  - register the new commands

## Test plan

### Rust/unit coverage

1. **Global persistence**
   - save + load global source-control defaults from SQLite
2. **Project override persistence**
   - save + load project source-control overrides from SQLite
3. **Legacy migration**
   - old `general.taskSessionContextTemplate` imports into DB-backed prompting settings
   - old `general.autoDispatchOnBlockerCompletion` imports into DB-backed automation settings
4. **Template resolution**
   - `{role}` resolves in role contexts
   - `{agent}` resolves in agent contexts
   - missing variable becomes empty string
   - unknown variable is rejected by update/save validation
5. **Prompt propagation**
   - lane prompt contains effective source-control block/tokens
   - project override beats global default per field
   - legacy templates with `{WORKER.CONTEXT}` still receive source-control context via fallback

### Browser/Playwright + desktop E2E

1. `Settings → Prompting` renders the moved prompt editor and token table.
2. `Settings → General` no longer owns the prompt editor.
3. `Settings → Source Control` saves global defaults and shows preview rows.
4. `Settings → Projects` inherits global defaults, then overrides one or both fields correctly.
5. Existing mock/local-storage prompt settings created under the old `general` shape still appear in `Prompting`.
6. Desktop E2E prompt-template regression currently in `tests/desktop-e2e/general-session-prompt-template.test.ts` should move to `Prompting` and assert the new source-control token availability.

## Documentation/help text updates

Minimum expected updates:

- Prompting panel copy explaining that prompt settings moved out of `General`
- Source Control panel help text explaining `{role}` / `{agent}` and that values are global defaults
- Project source-control helper text explaining blank = inherit global default
- prompt token descriptions updated to explain source-control tokens
- update any README/help snippets or tests that explicitly refer to prompt controls living in `Settings → General`
- note in implementation comments/docs that these first-class settings now live in SQLite, while PI runtime boot settings remain file-backed

## Scope clarification

This task should focus on **settings, resolution, prompt propagation, and the storage migration needed for those settings**.

It should not require a broader change to automatically run `git config user.name/user.email` inside repositories unless the implementer finds a clearly existing hook that is already intended for this feature. The acceptance criteria only require that the effective source-control identity/context be configurable and available to agents through prompting/template plumbing.

## Recommended implementation order

1. Add DB schema + legacy import path for project prompting / automation settings and global source-control defaults.
2. Add global/project source-control CRUD APIs.
3. Add resolution utilities + tests.
4. Wire source-control context into `task_runtime` prompt assembly.
5. Move prompt UI into `Prompting` and add `Source Control` UI.
6. Add project override UI + previews.
7. Update command palette/help copy/tests.

This order keeps the new first-class settings on the primary persistence layer before the UI move finishes.
