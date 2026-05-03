# ORC-219 Git/GitHub landing page plan

## tl;dr
- Build a standalone Git/GitHub-facing marketing page only; do not replace the existing app entrypoint, hosted auth flow, or any existing microsite behavior.
- Implement it as a separate static page entry, most likely `github.html`, so `index.html` and `src/main.tsx` stay untouched.
- Use the UI Pro Max guidance via CLI review plus the local skill scripts; the best fit is a Feature-Rich Showcase + Interactive Product Demo + screenshot-first proof rail.
- Use real Orchestra screenshots only.
- Make the core message about running a company, organization, or project with customizable workflows, agents, roles, permissions, and live human control.
- Put the workflow story front and center: fully customizable kanban-style flows, effectively unlimited lane/flow structure, and first-class user intervention + approval requirements.
- Use GitHub mirror + direct download as the only primary public CTAs.
- Validate with `npm run build` plus a dedicated smoke test for the standalone Git page.

## Executive summary
This task should produce a Git/GitHub-facing landing page, not a new hosted-app entry flow. The page should exist beside the current Orchestra app, not in front of it, and it should not replace `index.html`, `src/main.tsx`, `HostedWebAuthGate`, or any current microsite/runtime behavior.

The safest implementation is a separate multi-page Vite entry such as `github.html` with its own lightweight React entrypoint and isolated landing-page components. That gives Orchestra a polished repository-facing marketing page while keeping the actual application untouched.

The design direction should stay screenshot-first and product-real. I reviewed the UI Pro Max repository through a CLI browser fetch and local skill tooling; the strongest fit is a developer-tool-oriented feature showcase with dense scanning, real UI proof, restrained motion, and clear download/GitHub actions.

## Current-state findings
- The current application root is `index.html` → `/src/main.tsx`; that path should remain unchanged.
- There is no public hosted flow to route through right now, so the landing page should not depend on hosted-web behavior.
- Vite already supports multi-page HTML entrypoints cleanly, so adding `github.html` is the lowest-risk way to introduce a standalone landing page.
- Real screenshot sources already exist inside the product for nearly every requested value prop:
  - workflows/task board: `src/pages/TasksPage.tsx`
  - workflow editor with lane/worktree/approval controls: `src/settings/WorkflowsPanel.tsx`
  - multi-repo + task worktree context: `src/pages/tasks/TaskDetailPage.tsx`
  - supervisor natural-language control: `src/components/SupervisorQuickChatModal.tsx`
  - Telegram orchestration: `src/settings/ChannelsPanel.tsx`
  - themes: `src/settings/GeneralPanel.tsx`
  - permissions / supervisor access: `src/components/access/AccessSummary.tsx`, `src/components/access/AccessEditor.tsx`
  - Pi/extensibility: `src/settings/HarnessPanel.tsx`, `src/settings/PiPanel.tsx`
  - mobile client: `mobile/` plus existing mobile harness surfaces
- UI Pro Max was reviewed two ways:
  - CLI browser fetch of `https://github.com/nextlevelbuilder/ui-ux-pro-max-skill`
  - local clone + skill scripts (`search.py`, `design_system.py`)
- The most useful UI Pro Max outputs for this task were:
  - landing patterns: **Feature-Rich Showcase**, **Product Demo + Features**, **Bento Grid Showcase**
  - proof guidance: screenshot-first rails and interactive-demo structure
  - developer-tool visual direction: dark/neutral workbench feel, high contrast, restrained accent color, readable typography

## Recommended implementation

### 1. Surface choice: standalone Git/GitHub page
Build the landing page as a separate static page entry.

Recommended shape:
- keep `index.html` and the current app exactly as-is
- add `github.html` as the landing-page entrypoint
- back it with a separate React entry such as `src/github-landing/main.tsx`
- keep landing-specific components in `src/github-landing/`

Explicit non-goals:
- do not replace the signed-out app entrypoint
- do not change hosted auth behavior
- do not route the existing app through the landing page
- do not remove or repurpose any current microsite/app surface

### 2. Page pattern and feel
Use a hybrid of:
- **Feature-Rich Showcase** for density and scanning
- **Interactive Product Demo** for product proof
- **Bento Grid Showcase** for feature hierarchy
- **App-store-style screenshot rails** for desktop/mobile proof

The page should feel like:
- a serious developer/workbench product
- screenshot-led and concrete
- dense but readable
- polished without glossy SaaS fluff

### 3. Content architecture

#### Hero
Suggested message direction:
- **Run a company, organization, or project with customizable workflows, agents, roles, and live oversight.**

Hero proof:
- one strong real Orchestra screenshot
- compact supporting badges/chips for workflows, worktrees, Telegram, mobile, themes, permissions

Hero CTAs:
- Primary: download Orchestra (`hnsn.io/Orchestra.zip`)
- Secondary: GitHub mirror (`github.com/berdon/orchestra`)

