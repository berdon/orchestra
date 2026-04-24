# ORC-146 — effective skills resolution and Pi runtime loading plan

## tl;dr

- Add a dedicated runtime-skills service that resolves a managed session context into one deterministic effective skill set, then splits the winners into:
  - **ambient global winners** published under `~/.orchestra/runtime/pi/agent/skills/`
  - **scoped winners** materialized under `~/.orchestra/runtime/pi/skill-snapshots/<snapshot-id>/` and passed via ordered repeated `--skill` args
- Do **not** treat the catalog’s persisted `skills.status = 'shadowed'` as the final runtime winner filter. ORC-146 needs a fresh scope-aware merge using `lane > workflow > agent > role > project > global`, with `local > external` only within a scope, plus deterministic same-record dedupe and same-slug suppression.
- Keep ambient skills enabled. Do **not** add `--no-skills`. The hybrid model is:
  - default `~/.agents/skills` stays ambient
  - Orchestra-managed global winners become ambient through `PI_CODING_AGENT_DIR/skills`
  - only non-global scoped additions are loaded explicitly with `--skill`
- Treat any slug that would be loaded both ambiently and explicitly as a hard validation/runtime error instead of relying on mixed-source ordering.
- Track a runtime skill-context hash alongside cwd. If the desired skill plan changes, respawn the runtime; Pi’s in-process reload is not enough because launch args and ambient publication live outside the session file.

## Executive summary

ORC-144 and ORC-149 already established the two core inputs for this slice:

- a persistent skills catalog (`skills`) with local vs external source metadata
- a centralized binding model (`skill_scope_bindings`) across global / project / role / agent / workflow / workflow-lane scopes

ORC-146 should now turn those inputs into the real runtime behavior that the ORC-140 plan promised.

The key design move is to add one authoritative **runtime resolution + materialization** layer instead of scattering skill logic across launch sites. That layer should:

1. resolve the current managed runtime context
2. load every binding candidate that applies to that context
3. apply the ORC-140 precedence and dedupe rules deterministically
4. publish only the winning global skills into Orchestra’s Pi agent directory
5. materialize the winning non-global skills into a snapshot directory
6. build the final Pi argv/environment for launch or respawn

That keeps the hybrid ambient model intact while still making the scoped additions deterministic and auditable.

## Current seams and constraints

- `src-tauri/src/services/skills.rs` owns the catalog rows and file-backed local skill content.
- `src-tauri/src/services/skill_bindings.rs` owns binding CRUD and reverse-link queries, but it does not yet resolve an effective runtime set.
- `src-tauri/src/services/orchestra_paths.rs` already exposes the two runtime paths ORC-146 needs:
  - `orchestra_pi_agent_skills_dir(root)`
  - `orchestra_pi_skill_snapshots_dir(root)`
- `src-tauri/src/services/pi_sessions.rs::apply_orchestra_pi_environment()` already points managed runtimes at `PI_CODING_AGENT_DIR=~/.orchestra/runtime/pi/agent`, which is exactly where ambient global publication should live.
- `src-tauri/src/services/live_sessions.rs` owns the RPC runtime spawn / reload / respawn behavior and currently only varies reuse by cwd.
- `src-tauri/src/services/agent_terminal.rs` has a second Pi launch path that currently duplicates launch-arg assembly.
- `src-tauri/src/services/task_runtime.rs` and `src-tauri/src/services/agent_dispatch.rs` are the main places that recover or reuse worker sessions.
- `src-tauri/src/services/session_compaction.rs` already has a good pattern for “resolve scope from session / assignment / agent / role instance” and should be reused conceptually instead of inventing another ad hoc session-context lookup.

Important constraint from the existing ORC-144 implementation:

- the catalog currently persists `status = shadowed` for some external rows as a discovery/collision status
- ORC-146 should **not** use that status as the final runtime exclusion rule
- otherwise a lower-scope local row would incorrectly suppress a higher-scope external binding before the ORC-146 precedence rules even run

For runtime resolution, only these statuses should be treated as immediately unloadable:

- `missing`
- `invalid`
- `unloadable`
- archived local rows

`shadowed` should remain useful for UI/discovery, but runtime resolution needs to recompute the real winner set from the bound rows.

## Recommended implementation

### 1. Add one dedicated runtime-skills service

Add a new backend service, recommended name:

- `src-tauri/src/services/runtime_skills.rs`

Recommended internal responsibilities:

- resolve the managed runtime context for a session / worker launch
- load candidate bound skills for that context
- compute the effective winners
- publish global winners ambiently
- materialize scoped winners into a snapshot
- return the final launch plan (`--skill` args + context hash + manifest metadata)

Recommended internal types:

