# ORC-177 Gate Tailscale access behind remote Tailscale setting plan

## tl;dr

Treat Tailscale as runtime-active only when `remote_access.enabled && remote_access.use_tailscale`. Keep normal remote-access startup for LAN mode, move Tailscale cleanup to explicit settings transitions, and add disabled-path tests/instrumentation that fail if startup or status reads touch Tailscale.

## Executive summary

Current audit: app startup always calls `remote_api::ensure_remote_api_server(...)`, and that helper currently reaches into Tailscale-adjacent code even when the user is not using Tailscale. The same leak exists in remote-status building, which resolves Tailscale URLs whenever `use_tailscale` is merely persisted. The fix is to add one explicit runtime boundary for “Tailscale is active now,” route all Tailscale work through it, and keep one-time route cleanup on the settings-update path instead of on every startup/status refresh.

## Current-state findings

- `src-tauri/src/lib.rs` unconditionally calls `remote_api::ensure_remote_api_server(...)` during app setup.
- `src-tauri/src/services/remote_api.rs` currently lets `ensure_remote_api_server()` touch Tailscale in disabled/non-Tailscale states:
  - the `!settings.enabled` branch checks `tailscale_cli_available()` and may call `disable_matching_tailscale_serve(...)`
  - `sync_tailscale_routes()` checks CLI availability before it knows whether Tailscale should be active
- `build_remote_access_status()` resolves `tailscale_url_for_port(...)` whenever `use_tailscale` is stored, even if remote access is off.
- `src-tauri/src/commands/remote.rs` only disables a previous Tailscale route on port change; it does not do the same explicit cleanup when the user turns Tailscale off or disables remote access entirely.
- README/UI copy explains what Tailscale Serve does, but it does not clearly state that Orchestra should remain fully dormant with respect to Tailscale until the option is enabled.

## Implementation plan

1. **Add one explicit runtime boundary**
   - Add a helper such as `remote_access::tailscale_runtime_enabled(settings)` that returns `settings.enabled && settings.use_tailscale`.
   - Use that helper as the single guard for all Tailscale CLI/API/status/url code paths.

2. **Refactor remote-server lifecycle to avoid background Tailscale probes**
   - Keep the startup `ensure_remote_api_server(...)` call so LAN remote access still auto-starts when remote access is enabled.
   - Change `ensure_remote_api_server()` so the `!settings.enabled` branch only stops the server and clears state; it should not inspect Tailscale or try to clean up Serve there.
   - Only call `sync_tailscale_routes()` when `tailscale_runtime_enabled(settings)` is true.
   - Narrow `sync_tailscale_routes()` into an enable-time sync path so non-Tailscale states do not call `tailscale_cli_available()` at all.

3. **Move Tailscale cleanup to explicit settings transitions**
   - In `update_remote_access_settings()`, compare previous and next settings.
   - If the previous state had active Tailscale (`previous.enabled && previous.use_tailscale`) and the new state turns it off, disables remote access, or changes the port, do one best-effort `disable_remote_tailscale_api_route(previous.port)`.
   - After that one-time cleanup, start/stop/reconfigure the remote server normally. Subsequent app launches and status refreshes in disabled/LAN mode should perform no Tailscale work.

4. **Gate status/UI data behind the same boundary**
   - In `get_remote_access_status()`, avoid unnecessary server reconciliation when remote access is disabled, or rely on the now-safe disabled branch if the call stays in place.
   - In `build_remote_access_status()`, only populate `tailscale_url` / `tailscale_web_url` when Tailscale is runtime-active.
   - Update `README.md` and/or Remote settings helper copy to state plainly that Orchestra does not invoke Tailscale unless **Use Tailscale Serve** is enabled for active remote access.

5. **Add regression coverage for the disabled path**
   - Add a small pure planning seam and tests around the Tailscale decision boundary (for example, “none / ensure / disable previous port”).
   - Add test-only instrumentation or helper indirection so Rust tests can prove startup/status flows do not call Tailscale helpers when `enabled=false` or `use_tailscale=false`.
   - Cover three key transitions: enable Tailscale, disable Tailscale, and change port while Tailscale was previously active.

## Suggested validation

- Fresh launch with `enabled=false` and `use_tailscale=false`: no `tailscale` command/helper access.
- Fresh launch with `enabled=true` and `use_tailscale=false`: remote API starts for LAN mode, but no `tailscale` command/helper access.
- Persisted state `enabled=false`, `use_tailscale=true`: status stays Tailscale-idle and does not populate Tailscale URLs until remote access is active again.
- Enable **Use Tailscale Serve**: existing Tailscale Serve flow still activates.
- Disable **Use Tailscale Serve** or disable remote access: existing Serve route gets one cleanup attempt, then later status refreshes/startups remain Tailscale-idle.
- Run targeted Rust/TS remote-access tests plus a quick manual settings toggle pass in the desktop app.

## Notes / tradeoffs

- This intentionally removes passive Tailscale cleanup from startup and ordinary status refreshes; that is the only way to satisfy the “do not touch Tailscale unless enabled” requirement.
- Cleanup becomes best-effort on the explicit settings transition that turns Tailscale off or changes the Tailscale-served port.
