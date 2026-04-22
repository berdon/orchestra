# ORC-19 task tag create/edit/detail UX plan

## Problem summary

ORC-14 already defined the canonical tag semantics for Orchestra tasks:

- tags are exposed inline as `tags: string[]`
- canonical form is lower-case
- allowed characters are `a-z`, `0-9`, `_`, `-`
- tags are normalized on commit, de-duplicated, blank values are dropped, and the canonical array is lexicographically sorted
- the backend remains authoritative on validation, with a max length of 32 characters and a max of 20 tags per task

ORC-19 is the UI slice that makes those semantics usable in day-to-day task editing and reading.

Today that UX is still missing:

- `src/pages/tasks/TaskEditorForm.tsx` has no tag field, even though it is the shared editor used by task create and task detail edit flows.
- `src/pages/tasks/TaskDetailPage.tsx` has no read-only tag rendering outside edit mode.
- `src/pages/TasksPage.tsx` creates task drafts, clones detail payloads back into drafts, and saves/publishes tasks, but it has no `tags` draft plumbing yet.
- task save failures currently surface as a page-level error string at the top of `TasksPage.tsx`, so the tag UX cannot rely on backend save errors alone if it wants clear inline feedback.
- `src/styles.css` has generic chip-like patterns (`access-chip`, `filter-chip`) but no dedicated token-input layout for editable task tags.

The ORC-19 deliverable should therefore be an implementation-ready task-tag editor/detail experience that matches ORC-14 semantics without inventing new backend rules.

## Goals

1. Add a reusable token/chip tag input that can be dropped into task forms.
2. Make tag entry obvious in both create and edit flows.
3. Render tags prominently on the task detail summary outside edit mode.
4. Mirror ORC-14 normalization and validation rules locally so users get inline feedback before save.
5. Define deterministic keyboard, duplicate, and paste behavior.
6. Keep the solution aligned with the shared task editor architecture already in the repo.

## Non-goals

This ticket should not expand into:

- task-list/filter/sort UI work from ORC-20
- backend/schema/tool transport work from ORC-17 and ORC-18
- a global tag catalog, autocomplete suggestions, or saved filter UX
- in-place contenteditable chip renaming
- bulk-edit tag operations across multiple tasks

## Dependency context

ORC-19 is correctly blocked on ORC-17.

This plan assumes ORC-17 lands the model contract below before ORC-19 implementation begins:

- `TaskSummary.tags: string[]`
- `TaskDetail.tags: string[]`
- `TaskUpsertInput.tags: string[]`
- create/update/detail transport support for `tags`
- backend-authoritative normalization and validation using the ORC-14 rules

ORC-19 should mirror those rules for UX, but should not redefine them.

## Current-state implementation constraints

## Shared editor architecture

`TaskEditorForm.tsx` is already the right integration point because it is reused by:

- task creation in `src/pages/tasks/TaskCreatePage.tsx`
- task detail editing in `src/pages/tasks/TaskDetailPage.tsx`
- scheduled task blueprint editing in `src/pages/tasks/TaskScheduleEditorForm.tsx`

That means a single shared tag field can cover task create and task edit without duplicating form markup.

## Read-only detail layout

`TaskDetailPage.tsx` currently shows a read-only summary with:

- overview header/actions
- description card
- current-lane todo warning
- default repo file preview
- comment summary
- recent history

There is no tag surface in read-only mode, so tags would remain invisible unless the user opens edit mode. ORC-19 should fix that by adding a dedicated read-only tags card to the summary area.

## Error-surfacing constraint

`TasksPage.tsx` currently surfaces save failures through `taskActionError`, which renders as a single page-level `<p className="error-copy">…</p>` above the task page.

That is fine for transport/runtime failures, but it is not enough for the tag field itself because users need inline feedback when a commit candidate is invalid. The tag input therefore needs local validation/error state of its own.

## Recommended UX architecture

## 1. Add a shared UI helper for tag normalization/parsing

Create a small frontend helper module, e.g.:

- `src/lib/taskTags.ts`