- `ManagedSkillRuntimeContext`
  - `session_id?`
  - `project_id`
  - `role_id?`
  - `agent_id?`
  - `workflow_id?`
  - `workflow_lane_id?`
  - `context_source` (`user_session`, `agent_main_session`, `role_instance`, `task_assignment`, etc.)
- `ResolvedRuntimeSkillCandidate`
  - skill row metadata
  - matched scope kind
  - deterministic precedence tuple
- `EffectiveRuntimeSkills`
  - `global_winners`
  - `scoped_winners`
  - `suppressed_same_record`
  - `suppressed_same_slug`
  - `ambient_slug_collisions`
- `MaterializedSkillSnapshot`
  - `snapshot_id`
  - `snapshot_dir`
  - ordered `skill_paths`
  - manifest path
- `ManagedPiSkillLaunchPlan`
  - `context_hash`
  - `global_publication_manifest_path`
  - optional `snapshot`
  - ordered `skill_args`
  - resolution notes / warnings for logs

This service should stay backend-internal in ORC-146. ORC-145 can later expose diagnostics from the same structures.

### 2. Resolve runtime context from the actual managed session state

ORC-146 needs more than just `AuthorizationContext`. The runtime skill context needs the project plus the applicable worker/workflow scope.

Recommended resolution rules:

1. **Always resolve `project_id` first**
   - for task assignments: from the task
   - for agent main sessions: from `agent_runtime_states.project_id`
   - for normal stored sessions: from the session context / owning project

2. **If there is an active task assignment for the session**
   - use `workflow_id` and `lane_id` from `task_lane_assignments`
   - for `worker_type = agent`, set `agent_id = worker_id` and derive `role_id` from `agents.role_id`
   - for `worker_type = role`, set `role_id = worker_id` or fall back through `role_instances.role_id`

3. **If there is no active assignment but the session is an agent main session**
   - use `project_id + agent_id + agent.role_id`
   - do not add workflow/lane scope

4. **If there is no active assignment but the session is a role instance session**
   - use `project_id + role_id`

5. **Otherwise treat it as a normal user-managed project session**
   - use `project_id` only

This means the effective scope ladder for a plain project session is simply:

- `project > global`

while an active lane worker can see:

- `lane > workflow > agent > role > project > global`

Agent-role inheritance from ORC-149 should remain derived here: if an agent has a `role_id`, the resolver includes both the agent scope and the inherited role scope.

### 3. Compute the effective winners with one deterministic ordering pass

The runtime resolver should load every bound skill row that matches the resolved context and then sort candidates by this precedence tuple:

1. scope precedence
   - `workflow_lane`
   - `workflow`
   - `agent`
   - `role`
   - `project`
   - `global`
2. source precedence within the same scope
   - `local`
   - `external`
3. deterministic tie-breakers
   - binding creation/update timestamp if needed
   - skill id
   - external `relative_source_path`
   - source path

Then apply dedupe in this order:

#### 3.1 Same-record dedupe

If the same `skill_id` appears multiple times because one skill is bound at multiple matching scopes, keep only the highest-precedence occurrence and record the rest as suppressed duplicates.

That is what lets a skill be bound both globally and to a narrower scope without loading twice.

#### 3.2 Same-slug suppression

After same-record dedupe, iterate the ordered candidates and keep only the first occurrence of each slug.

- later rows with the same slug but a different `skill_id` are suppressed
- this is the ORC-146 runtime-time version of “local vs external / scope vs scope” winner selection
- unlike the ORC-144 catalog status, this suppression is context-sensitive and uses the real scope ordering

#### 3.3 Partition the final winners

Only after the full ordered winner pass should the resolver split winners into:

- **ambient globals**: winners whose surviving occurrence is `global`
- **scoped additions**: winners whose surviving occurrence is `project`, `role`, `agent`, `workflow`, or `workflow_lane`

That partition matters because a skill bound globally and more narrowly should become a scoped winner only; it must **not** also remain ambient just because a lower-precedence global row exists.

### 4. Publish the winning global skills into `~/.orchestra/runtime/pi/agent/skills/`

Global publication should be derived from the **surviving global winners only**, not from every global binding row.

Recommended materialization shape:

```text
~/.orchestra/runtime/pi/agent/skills/
  manifest.json
  <slug>/
    SKILL.md
    ...extra files when copied from an external skill directory...
```

Recommended rules:

- local winners publish as `<slug>/SKILL.md` generated from the authored markdown body
- external winners publish by copying the full source directory so relative assets remain intact
- publication should happen through a staging directory and atomic swap to avoid half-written ambient state
- `manifest.json` should record at least:
  - skill id
  - slug
  - source kind
  - winning scope
  - source path
  - published directory path
  - generated timestamp
  - input hash / publication hash

This service should also remove stale published entries that are no longer global winners.

