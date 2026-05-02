# ORC-198 Harness sub-settings, model limits, usage pause enforcement, and podman E2E plan

## tl;dr

- Split `Settings → Harness` into a real sub-settings surface using the existing resizable sidebar pattern.
- Ship two Harness sub-settings now: `General` and `Models`.
- Keep provider/model limit config in Orchestra-owned Harness settings, not in Pi-compatible `models.json`.
- Represent limits as generic per-model policy rules keyed by a stable model ref (`provider` + `modelId`, with `api` retained for diagnostics) and a provider-specific usage metric key.
- Reuse the dispatcher loop for periodic checks, but throttle usage polling per provider usage scope.
- On cap hit, pause task lanes with existing pause mechanics, stop standalone session runtimes into `paused`, and record an explicit policy reason.
- Do not auto-resume when usage drops back below the cap; clear the capped state and require manual resume.
- Leave a first-class extension point for later fallback chains by separating `usage adapter -> policy evaluation -> enforcement action`.
- Base Z.ai coverage on the real authenticated usage endpoints already used by the Z.ai site, with podman desktop E2E backed by mocked responses from that real contract.

## Executive summary

Current Harness UI is still a single stacked panel (`src/settings/HarnessPanel.tsx` + `src/settings/PiPanel.tsx`), current Harness storage only persists runtime settings in `src-tauri/src/services/harness_settings.rs`, current pause behavior already exists in `pause_task_lane(...)` / `stop_session_runtime(...)`, and the app already has a background dispatcher loop in `src-tauri/src/services/dispatcher.rs` that is the natural home for periodic provider usage evaluation.

The least risky implementation is:

1. add a Harness-local sidebar/sub-settings shell,
2. move existing runtime/auth content under `Harness → General`,
3. add a new `Harness → Models` page that shows configured models plus Orchestra-owned per-model limit rules,
4. add a new backend `model_limits` service that:
   - reads limit config from Harness settings,
   - groups models by provider usage scope,
   - polls provider usage on a throttled cadence,
   - evaluates normalized usage metrics against rules,
   - pauses matching task lanes / standalone sessions,
   - persists last snapshot + capped state for audit/UX,
5. add a Z.ai usage adapter first,
6. cover the real desktop flow in the podman runner with a local mock server that implements the real Z.ai usage endpoints and response fields.

## Current-state findings

### 1. Harness settings have no internal IA yet

- `src/settings/HarnessPanel.tsx` renders runtime settings followed by `PiPanel`.
- `src/settings/PiPanel.tsx` then stacks storage paths, legacy import, provider auth, OAuth, and the raw `models.json` editor in one long page.
- There is no Harness-local navigation or route state below the top-level `settingsTab=harness`.
- The existing `ResizableSidebarLayout` + list/detail pattern already exists in `src/components/ResizableSidebarLayout.tsx` and `src/settings/ProjectsPanel.tsx`.

### 2. Harness storage only covers runtime settings today

`src-tauri/src/services/harness_settings.rs` currently persists:

- `harness.pi.extraExtensions`
- `harness.pi.defaultCompactionWindow`
- migration/setup metadata

There is no persisted Orchestra-owned model limit config yet.

### 3. Current model identity surfaces are good enough to build on

Current runtime/catalog model surfaces already expose:

- `SessionModel.id`
- `SessionModel.provider`
- `SessionModel.api`

from:

- `src/types.ts`
- `src-tauri/src/models.rs`
- `src-tauri/src/services/pi_sessions.rs`

Worker defaults currently persist only:

- `provider`
- `model`

on roles/agents.

That means the practical enforcement identity for this ticket should be:

- primary key: `provider + modelId`
- diagnostic metadata: `api`

with a follow-up note that true `provider + modelId + api` enforcement can be promoted later if Orchestra ever supports duplicate `provider/modelId` pairs across APIs.

### 4. Orchestra already has pause mechanics we can reuse

Relevant existing behavior:

- `src-tauri/src/services/task_runtime.rs::pause_task_lane(...)`
  - pauses active or queued lane work
  - updates queue/runtime state
  - moves the task into user-review ownership
- `src-tauri/src/commands/tasks.rs::pause_task_lane(...)`
  - stops the live runtime if a session exists
  - records task domain events
- `src-tauri/src/commands/sessions.rs::stop_session_runtime(...)`
  - moves standalone session runtime state to `paused`
  - records a session domain event

So this ticket does not need a brand-new pause primitive.

