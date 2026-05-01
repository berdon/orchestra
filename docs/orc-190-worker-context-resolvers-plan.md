# ORC-190 — Canonical session ownership resolver plan

## tl;dr

- Add one shared backend resolver that loads worker/session ownership from the canonical `sessions` row first.
- Make `sessions.project_id`, `task_id`, `workflow_id`, `workflow_lane_id`, `active_assignment_id`, `owning_assignment_id`, `owning_role_instance_id`, and `owning_agent_runtime_*` the normal inputs for worker-context decisions.
- Migrate `runtime_skills`, `session_compaction`, `messages`, `reminders`, `live_sessions`, `tool_bridge`, `agent_dispatch`, and `role_dispatch` off ad hoc reverse lookups.
- Keep old `session_id -> task_lane_assignments / agent_runtime_states / role_instances` scans only as temporary parity-and-repair fallback during ORC-189/191 rollout.
- ORC-192 owns session list/detail/context read-path cutover; this task owns worker-context helpers and authorization-style lookups.

## Executive summary

Today Orchestra has several separate answers to “who owns this session right now?” Some helpers prefer an active task assignment, some prefer `agent_runtime_states.main_session_id`, some prefer `role_instances.session_id`, and some fall back to the latest historical assignment or latest updated runtime row. ORC-190 should replace that scattered inference with one canonical resolver over the new `sessions` row plus FK-backed owner links.

The key rule is simple: when a caller starts from a `session_id`, it should load the `sessions` row first and follow direct links outward. Active-assignment context should come from `sessions.active_assignment_id`; stable worker ownership should come from `owning_assignment_id`, `owning_role_instance_id`, and `owning_agent_runtime_*`; and project identity should always come from `sessions.project_id`, not from whichever runtime row or historical assignment happens to be newest.

## Current-state findings

Current reverse-inference hotspots:

| Service / function | Current lookup shape | Problem |
| --- | --- | --- |
| `runtime_skills::resolve_managed_runtime_context_for_connection` | `get_active_assignment_for_session` -> `agent_runtime_states.main_session_id` -> `role_instances.session_id` | Duplicates ownership precedence and depends on session-id scans across multiple tables. |
| `session_compaction::load_session_compaction_scope` | `agent_runtime_states.main_session_id` -> `role_instances.session_id` -> active assignment -> latest historical assignment by `session_id` | Historical fallback is especially brittle and should become an owner-link lookup. |
| `messages::{resolve_visible_assignment_mail_scope, resolve_assignment_scope_without_authorization, resolve_project_id_for_session}` | session -> active assignment or `agent_runtime_states.main_session_id` | Project/task/mail scope comes from reverse lookup instead of the session row. |
| `messages::resolve_project_id_for_send` | agent sender -> latest `agent_runtime_states` row by `updated_at` | Wrong default for global agents and ignores the current session context entirely. |
| `reminders::{resolve_agent_target_context, resolve_role_instance_target_context}` | active assignment by session -> agent runtime by `(agent_id, main_session_id)` -> latest runtime row / active assignment by role instance | Mixes stable owner lookup and “latest row wins” behavior. |
| `live_sessions::runtime_authorization_context_for_connection` | active assignment -> `agent_runtime_states.main_session_id` -> `role_instances.session_id` -> queued/active agent assignment | Authorization precedence is duplicated and split across tables. |
| `live_sessions::schedule_session_retirement` | `agent_runtime_states.main_session_id` plus active-assignment scan | Retirement rules are derived indirectly instead of from session kind/owner state. |
| `tool_bridge::resolve_active_worker_task_context` | active assignment by session, then active assignment by worker id / role instance id | Current task inference should come from the session’s canonical open-assignment link. |
| `agent_dispatch::agent_for_session` / `role_dispatch::{complete_role_run, fail_role_run}` | direct scans from session id into owner tables | These should follow owner links from the session row instead. |

## Required session invariants for this task

ORC-190 depends on ORC-189/191 establishing these invariants:

1. `sessions.project_id` is always populated and is the canonical project for the session.
2. `sessions.active_assignment_id` means the current open assignment pointer, not only `status = 'active'`.
   - It should cover the current open states Orchestra already treats as live worker context: `queued`, `active`, `awaiting_user_approval`, `awaiting_user_intervention`, and `paused_by_user`.
3. `sessions.owning_assignment_id` survives after `active_assignment_id` clears for dedicated task sessions.
4. `sessions.owning_role_instance_id` survives for role-instance sessions so post-run helpers do not need historical assignment scans.
5. `sessions.owning_agent_runtime_project_id` + `sessions.owning_agent_id` survive for agent main sessions so project resolution never depends on `ORDER BY updated_at` over `agent_runtime_states`.
6. Role-owned task sessions must still be able to resolve both:
   - the lane owner (`role`, from the assignment)
   - the runtime actor (`role_instance`, from `role_instance_id` / `owning_role_instance_id`)

## Recommended shared resolver

Add one internal helper boundary, either as a new `session_ownership` service or as a read-side module under `session_records`.

Recommended outputs:

- `project_id`
- `task_id?`
- `workflow_id?`
- `workflow_lane_id?`
- `active_assignment_id?`
- `owning_assignment_id?`
- `agent_id?`
- `role_id?`
- `role_instance_id?`
- `lane_worker_type?` / `lane_worker_id?`
- `authorization_actor_type?` / `authorization_actor_id?`
- `runtime_cwd?`
- `context_source` (`active_assignment`, `agent_main_session`, `role_instance_session`, `task_session`, `project_session`)

Recommended helper entry points:

- `load_session_worker_context(connection, session_id)`
- `load_session_authorization_actor(connection, session_id)`
- `load_session_open_assignment(connection, session_id)`
- `load_worker_session_from_authorization(connection, authorization)` for the smaller set of callers that only have an actor and must find their current session through FK-backed owner links

## Resolver rules

1. Load the `sessions` row first.
2. If `active_assignment_id` is set, load that assignment directly and treat it as the canonical current task/lane/worker context.
3. If there is no open assignment, use stable owner links:
   - agent main session -> `owning_agent_runtime_*`
   - role instance session -> `owning_role_instance_id`
   - dedicated task session -> `owning_assignment_id`
   - standalone user session -> no worker owner
4. Derive `role_id` only after ownership is known:
   - agent owner -> join `agents.role_id`
   - role assignment -> use assignment `worker_id`
   - role instance owner -> join `role_instances.role_id`
5. For authorization, active assignment wins over stale stable-owner links.
   - active role assignment -> `role_instance`
   - active agent assignment -> `agent`
   - idle agent main session -> `agent`
   - otherwise user/default only when the session row has no worker owner
6. Historical `task_lane_assignments WHERE session_id = ?` scans are allowed only as bounded dual-write fallback with logging/repair, not as the normal answer.

## Service-by-service cutover

### `runtime_skills`

Replace `resolve_managed_runtime_context_for_connection` with the shared session worker context helper.

Expected source fields:

- `project_id` from `sessions.project_id`
- task/workflow/lane from `active_assignment_id` or the session row’s denormalized active context
- `agent_id`, `role_id`, `role_instance_id` from direct owner links / worker joins

This keeps runtime skill scope resolution aligned with the same ownership rules as reminders and authorization.

### `session_compaction`

`load_session_compaction_scope` should stop scanning `agent_runtime_states`, `role_instances`, and especially the latest historical assignment by `session_id`.

Use instead:

- active assignment worker when `active_assignment_id` exists
- otherwise `owning_assignment_id`
- otherwise `owning_agent_runtime_*`
- otherwise `owning_role_instance_id`

Compaction is the strongest reason to preserve stable owner links after a session stops being active.

### `messages`

Use canonical session ownership for both mail visibility and project defaulting.

Specific changes:

- `resolve_project_id_for_session` becomes a thin `sessions.project_id` read.
- assignment mailbox scope should come from `active_assignment_id`, not `task_lane_assignments WHERE session_id = ?`.
- `send_mailbox_message_from_authorization` should thread `session_id` through project resolution so `send_mail` defaults to the current session project.
- `resolve_project_id_for_send` should prefer `session.project_id` when a live session is present, and only fall back to agent-runtime owner links when no session context exists.

### `reminders`

Use the shared resolver so reminder targets are derived from canonical session ownership.

Specific changes:

- session-scoped reminders should persist `project_id`, `task_id`, and `session_id` directly from the session row.
- agent fallback should follow `agent_runtime_states.main_session_id` -> `sessions.id`, not “latest updated runtime row wins”.
- role-instance fallback should follow `role_instances.session_id` -> `sessions.id`, then use `active_assignment_id` if the reminder semantics still require an open task session.

### `live_sessions`

`runtime_authorization_context_for_connection` should derive its answer from the shared session authorization actor helper.

Preserve the current behavior that tests already enforce:

- active assignment beats stale role-instance binding
- active agent assignment beats stale role binding
- idle agent main session still authorizes as the agent owner

`schedule_session_retirement` should use canonical session metadata instead of ad hoc reverse queries. The skip condition should come from session state such as:

- current open assignment present
- persistent agent-main-session kind / owner link present

### `tool_bridge`

`resolve_active_worker_task_context` should use the session’s canonical open-assignment link for omitted `taskId` handling.

When a worker-only fallback is still needed, follow owner links to the current session first:

- agent -> `agent_runtime_states.main_session_id` -> session row
- role instance -> `role_instances.session_id` -> session row

That avoids scanning all active assignments by worker id.

### `agent_dispatch` and `role_dispatch`

Move small session-owner helpers to canonical links too:

- `agent_dispatch::agent_for_session` should resolve the owner from the session row’s agent runtime link.
- `role_dispatch::{complete_role_run, fail_role_run}` should resolve the role instance through the session row / owner link rather than direct `role_instances WHERE session_id = ?` scans.

## Migration sequence

1. **ORC-189** — add/backfill the canonical `sessions` fields needed by worker-context resolvers.
2. **ORC-191** — dual-write all owner-link and active-assignment updates so the new resolver sees current state.
3. **ORC-190** — add the shared resolver with parity fallback, then cut over the services above.
4. **ORC-192** — separately move list/detail/context read APIs to canonical rows.
5. **ORC-193** — remove the old fallback scans once parity coverage proves the new invariants.

## Testing plan

Update existing unit coverage and add missing cases around the shared resolver.

Minimum cases:

- active role assignment beats stale `owning_role_instance_id`
- active agent assignment beats stale role binding
- idle agent main session resolves project + actor from the session row
- queued / awaiting-user / paused assignment states still count as current open assignment context
- `send_mail` in an agent session uses the current session project, not the latest runtime row for that agent
- reminder scheduling in a global-agent session does not drift to another project via `updated_at`
- compaction for a completed dedicated task session still resolves worker scope from stable owner links without historical assignment scans

## Out of scope

These are owned elsewhere in the ORC-188 breakdown:

- `list_sessions`, `get_session_record`, `find_session_context_for_session`, and session decoration/list metadata (`ORC-192`)
- session row creation/backfill and FK migration mechanics (`ORC-189`)
- dual-write lifecycle mutation paths (`ORC-191`)
- deleting `session_catalog` / `session_list_entries` and removing legacy repair-only code (`ORC-193`)