No new DB table is required for this first pass. The filesystem manifest is enough.

### 5. Materialize scoped snapshots under `~/.orchestra/runtime/pi/skill-snapshots/<snapshot-id>/`

Every non-global winner should be materialized into a deterministic snapshot directory.

Recommended shape:

```text
~/.orchestra/runtime/pi/skill-snapshots/<snapshot-id>/
  manifest.json
  skills/
    000-project-skill/
      SKILL.md
    001-agent-playbook/
      SKILL.md
    002-workflow-helper/
      SKILL.md
      templates/
      examples/
```

Recommended rules:

- build `snapshot-id` from a stable hash of the normalized scoped winner manifest inputs
  - surviving ordered winners
  - their winning scopes
  - source kind / source path / relevant timestamps
  - the resolved runtime context tuple
- local skills should materialize as deterministic per-skill directories containing `SKILL.md`
- external skills should copy the full source directory when selected so nested assets remain usable
- `manifest.json` should record the ordered list of materialized skill directories and the exact `--skill` argv order to use
- snapshot creation should be idempotent: if the same `snapshot-id` already exists with a matching manifest, reuse it

Using per-skill directories for both local and external winners keeps the launch path uniform: every explicit `--skill` argument points at a directory.

### 6. Treat ambient-vs-explicit collisions as hard errors

Because ORC-146 must keep ambient skill loading enabled, Orchestra cannot safely rely on Pi to pick the “right” winner when the same slug appears in both sources.

At minimum, ORC-146 should compute an ambient slug set containing:

- default ambient external slugs discovered from `~/.agents/skills`
- surviving ambient global winner slugs published into `PI_CODING_AGENT_DIR/skills`

Then it should fail resolution if any scoped winner slug appears in that ambient set.

That validator should be shared across:

- runtime launch/respawn resolution (**authoritative**)
- optional binding-save preflight in `set_skill_bindings` for obviously impossible cases

Important implication of the approved hybrid model:

- a discovered external skill from the default `~/.agents/skills` tree is already ambient by default
- so binding that same slug as a non-global scoped skill will usually be a collision unless the ambient source disappears or is renamed
- ORC-146 should make that conflict explicit instead of silently double-loading it

If the global publication pass would also introduce an ambient slug collision with a default ambient external skill, it should fail the same validator rather than publishing ambiguous ambient duplicates.

ORC-145 can later surface these conflicts in the UI/runtime details, but ORC-146 should make the backend/runtime behavior authoritative first.

### 7. Centralize the skill-aware Pi launch plan

Today the managed spawn paths are split across:

- `src-tauri/src/services/live_sessions.rs`
- `src-tauri/src/services/agent_terminal.rs`
- potentially `src-tauri/src/services/pi_launch.rs` where managed interactive launches should stay consistent

ORC-146 should centralize the launch assembly so those paths all consume the same `ManagedPiSkillLaunchPlan`.

Recommended behavior:

- keep the existing `--no-extensions` + explicit extension loading behavior
- keep ambient skills enabled
- do **not** append `--no-skills`
- append repeated ordered `--skill <materialized-dir>` only for the scoped winners

That centralization should cover both the initial spawn and any runtime respawn path.

### 8. Track a skill-context hash and respawn when it changes

The current runtime reuse logic in `live_sessions::ensure_runtime()` only compares cwd (plus whether a prompt is active). That is not enough for ORC-146.

Recommended change:

- store the last applied `skill_context_hash` on `SessionRuntime`
- recompute the desired launch plan whenever Orchestra is about to reuse, reload, or respawn a managed runtime
- if cwd is the same **but** the desired skill-context hash differs, respawn the runtime instead of reusing it unchanged

Why respawn is required:

- Pi’s in-process reload does not change the process argv
- ambient publication state and explicit `--skill` args both live outside the session file
- so a runtime with stale launch args cannot be corrected by session-file reload alone

Recommended boundary points for the fresh comparison:

- `live_sessions::ensure_runtime()`
- manual session reload flow in `src-tauri/src/commands/sessions.rs`
- worker-session acquisition in `task_runtime.rs`
- agent main-session reuse in `agent_dispatch.rs`
- agent terminal spawn in `agent_terminal.rs`

If the runtime is currently busy, ORC-146 should avoid interrupting the active turn just to change skills. Instead:

- mark the desired skill hash as newer
- respawn on the next safe idle/reload boundary

That matches the existing “apply after current turn” model used elsewhere in the runtime stack.

### 9. Refresh / rebuild on demand instead of inventing a cache-first system

ORC-146 does not need a new persistent “effective skills” table.

A simpler first pass is:

- resolve the managed skill plan fresh whenever Orchestra acquires or reloads a managed runtime
- compare the resulting context hash to the live runtime’s last applied hash
- rebuild publication / snapshot state only when the normalized plan changes

