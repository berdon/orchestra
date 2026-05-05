# ORC-235 — Active session tool permission refresh plan

## tl;dr
Existing live Pi runtimes snapshot their allowed Orchestra tools at spawn time, so permission grants only show up in newly created sessions. Fix this by treating the session authorization/tool manifest as runtime launch state: hash it, store it on `SessionRuntime`, and respawn the runtime when that hash changes.

## Executive summary
The bug is limited to already-running sessions. Newly created sessions already recompute `AuthorizationContext` + `list_bridge_tools(...)` during spawn, so they inherit newly granted permissions correctly.

The stale behavior comes from the live-runtime path:
- `SessionRuntime::spawn(...)` computes allowed tools once and passes them through `ORCHESTRA_ALLOWED_COMMANDS_JSON`.
- `extensions/orchestra-tools.ts` registers tools once from that env snapshot.
- backend permission checks are still live, but the running Pi process never re-reads its tool manifest.
- current reload behavior only respawns for cwd/skill changes; an in-process Pi `reload` does not refresh env-registered tools.

## Findings
- **Existing sessions are the failing case.** They keep the original tool manifest until the runtime process is replaced.
- **New sessions are already correct.** Spawn-time authorization/tool resolution is fresh.
- **Root cause is runtime launch-state caching, not backend permission resolution.** `command_authorization::require_permission(...)` resolves permissions live from the database; the stale part is the session-local tool registration snapshot.

## Proposed fix
1. **Introduce a runtime auth/tool snapshot helper in `src-tauri/src/services/live_sessions.rs`.**
   - Resolve current `AuthorizationContext` for the session.
   - Resolve current `list_bridge_tools(...)` result.
   - Build a stable hash/signature from the authorization actor + allowed tool list.

2. **Store that snapshot hash on `SessionRuntime`.**
   - Compute it at spawn time.
   - Use the same resolved tool list for env injection so spawn-time data and freshness checks stay identical.

3. **Extend runtime reuse/reload decisions to include auth/tool changes.**
   - In `ensure_runtime(...)`, respawn when cwd, managed skills, or auth/tool snapshot changed.
   - If the runtime is busy, defer respawn until the next idle handoff exactly like other runtime-refresh cases.
   - In `perform_session_reload(...)`, prefer respawn over in-process Pi `reload` whenever the auth/tool snapshot changed, because reloading the same process will not refresh `ORCHESTRA_ALLOWED_COMMANDS_JSON`.

4. **Keep the busy-session behavior explicit.**
   - If a manual reload is attempted while the session is still mid-run and the refreshed permissions require a respawn, return a clear “wait until idle so updated runtime context can be applied” error/log instead of pretending reload succeeded.

## Regression coverage
Add or extend Rust tests around the live-session/runtime layer to cover:
- **agent session case:** spawn/seed a runtime with no permission for a tool, grant the permission, then verify the next `ensure_runtime(...)` / reload path replaces the runtime and the new allowed-tool manifest now includes the tool.
- **role/role-instance inheritance case:** update a role permission and verify a role-instance-backed session also refreshes.
- **new-vs-existing distinction:** confirm a fresh session sees the permission immediately while an existing runtime only changes after the runtime refresh path runs.
- **manual reload case:** verify permission-manifest changes force a respawn path rather than an in-process `reload`.

## Validation target
After the fix:
- newly granted tool permissions appear in already-running sessions once they cross the normal runtime refresh boundary (`ensure_runtime(...)` on next turn or explicit reload)
- newly created sessions continue to see the fresh permission set immediately
- server-side permission enforcement remains authoritative for every tool call

## Likely files
- `src-tauri/src/services/live_sessions.rs`
- `src-tauri/src/commands/sessions.rs` (only if reload-path messaging/helper wiring needs adjustment)
- tests near `src-tauri/src/services/live_sessions.rs` and/or session command tests
