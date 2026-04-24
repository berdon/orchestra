# ORC-131 UX copy-tightening and hierarchy polish plan

## tl;dr

- Focus ORC-131 on a coherent pass across the noisiest Orchestra surfaces instead of scattered one-off copy edits.
- The main issue is that long explanatory sentences are frequently rendered with `.muted-copy`, which is styled like uppercase metadata and makes the UI feel louder, denser, and more repetitive than intended.
- Prioritize Settings catalog/detail surfaces plus high-noise Task detail tabs.
- Replace low-value explanatory paragraphs with either:
  - no copy at all when the UI is already self-evident,
  - one short sentence-case supporting line when context still matters, or
  - existing tooltip / field-hint patterns when the explanation is only needed on demand.
- Explicitly address the workflow-settings example and similar seeded-install copy in Projects and Roles.
- Update focused Playwright coverage for the changed user-facing strings and any hierarchy/layout changes.

## Executive summary

ORC-131 should be implemented as a small-but-coherent UX polish pass guided by the same principles the referenced UI/UX skill implies and the repo’s own UX docs already reinforce: scan first, keep hierarchy shallow, prefer density without crowding, and use restrained helper text. The current app has multiple places where the interface explains itself too much, often with long all-caps-looking muted paragraphs that compete with the actual controls. The fix is not “rewrite every string”; it is to tighten the highest-traffic surfaces so labels, grouping, and spacing do more of the work while explanatory text becomes shorter, more contextual, and more optional.

## Current-state findings

### 1. Long helper copy is visually louder than intended

`src/styles.css` applies the same uppercase meta treatment to `.muted-copy` that it uses for eyebrow/metadata text. That works for short labels, but it is a poor fit for full explanatory sentences.

Result:
- helper paragraphs read like shouted metadata
- stacked muted paragraphs create visual noise fast
- headers become harder to scan because support text competes with the actual heading

This is the key UX issue behind the example copy in the task.

### 2. Seeded-install catalog copy repeats the same idea across multiple settings surfaces

The following surfaces all spend header space explaining that built-in records are editable:

- `src/settings/WorkflowsPanel.tsx`
- `src/settings/ProjectsPanel.tsx`
- `src/settings/RolesPanel.tsx`

These are useful facts once, but they are not high-value persistent copy. In the current UI they consume prime scan space and repeat a concept the user can infer from the normal editing controls.

### 3. Several settings panels stack too many intro paragraphs before the user can act

High-noise examples:

- `src/settings/PromptingPanel.tsx`
- `src/settings/SourceControlPanel.tsx`
- `src/settings/HarnessPanel.tsx`
- `src/settings/GeneralPanel.tsx`
- `src/settings/ChannelsPanel.tsx`

Common problems:
- two or more explanatory paragraphs before the first interaction
- relocation copy (“moved here from…”) occupying permanent space
- setup instructions embedded as body copy even when the step title already communicates the task
- infrastructure details explained inline instead of progressively

### 4. Task detail uses explanatory copy where action labels and empty states should do the work

`src/pages/tasks/TaskDetailPage.tsx` contains several long helper / empty-state strings that over-explain tabs the user is already inside, especially around:

- runtime mail
- repo files
- todos
- attachments
- dependencies

These strings are directionally helpful, but many can become shorter and more action-led.

### 5. Orchestra already has a better pattern available: concise inline hints plus optional tooltips

The repo’s existing UX docs and ORC-41 tooltip plan already point in the right direction:

- use concise labels and restrained helper text
- do not restate the label without adding meaning
- prefer explanatory tooltips for ambiguity that only some users need

So ORC-131 should mostly be a cleanup and consistency pass, not a new interaction-system project.

## Recommended implementation

### 1. Introduce a clear copy hierarchy rule for this pass

Use this decision order for each noisy string:

1. **Delete it** if the section title, control label, and nearby actions already make the meaning obvious.
2. **Shorten it to one sentence** if the user still needs context before acting.
3. **Move detail into an existing field hint or tooltip** if the explanation is only situational.

Working copy rules:
- sentence case for full helper sentences
- one idea per support line
- start with the user outcome, not Orchestra internals
- avoid explaining obvious seeded/built-in behavior repeatedly
- prefer action-led empty states over descriptive walls of text

### 2. Stop using uppercase meta styling for full explanatory sentences

Implementation should add or reuse a sentence-case supporting-copy treatment for longer helper text instead of routing those strings through `.muted-copy`.

Likely file:
- `src/styles.css`

Recommendation:
- keep `.muted-copy` for compact metadata, timestamps, badges, and tiny labels
- introduce a sentence-case subdued helper style for panel intros and longer support text

This is the highest-leverage UI polish in the ticket because it improves many surfaces at once.

### 3. Tighten the seeded catalog/library surfaces first

#### Workflows
File:
- `src/settings/WorkflowsPanel.tsx`

Required by the task:
- remove or sharply shorten the current seeded-workflow paragraph

Recommended direction:
- either remove the paragraph entirely, or reduce it to something like “Built-in workflows are editable like any other workflow.”

#### Projects
File:
- `src/settings/ProjectsPanel.tsx`

Recommended direction:
- shorten the seeded-workspace intro substantially
- collapse the task-prefix helper into one tighter hint if possible
- keep automation/source-control explanations focused on user effect

#### Roles
File:
- `src/settings/RolesPanel.tsx`

Recommended direction:
- shorten the seeded-roles intro to a single compact line or remove it if the CRUD affordances are already obvious

### 4. Tighten settings panels that currently lead with explanation instead of hierarchy