That naturally covers:

- session context changes
- task lane / workflow changes
- agent-role changes
- skill CRUD / archive / unarchive / delete
- binding changes
- external-discovery refreshes

If a mutation path wants to be proactive, it can best-effort trigger global-publication reconciliation after commit, but the launch-time resolver should remain the authoritative path that guarantees correctness.

### 10. Logging and audit hooks

Even though ORC-145 owns the UI diagnostics, ORC-146 should add backend logs for the important decisions:

- `skills.runtime.context_resolved`
- `skills.runtime.resolved`
- `skills.runtime.global_published`
- `skills.runtime.snapshot_materialized`
- `skills.runtime.collision`
- `sessions.runtime.respawn.skills_changed`

Those logs will make the later diagnostics slice much easier to build and debug.

## Test coverage

### 1. Resolver unit coverage

Add focused Rust tests for:

- precedence across `lane > workflow > agent > role > project > global`
- `local > external` within the same scope
- same-record dedupe when one skill is bound at multiple matching scopes
- same-slug suppression across different records
- agent-role inheritance during runtime resolution
- ignoring catalog `shadowed` status as a hard runtime exclusion
- rejecting `missing` / `invalid` / `unloadable` / archived rows

### 2. Global publication coverage

Add tests for:

- publishing only surviving global winners
- local skill publication as generated `SKILL.md`
- external full-directory copy publication
- manifest generation
- atomic stale-entry replacement / cleanup
- ambient collision rejection before publication

### 3. Scoped snapshot coverage

Add tests for:

- deterministic snapshot ids
- deterministic ordered `--skill` paths in the manifest
- local snapshot materialization
- full-directory external snapshot copies with nested files preserved
- snapshot reuse when the normalized plan hash is unchanged

### 4. Launch-arg construction coverage

Add tests around the shared launch-plan builder so managed runtimes prove that they:

- keep ambient skills enabled
- do not add `--no-skills`
- append only the ordered scoped `--skill` args
- continue to load the Orchestra extension and configured extra extensions as before

### 5. Reload / respawn behavior coverage

Add runtime tests proving that:

- a runtime is reused when cwd and skill-context hash both match
- a runtime respawns when cwd changes
- a runtime also respawns when the skill-context hash changes even if cwd does not
- manual reload uses the new skill-aware plan instead of leaving stale args in place
- worker/agent session reuse paths pick up binding or context changes on the next safe boundary

## Repo touch points

Expected primary files:

- `docs/orc-146-effective-skills-runtime-loading-plan.md` **(new)**
- `src-tauri/src/services/runtime_skills.rs` **(new, recommended)**
- `src-tauri/src/services/skills.rs`
- `src-tauri/src/services/skill_bindings.rs`
- `src-tauri/src/services/orchestra_paths.rs`
- `src-tauri/src/services/live_sessions.rs`
- `src-tauri/src/services/task_runtime.rs`
- `src-tauri/src/services/agent_dispatch.rs`
- `src-tauri/src/services/agent_terminal.rs`
- `src-tauri/src/services/pi_launch.rs` **(if managed interactive launch should share the same skill-aware arg builder)**
- `src-tauri/src/services/pi_sessions.rs`
- `src-tauri/src/services/mod.rs`
- `src-tauri/src/models.rs` **(only if internal structs need to cross service boundaries)**

## Explicit non-goals for ORC-146

Do not expand this slice into:

- Settings/runtime diagnostics UI for managed skills
- migration callouts or operator-facing warning surfaces
- `skills.*` permission work or remote/API parity
- a new persistent DB table for cached effective-skill views unless implementation proves it is truly necessary

Those remain the responsibility of ORC-145 and ORC-147.

## Recommended execution order

1. add `runtime_skills.rs` with context resolution and pure precedence/dedupe tests
2. add global publication + snapshot materialization + manifest tests
3. centralize skill-aware launch-arg assembly
4. thread the launch plan into `live_sessions.rs` and `agent_terminal.rs`
5. extend runtime reuse/reload logic to compare `skill_context_hash` and respawn when needed
6. wire task/agent session acquisition paths to the new skill-aware reuse behavior
7. finish collision, publication, snapshot, and reload/respawn regression coverage

## Handoff note

The main trap in this slice is to over-trust the catalog’s persisted `shadowed` status or Pi’s in-process reload behavior. ORC-146 needs a **fresh, context-sensitive resolution pass** and a **skill-aware respawn path**. If those two pieces are correct, the hybrid ambient model stays deterministic: global winners are ambient through Orchestra’s Pi agent dir, scoped winners are explicit `--skill` additions, and ambiguous ambient/explicit slug overlap becomes a deliberate error instead of an undocumented ordering accident.