This helper should mirror ORC-14/ORC-17 semantics for UI-only commit behavior.

Recommended responsibilities:

- trim and lowercase a candidate tag on commit
- split pasted text into multiple candidate tokens
- de-duplicate against the existing tag set and within the incoming batch
- enforce the same max-count/max-length/syntax rules used by the backend
- return structured results suitable for inline error messaging

Recommended helper rule:

- the helper is a UX mirror, not the source of truth
- the backend remains authoritative if the two ever drift

That keeps `TaskTagInput` focused on interaction logic instead of burying normalization rules in component event handlers.

## 2. Add a reusable tag field component

Create a reusable component, e.g.:

- `src/components/TaskTagInput.tsx`

Recommended component contract:

```ts
interface TaskTagInputProps {
  tags: string[];
  onChange: (tags: string[]) => void;
  disabled?: boolean;
  label?: string;
  helperText?: string;
  dataRolePrefix?: string;
}
```

Recommended internal state:

- `draftValue: string`
- `errorMessage: string | null`
- `focusedChipIndex: number | null`

Recommended rendering structure:

- field label (`Tags`)
- short helper copy explaining the syntax/limit
- chip list for committed tags
- inline text input for the next candidate tag
- inline error message below the control when commit fails

This component should own all token-input behavior so `TaskEditorForm` only has to pass `draft.tags` and `onChange`.

## 3. Add dedicated tag styling instead of overloading unrelated chips

Add focused task-tag styles in `src/styles.css` rather than reusing access-control classes verbatim.

Recommended classes:

- `.task-tag-field`
- `.task-tag-field__shell`
- `.task-tag-list`
- `.task-tag-chip`
- `.task-tag-chip--readonly`
- `.task-tag-chip__remove`
- `.task-tag-input`
- `.task-tag-error`
- `.task-tag-helper`
- `.task-tag-empty`

The visual language can borrow spacing/color ideas from `access-chip`, but the task-tag field should stay semantically separate so it is easy to evolve later.

## Form integration plan

## Insert tags into `TaskEditorForm.tsx`

Add a full-width `Tags` field to `TaskEditorForm.tsx`.

Recommended placement:

1. title
2. type/status/priority/workflow/whip fields
3. existing whip helper copy
4. **tags field**
5. description
6. repositories

Why this placement:

- it keeps tags close to the core task metadata
- it avoids burying tags below repository selection
- it preserves the current relationship between the whip field and its helper copy
- it makes the field appear in both create and detail-edit flows automatically

Recommended helper copy:

- `Lower-case tags only. Use letters, numbers, - and _. Up to 20 tags.`

## `TasksPage.tsx` draft plumbing

Update the task draft helpers so tags round-trip cleanly through the existing create/edit flows:

- `createBlankTaskDraft()` should initialize `tags: []`
- `taskToDraft(task)` should copy `task.tags ?? []`
- any draft merges/saves should preserve `tags`

This work is mechanically small, but it is required so `TaskEditorForm` remains controlled.

## Scheduled task blueprints

`TaskScheduleEditorForm.tsx` already reuses `TaskEditorForm` for the schedule’s task blueprint.

Recommendation:

- allow scheduled task blueprints to inherit the same tag field automatically once `TaskUpsertInput.tags` exists
- do **not** add schedule-specific tag semantics in ORC-19

This is the least surprising outcome because scheduled tasks materialize normal tasks from the same blueprint shape.

## Task detail read-only rendering plan

## Add a dedicated tags card to `TaskDetailPage.tsx`

In read-only mode, render tags prominently in the summary area **above the description card**.

Recommended placement:

- summary header/actions
- **tags card**
- description card
- existing todo warning / default file / comments / history cards

Recommended content:

- eyebrow: `Tags`
- heading: `Task tags`
- a chip list when tags exist
- a muted empty state when there are no tags

Recommended empty-state copy:

- `No tags`

Why a dedicated card is better than header metadata:

- tags need chip treatment, not count text
- the existing `taskHeaderMeta` row is optimized for counts and status-like metadata
- a dedicated card keeps tags visually prominent without bloating the compact/floating header

## Keep the floating header compact

Do **not** add the full tag list to the sticky compact header in `TaskDetailPage.tsx`.

Reasoning:

- the floating header already carries number/title/status/runtime state
- adding chips there would increase height and reduce scannability while scrolling
- the read-only summary card already satisfies the requirement to show tags outside edit mode

If desired, the compact header can remain unchanged in ORC-19.

## Detailed interaction semantics

## Canonical commit behavior

A tag is only committed when the user explicitly finishes a token.

Recommended commit triggers:

- `Enter`
- comma (`,`) when the input is non-empty
- blur
- paste of delimited content

Recommended normalization on commit:

1. trim outer whitespace
2. lowercase
3. drop blanks
4. collapse duplicates
5. validate the remaining candidate(s)
6. merge into the existing tag array
7. sort the resulting array lexicographically

Important UX rule:

- uppercase input should normalize to lowercase on commit rather than show an error

That aligns with the ORC-14 “normalization-on-commit” direction and avoids punishing harmless casing mistakes.

## Invalid-input behavior

Invalid input should be rejected **before** it becomes a chip.

Recommended inline error cases:

- spaces inside a tag
- punctuation other than `_` or `-`
- leading `_` or `-`
- trailing `_` or `-`
- length over 32 characters
- total tag count over 20

Recommended error messaging:

- syntax error: `Tags must use lower-case letters, numbers, - or _, and must start and end with a letter or number.`
- length error: `Tags must be 32 characters or fewer.`
- count error: `A task may not have more than 20 tags.`

Recommended error lifecycle:

- show the message immediately after a failed commit attempt
- clear it on the next successful commit or when the user changes the draft input

## Duplicate handling

Duplicate tags should collapse silently after normalization.

Examples:

- existing `backend`, committing `Backend` → no new chip, no error
- pasting `backend,backend,Backend` → one `backend` chip

Recommendation:

- duplicates are treated as harmless normalization, not as validation failures

That keeps the field low-friction and matches the backend plan.

## Paste handling

Pasting comma-separated or newline-separated content should support multi-chip creation.

Recommended delimiters:

- comma
- newline

Recommended paste semantics:

- parse the pasted text into a batch of candidate tags
- normalize/de-duplicate the batch together with the current value
- commit the batch only when every nonblank candidate is valid and the resulting total count stays within the 20-tag limit
- if any pasted candidate is invalid, reject the batch and show a single inline error instead of partially mutating the field

Why all-or-nothing batch commit is recommended:

- it keeps paste behavior deterministic
- it avoids surprise partial success when the user pasted what they assumed was one coherent list
- it is easier to reason about in tests

## Editing semantics for existing chips

Do **not** make individual chips contenteditable in v1.

Recommended v1 rule:

- tag-set editing happens by adding new tags and removing unwanted tags
- “rename” is therefore remove + re-add

Reasoning:

- it keeps focus and commit semantics simple
- it avoids half-edited chip states that still need normalization/validation
- it is fully compatible with the acceptance criteria, which care about adding, removing, and editing the tag set without guesswork

## Keyboard model

The keyboard behavior needs to be explicit because ORC-19 acceptance calls it out directly.

Recommended rules:

### Input focus and commit

- `Tab` enters the tag field in normal form order
- `Enter` commits the current input value
- comma commits the current input value without inserting a literal comma
- `Escape` clears the inline error if one is visible; if no error is visible, it leaves the current draft text alone

### Chip focus

- clicking a chip focuses it
- `Backspace` on an empty input moves focus to the last chip instead of deleting text from nowhere
- `ArrowLeft` from the start of an empty input also moves focus to the last chip
- while a chip is focused, `ArrowLeft` and `ArrowRight` move to the previous/next chip, with the input treated as the position after the last chip

### Removal