#### Screenshot proof rail
Use real captures only, ideally 4–6:
- workflow editor
- workflow/task board
- task worktree + repo context
- supervisor quick chat
- Telegram setup
- themes or permissions
- optional mobile screenshot

#### Feature bento grid
Core cards should include:
- **Customizable workflows** — kanban-style flows with flexible lane structure, explicit ownership, user intervention, and approval requirements
- **Projects with multi-repo support** — including task-linked repositories and native worktree-aware execution
- **Persistent agents + ephemeral role sessions** — continuity where you want it, disposable capacity where you need it
- **Supervisor control by natural language** — create tasks, coordinate work, steer execution
- **Pi underneath** — plugin/extensibility foundation
- **Rich permissions** — granular protected actions plus supervisor-level access
- **Telegram orchestration** — chat-based coordination and commands
- **Mobile parity** — real orchestration support away from the desktop
- **Themes** — customizable workbench appearance
- **Secure secrets support** — safe sharing across tasks without turning the page into vaporware copy

#### Deeper narrative sections
Recommended section order after the feature grid:
1. **Custom workflows, not a fixed pipeline**
   - emphasize customizable kanban-style flows
   - call out user intervention and approval gates
   - use workflow editor screenshot, not just a board screenshot
2. **Parallel work without repo chaos**
   - multi-repo support
   - task worktrees / worker-specific worktrees
3. **Human control stays first-class**
   - supervisor chat
   - permissions model
   - review/intervention paths
4. **Extensible by design**
   - Pi, extensions, skills, themes
5. **Operate from anywhere**
   - Telegram + mobile

### 4. Screenshot strategy
Do not invent UI.

Recommended asset location:
- `public/github-landing/`

Suggested files:
- `workflow-editor.webp`
- `workflow-board.webp`
- `task-worktree.webp`
- `supervisor-chat.webp`
- `telegram-channel.webp`
- `theme-selection.webp`
- `permissions.webp`
- `mobile-client.webp`
- optional: `pi-harness.webp`

Capture guidance:
- use deterministic seeded data
- crop for readability, not for decoration
- compress to WebP
- redact any local paths, secrets, or private identifiers if needed
- if a feature does not have a screenshot-worthy UI yet, keep the copy truthful and do not fabricate a fake panel

### 5. Implementation slice
Likely file touch points:
- `github.html`
- `src/github-landing/main.tsx`
- `src/github-landing/GitHubLandingPage.tsx`
- optional landing-only components under `src/github-landing/components/`
- landing styles, either:
  - `src/github-landing/github-landing.css`, or
  - an intentionally scoped addition to `src/styles.css`
- `public/github-landing/*`
- optional small `vite.config.ts` update only if explicit multi-entry handling becomes necessary

Files that should stay untouched unless absolutely required:
- `index.html`
- `src/main.tsx`
- `src/hostedWeb/HostedWebAuthGate.tsx`

### 6. Validation plan
Minimum:
- `npm run build`
- a standalone Playwright smoke test for `/github.html`

Recommended test coverage:
- `tests/e2e/github-landing.spec.ts`
  - page loads at `/github.html`
  - download and GitHub links are present
  - required feature copy is visible
  - workflow customization language is present
  - screenshots render without overflow
  - mobile viewport stacks cleanly
- one regression assertion that `/` still loads the existing app shell unchanged

## Screenshot-to-feature matrix
| Feature/value prop | Best proof |
|---|---|
| Customizable workflows | workflow editor + board screenshots |
| Infinite/flexible lane and flow structure | workflow editor screenshot + explicit copy |
| User intervention + approval requirements | workflow editor lane settings screenshot |
| Multi-repo + native worktrees | task detail repo/worktree screenshot |
| Persistent agents + ephemeral roles | supervisor/session/worker surfaces |
| Pi/extensibility | Harness/Pi settings |
| Permissions | access summary/editor |
| Supervisor natural-language control | supervisor quick chat |
| Telegram | Telegram channel setup |
| Mobile parity | mobile client screenshot |
| Themes | theme selection panel |
| Secure secrets support | truthful governance/security copy, plus adjacent real proof surfaces if no dedicated screenshot exists |

## Risks / watchouts
- The biggest product risk is accidentally turning this into an app-entry rewrite; the plan explicitly avoids that.
- Screenshot preparation may take longer than layout work if seeded/demo data is not ready.
- “Secure secrets support” may need careful wording if the current UI surface is less mature than other feature areas.
- The workflow story must emphasize customization, not imply a fixed canned pipeline.

## Implementation checklist
1. Keep the current app entrypoint untouched.
2. Add a separate `github.html` landing-page entry.
3. Build the landing-page React surface in `src/github-landing/`.
4. Capture and optimize real Orchestra screenshots.
5. Make workflow customization a headline feature.
6. Use only GitHub mirror + download as public CTAs.
7. Add standalone smoke coverage for `/github.html`.
8. Run build and targeted validation.
