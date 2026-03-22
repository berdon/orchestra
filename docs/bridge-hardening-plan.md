# Orchestra bridge hardening plan

## Goals

- Allow concurrent Orchestra bridge requests across different sessions and workers.
- Keep per-session prompt execution serialized only where the session runtime itself requires it.
- Detect and safely clean up verified stale prior bridge instances without killing healthy active bridges.
- Expose bridge lifecycle, client, request, and cleanup diagnostics in the app.
- Make desktop and automated troubleshooting practical through explicit logs and a diagnostics panel.

## Key decisions

### Concurrent bridge request handling

The bridge listener should accept requests quickly and dispatch each request independently. A slow bridge command must not stall unrelated requests from other sessions.

The bridge remains conservative at the session runtime layer:
- one active prompt per session runtime
- follow-up and steer traffic can still use the runtime rules already enforced by the live session layer

### Bridge identity and diagnostics

Every bridge instance has a unique instance id, metadata file, and heartbeat. Every runtime client carries:
- bridge instance id
- client id
- session id
- request id

This makes diagnostics and stale cleanup evidence-based instead of heuristic-only.

### Stale cleanup policy

Cleanup only reaps bridge instances that are strongly verified stale:
- metadata exists
- owner pid is gone, or the bridge is both unresponsive and stale
- executable identity matches before attempting process termination

Healthy responding bridge instances are never killed just because they are older.

### Operational visibility

Settings → General should show:
- current bridge instance metadata
- active clients
- recent requests
- recent cleanup events
- runtime logs

## Testing expectations

- Rust tests for request diagnostics and stale cleanup
- concurrency regression coverage for bridge request handling
- browser Playwright coverage for the diagnostics panel
- desktop E2E coverage using the dedicated desktop runner, including Podman desktop execution