### 5. The dispatcher loop is already the right cadence host

`src-tauri/src/services/dispatcher.rs` already runs a background loop with bounded backoff and work batching for:

- task dispatch
- schedule processing
- whips
- reminders
- stale assignment recovery

A throttled `model_limits::process_usage_checks(...)` pass fits there cleanly.

## Z.ai usage API findings

### Auth + base URL

The live Z.ai site bundles show an axios client with:

- `baseURL: "https://api.z.ai/api"`
- `Authorization: Bearer <token>`
- `Accept-Language` header

The same endpoints also respond at `https://z.ai/api/...`.

Unauthenticated probes return:

```json
{
  "code": 1001,
  "msg": "Authentication parameter not received in Header, unable to authenticate",
  "success": false
}
```

(or the equivalent localized Chinese message from `https://z.ai/api/...`).

### Endpoint contract used by the current Z.ai web app

From the real shipped Z.ai frontend bundles:

- `GET /monitor/usage/quota/limit`
  - summary quota board used for the 5-hour and weekly usage cards
- `GET /monitor/usage/model-usage?startTime=...&endTime=...`
  - model usage time series
- `GET /monitor/usage/tool-usage?startTime=...&endTime=...`
  - tool usage time series
- `GET /monitor/usage/model-performance-day?startTime=...&endTime=...`
  - system status chart (not needed for cap enforcement)

Related but separate:

- `GET /biz/customer/speed/config/queryCustomerRpm?customerId=...`
  - current API concurrency limits page
  - useful context, but not the quota/cap source of truth for this ticket

### Response fields the current frontend expects

#### `GET /monitor/usage/quota/limit`

The current subscription page expects:

```json
{
  "code": 200,
  "success": true,
  "data": {
    "level": "lite|pro|...",
    "limits": [
      {
        "type": "TOKENS_LIMIT|TIME_LIMIT",
        "unit": 3,
        "percentage": 42,
        "currentValue": 123,
        "usage": 1000,
        "nextResetTime": "2026-05-02T03:00:00Z",
        "usageDetails": [
          {
            "modelCode": "search-prime-claude",
            "usage": 12
          }
        ]
      }
    ]
  }
}
```

The Z.ai UI maps these fields as:

- `type: "TOKENS_LIMIT" + unit: 3` -> **5 Hours Quota**
- `type: "TOKENS_LIMIT" + unit: 6` -> **Weekly Quota**
- `type: "TIME_LIMIT" + unit: 5` -> shared tool quota

So for ORC-198 the first Z.ai adapter should treat the real summary source of truth as:

- `rolling_5h_percent` <- `TOKENS_LIMIT / 3`
- `weekly_percent` <- `TOKENS_LIMIT / 6`

#### `GET /monitor/usage/model-usage`

The current frontend expects:

```json
{
  "code": 200,
  "success": true,
  "data": {
    "x_time": ["2026-04-25", "2026-04-26"],
    "tokensUsage": [123, 456],
    "totalUsage": {
      "totalTokensUsage": 579
    }
  }
}
```

#### `GET /monitor/usage/tool-usage`

The current frontend expects:

```json
{
  "code": 200,
  "success": true,
  "data": {
    "x_time": ["2026-04-25", "2026-04-26"],
    "networkSearchCount": [1, 2],
    "webReadMcpCount": [3, 4],
    "zreadMcpCount": [5, 6],
    "totalUsage": {
      "totalSearchMcpCount": 21
    }
  }
}
```

### Important product implication from the Z.ai contract

The real Z.ai summary quota endpoint is plan/quota-scope oriented, not individually model-meter oriented. That means the Orchestra design must separate:

- the **model being selected/enforced**
- the **usage scope being polled**

For Z.ai, multiple supported models can share the same upstream quota bucket.

## Harness IA + Models UX plan

### Harness sub-settings structure

Ship these Harness sub-settings now:

1. `General`
   - current runtime settings
   - runtime diagnostics
   - package/Bun diagnostics
   - storage paths
   - provider auth / OAuth
   - legacy import
2. `Models`
   - new model catalog + limits surface
   - raw advanced `models.json` editor stays here as an advanced/fallback section

This gives Harness a stable two-pane shell immediately while keeping the first new first-class section focused on `Models`.

### Models page UX

For each configured available model, render a row/card with:

- model display name
- provider id
- model id
- api label (diagnostic/help text)
- connection/availability state
- current effective limit state
- last checked time / current capped state when available
- inline edit affordance