- `Delete` or `Backspace` on a focused chip removes that tag
- after removing a focused chip, focus should move to the previous chip when possible, otherwise to the next chip, otherwise back to the input
- each chip should also expose a visible remove button with an accessible label such as `Remove tag backend`

This gives both mouse and keyboard users a clear removal path.

## Accessibility and discoverability

Recommended accessibility details:

- the field should use a normal `<label>` and helper text
- the inline error should be associated to the input via `aria-describedby`
- invalid state should toggle `aria-invalid`
- focused chips need a visible focus ring
- remove controls need an explicit accessible name that includes the tag value

Recommended discoverability details:

- input placeholder such as `Add a tag and press Enter`
- helper copy that states the syntax/limit
- an empty-state line in detail view so the absence of tags is still visible

## File-by-file implementation plan

## New files

### `src/lib/taskTags.ts`

Add pure helpers for:

- candidate normalization
- syntax validation
- batch parsing for paste
- commit result shaping

This file should be easy to unit test.

### `src/components/TaskTagInput.tsx`

Add the reusable token-input component with local draft/error/focus management.

## Updated files

### `src/types.ts`

Consume the ORC-17 `tags: string[]` additions if they are not already present in the worktree when ORC-19 starts.

### `src/pages/TasksPage.tsx`

Update task draft initialization and task-detail-to-draft mapping so tags survive create/edit round-trips.

### `src/pages/tasks/TaskEditorForm.tsx`

Render the shared `TaskTagInput` and wire it to `draft.tags`.

### `src/pages/tasks/TaskCreatePage.tsx`

No bespoke tag logic should be needed here beyond the shared form changes.

### `src/pages/tasks/TaskScheduleEditorForm.tsx`

Expect tag support to appear automatically through the shared editor form.

### `src/pages/tasks/TaskDetailPage.tsx`

- render the read-only tags card in summary mode
- keep edit mode covered through `TaskEditorForm`
- leave the floating compact header unchanged

### `src/styles.css`

Add layout/focus/error styles for editable and read-only task tags.

## Suggested test hooks

To keep ORC-19 easy to automate, add stable data roles such as:

- `task-tags-field`
- `task-tags-input`
- `task-tag-chip`
- `task-tag-remove`
- `task-tags-error`
- `task-overview-tags`
- `task-tags-empty`

That gives both browser and desktop e2e coverage a stable surface.

## Test plan split for ORC-19

ORC-21 owns the broad hardening pass, but ORC-19 should still land targeted coverage for the new UX.

Recommended ORC-19 coverage:

## 1. Pure helper tests

Add focused unit coverage for `src/lib/taskTags.ts`, especially:

- lowercase normalization
- duplicate collapse
- invalid syntax rejection
- max-length enforcement
- max-count enforcement
- paste parsing and batch-commit semantics

## 2. Task UI e2e smoke coverage

Extend `tests/e2e/tasks.spec.ts` with the core user-visible flow:

- create a task with multiple tags
- confirm they render in detail read-only mode
- open edit mode and remove/add tags
- verify invalid input shows inline feedback and does not create a chip
- verify duplicate input collapses without creating duplicates

## 3. Keyboard-path coverage

Add at least one focused browser or desktop-e2e scenario that proves:

- `Enter` commits a tag
- `Backspace` on empty input focuses the last chip
- `Delete`/`Backspace` removes a focused chip

ORC-21 can then broaden the regression matrix once the feature exists.

## Final recommendation

Implement ORC-19 as a thin, reusable UX layer on top of ORC-14/ORC-17 semantics:

- add a dedicated `TaskTagInput` component
- back it with a small pure `taskTags` helper for UI-side normalization/validation
- wire it into `TaskEditorForm` so create, edit, and schedule-blueprint task editing all stay consistent
- add a dedicated read-only tags card to `TaskDetailPage` above the description
- keep duplicate collapse silent, normalization automatic, and invalid syntax inline
- make keyboard and paste behavior deterministic rather than implicit

That gives the developer lane an implementation-ready plan that fits the existing task architecture and should satisfy the ORC-19 acceptance criteria without reopening product semantics.