#### Prompting
File:
- `src/settings/PromptingPanel.tsx`

Plan:
- replace the two stacked intro paragraphs with one compact project-scoped summary
- move cross-navigation details out of the main header unless they are still necessary after layout review

#### Source Control
File:
- `src/settings/SourceControlPanel.tsx`

Plan:
- shorten the header intro
- rely more on the existing variables table and per-field examples
- keep “unknown template variables” as validation, not persistent prose

#### Harness
File:
- `src/settings/HarnessPanel.tsx`

Plan:
- reduce the intro to the one behavior users actually need to know: extra extensions affect new sessions, not existing ones

#### General
File:
- `src/settings/GeneralPanel.tsx`

Plan:
- tighten theme / tooltip / notification / diagnostics intros
- review whether the “Prompt settings moved” card should stay as a full explanatory block or become a smaller redirect affordance
- keep diagnostic detail visible where operationally useful, but avoid extra setup narration

#### Channels
File:
- `src/settings/ChannelsPanel.tsx`

Plan:
- keep the step structure, but shorten each step’s explanatory paragraph
- use step titles plus field labels as the primary guide
- keep precise setup details only where they unblock the user immediately
- reduce redundant wording around command project vs notification scope

### 5. Simplify Task detail helper and empty-state copy

File:
- `src/pages/tasks/TaskDetailPage.tsx`

Targeted areas:
- runtime mail helper copy
- repo files panel intro and empty states
- todos empty state / composer guidance
- attachments empty state
- dependency empty states that restate obvious status

Recommended direction:
- empty states should be short and action-oriented
- panel titles should carry the category meaning
- only keep extra explanation where the feature model is genuinely non-obvious

Example direction:
- “No repo files tracked yet. Add an important repository file here to keep it visible on the task for workers and reviewers.”
  → shorten toward “No tracked repo files yet.” plus let the button/field labels carry the rest

### 6. Treat this as one coherent UX pass, not just text replacement

The implementation should make a few structural/hierarchy improvements while touching copy:

- reduce stacked paragraphs in headers
- keep one supporting line max per section header in most cases
- let buttons/labels sit closer to the content they control
- prefer spacing/grouping over narration

That keeps the result aligned with the task’s UX goal instead of producing isolated string edits.

## Suggested scope boundary

This ticket should **not** attempt a whole-product copy rewrite.

Recommended in-scope pass:
- Settings surfaces with the highest concentration of long explanatory copy
- the explicitly called-out Workflows copy
- comparable seeded-install catalog copy in Projects and Roles
- the noisiest Task detail helper / empty-state strings
- any small CSS support needed to render supporting text more appropriately

Recommended out of scope unless implementation happens to touch them naturally:
- deep backend terminology rewrites
- entirely new help systems
- broad visual redesign beyond the local hierarchy/copy cleanup
- every empty state in every page of the app

## Coverage plan

### A. Workflow settings regression

Update:
- `tests/e2e/workflows.spec.ts`

Reason:
- it currently asserts the exact verbose workflow-library string that the task explicitly wants changed

### B. Settings-surface browser coverage

Review and update as needed:
- `tests/e2e/general.spec.ts`
- `tests/e2e/projects.spec.ts`
- `tests/e2e/roles.spec.ts`
- `tests/e2e/channels.spec.ts`

Recommended assertions:
- the cleaned headers/supporting copy still orient the user
- important actions remain visible and discoverable after copy reduction
- any new sentence-case supporting-copy class or structure renders correctly on the touched surfaces

### C. Task detail / mailbox coverage

Review and update as needed:
- `tests/e2e/tasks.spec.ts`
- `tests/e2e/inbox.spec.ts`

Recommended assertions:
- task detail tabs still expose the relevant actions after helper-copy cleanup
- runtime mail flow remains understandable and working
- empty-state changes do not break important user guidance or selectors

## Files expected to change

Core implementation:
- `src/styles.css`
- `src/settings/WorkflowsPanel.tsx`
- `src/settings/ProjectsPanel.tsx`
- `src/settings/RolesPanel.tsx`
- `src/settings/PromptingPanel.tsx`
- `src/settings/SourceControlPanel.tsx`
- `src/settings/HarnessPanel.tsx`
- `src/settings/GeneralPanel.tsx`
- `src/settings/ChannelsPanel.tsx`
- `src/pages/tasks/TaskDetailPage.tsx`

Likely coverage updates:
- `tests/e2e/workflows.spec.ts`
- `tests/e2e/general.spec.ts`
- `tests/e2e/projects.spec.ts`
- `tests/e2e/roles.spec.ts`
- `tests/e2e/channels.spec.ts`
- `tests/e2e/tasks.spec.ts`
- `tests/e2e/inbox.spec.ts`

## Validation plan

Run focused checks for the touched surfaces:

```bash
npm run build
npm run test:e2e -- tests/e2e/workflows.spec.ts tests/e2e/general.spec.ts tests/e2e/projects.spec.ts tests/e2e/roles.spec.ts tests/e2e/channels.spec.ts tests/e2e/tasks.spec.ts tests/e2e/inbox.spec.ts
```

If implementation ends up adding small pure-TS helper logic for supporting-copy behavior, also run the relevant `npm test -- ...` target for that utility.

## Recommended implementation notes for the assignee

When reviewing each paragraph, ask:
- Does this sentence change a decision the user is about to make?
- Is this already obvious from the heading, labels, or controls?
- Could this be a tooltip or field hint instead?
- Is the UI relying on prose because hierarchy/spacing is weak?

If the answer is “no” or “already obvious,” cut it.