Editing UX should use a lightweight inline card or right-side detail pane with:

- enable/disable limits for this model
- **5-hour pause threshold (%)**
- **weekly pause threshold (%)**
- validation: integer `1..100`
- preview/help text using provider terminology, e.g.:
  - `Pause when Z.ai 5-hour quota reaches 90%.`
  - `Pause when Z.ai weekly quota reaches 80%.`
- read-only current provider usage snapshot when available:
  - current percent
  - reset time
  - last checked
  - last error if polling failed

The raw `models.json` editor remains available below the structured model list as an advanced escape hatch, not the primary way to set limits.

## Data model plan

### 1. Config stays in Harness settings JSON

Add a new persisted config section in Harness settings, separate from Pi-compatible `models.json`:

```json
{
  "harness": {
    "pi": { "...": "existing runtime settings" },
    "models": {
      "policies": [
        {
          "modelRef": {
            "provider": "zai",
            "modelId": "glm-4.6",
            "api": "openai-compatible"
          },
          "usageSource": {
            "adapter": "zai_quota",
            "scopeKey": "shared_supported_models"
          },
          "rules": [
            {
              "metricKey": "rolling_5h_percent",
              "thresholdKind": "percent",
              "thresholdValue": 90,
              "action": "pause"
            },
            {
              "metricKey": "weekly_percent",
              "thresholdKind": "percent",
              "thresholdValue": 80,
              "action": "pause"
            }
          ],
          "updatedAt": "2026-05-01T00:00:00Z"
        }
      ]
    }
  }
}
```

Why this shape:

- model selection identity is explicit
- usage adapter + scope are explicit
- rules are generic strings, so future providers can add different metric keys without redesign
- action is explicit, so future fallback work can add non-pause actions

### 2. Runtime state/cache should live in SQLite, not settings JSON

Add a small runtime state table for the last known provider usage snapshot and capped state, e.g.:

- `provider_usage_snapshots`
  - `adapter`
  - `scope_key`
  - `checked_at`
  - `status`
  - `raw_json`
  - `error_message`
  - `next_poll_after`
- `model_limit_state`
  - `model_key`
  - `adapter`
  - `scope_key`
  - `is_capped`
  - `capped_at`
  - `cleared_at`
  - `last_metric_key`
  - `last_observed_percent`
  - `last_reset_at`

This keeps config durable, runtime polling state queryable, and repeat enforcement idempotent.

### 3. Persist session model identity for cheap enforcement mapping

Add a persisted session-model snapshot table, e.g.:

- `session_model_state`
  - `session_id`
  - `provider`
  - `model_id`
  - `api`
  - `updated_at`
  - `source` (`role_default`, `agent_default`, `user_selected`, `runtime_observed`)

Update it whenever Orchestra:

- sets a model on session creation for role/agent defaults
- handles `set_session_model(...)`
- loads current session model state from Pi

This avoids spinning up Pi just to answer `which open work is using model X?` during each dispatcher tick.

## Polling + enforcement semantics

### Poll cadence

- use the existing dispatcher loop
- evaluate provider usage no more often than **every 5 minutes per usage scope** after success
- retry after **~2 minutes** on transient failures/auth issues
- when a scope is already capped, keep polling on the normal cadence so the cap can clear after reset

Why 5 minutes:

- the upstream Z.ai usage/detail surfaces are not instant
- there is no product value in 5-second polling
- it is cheap enough for enforcement and reviewable in tests

### Group by usage scope, not by individual model

The usage service should:

1. load all configured model policies
2. group them by `usageSource.adapter + scopeKey`
3. poll each source once
4. evaluate every affected model policy against the normalized snapshot

For Z.ai, that avoids N identical calls for N GLM models that all share the same subscription quota bucket.

### Failure behavior

If a provider usage API fails:

- do **not** pause new work solely because usage is temporarily unknown
- preserve the last known capped state if one already exists
- log a structured warning
- surface the last error in `Harness → Models`
- retry on the shortened backoff

This is safer than fail-closed pausing on temporary provider outages.

### What gets paused

When a limit is exceeded:

1. **open task lanes** using that model
   - call existing task pause mechanics
   - active lanes pause immediately
   - queued worker-owned lanes pause before starting
2. **standalone sessions** using that model
   - stop the runtime so the session becomes `paused`
   - append a system/domain event with the model-limit reason
3. **new dispatch / new prompt attempts** against a capped model
   - block before work starts
   - surface a clear reason instead of letting work start and then immediately pausing

### Visible/auditable reason

Record a consistent policy reason message, e.g.:

`Auto-paused by Harness model limit: zai/glm-4.6 exceeded rolling_5h_percent (92% >= configured 90%). Source: z.ai /monitor/usage/quota/limit. Reset at 2026-05-02T03:00:00Z.`

Use that reason in:

- task pause notes / task domain events
- session pause domain events / transcript system event
- models settings diagnostics

### Repeated checks while still capped

- do not emit duplicate pause actions for already-paused work
- keep the capped state updated
- keep blocking new work on the capped model
- log only state transitions or significant changes, not every identical tick

### When usage falls back below the threshold

- clear the capped state automatically
- do **not** auto-resume lanes or sessions
- show that the cap cleared and require explicit manual resume / redispatch

This is the safest behavior for an auditable first version.

## How to identify work using a given model

### Task lanes

Use two sources, in priority order:

1. **persisted session model snapshot** for assignments that already have a session
2. **role/agent default provider+model** for queued work that has not started a session yet

### Standalone sessions

Use the persisted session model snapshot table only.

### Matching rule

For this ticket, match by:

- `provider`
- `modelId`

and retain `api` in stored snapshots and diagnostics.

If a future runtime catalog exposes duplicate `(provider, modelId)` pairs with different APIs, that should trigger a follow-up to promote `api` into first-class selection/enforcement identity everywhere.

## Future fallback chain integration

Do not fuse usage polling directly to pause behavior.

Instead keep three layers:

1. **usage adapter**
   - calls provider API
   - returns normalized usage metrics
2. **policy evaluator**
   - applies model rules to normalized metrics
   - returns decisions like `allowed` / `capped`
3. **enforcer**
   - today: `pause`
   - future: `fallback_to_next_model`, then pause only if the chain is exhausted

That lets a later task add fallback chains without redesigning storage, polling, or normalization.

## Implementation plan

1. **Harness IA refactor**
   - convert `HarnessPanel` to a sidebar/detail layout
   - add `General` + `Models` Harness sub-settings state
   - update browser/mobile layout coverage
2. **Harness settings schema extension**
   - add `harness.models.policies`
   - migration/load/save support in `harness_settings.rs`
3. **Models settings UI**
   - structured model list
   - edit form for 5-hour + weekly thresholds
   - validation + last-check diagnostics
   - keep raw `models.json` editor in the same section as advanced fallback
4. **Usage adapter + normalization layer**
   - add Z.ai adapter first
   - normalize `quota/limit` response into `rolling_5h_percent` and `weekly_percent`
5. **Runtime state persistence**
   - add usage snapshot / cap state / session-model snapshot storage
6. **Dispatcher integration**
   - add throttled `process_usage_checks(...)`
   - cache success/failure timings per usage scope
7. **Enforcement integration**
   - pause open/queued lanes
   - stop standalone session runtimes
   - block new work on capped models
8. **Coverage**
   - backend unit/integration tests for parsing, evaluation, retries, mapping, and pause reasons
   - podman desktop E2E with mocked Z.ai usage endpoints based on the real contract

## Validation plan

### Backend / unit

- limit parsing + validation
- Z.ai response normalization
- grouped polling / throttle behavior
- cap transition idempotence
- session/assignment model mapping
- pause reason formatting
- provider usage error handling

### Browser / shared UI

- Harness sub-settings navigation
- `Models` form validation and save/reset behavior
- narrow viewport no-overflow checks

### Podman desktop E2E

Add a focused desktop spec, e.g. `tests/desktop-e2e/harness-model-limits.test.ts`, that:

1. opens `Settings → Harness → Models`
2. configures Z.ai-backed model limits in the real desktop app
3. starts a local mock HTTP server implementing the real Z.ai endpoints:
   - `GET /api/monitor/usage/quota/limit`
   - optional detail endpoints if the UI surfaces them
4. seeds below-threshold quota -> runs dispatcher tick -> asserts no pause
5. seeds 5-hour over-threshold quota -> runs dispatcher tick -> asserts task lane/session pause with visible reason
6. seeds weekly over-threshold quota -> runs dispatcher tick -> asserts the same
7. verifies audit-visible consequences in task/session state

The mock server should return the real response fields the live Z.ai site uses today, not a made-up adapter-only contract.
