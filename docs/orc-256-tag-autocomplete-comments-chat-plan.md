# ORC-256 — Tag autocomplete in comments and chat plan

## tl;dr
- Add `#` as another `AutocompleteTextarea` source and enable `allowEmptyQuery` so bare `#` immediately opens suggestions.
- Source suggestions from canonical project task tags already present on loaded task summaries; in task comment flows, boost the current task's tags to the top and always include them.
- Insert canonical `#tag` tokens only, reusing the existing autocomplete keyboard/selection model and trailing-space behavior.
- Wire the shared comment and chat composers so task comments/replies/file-comments plus session chat/supervisor chat all pick it up.
- Cover the helper logic with Vitest and representative comment/chat flows with Playwright.

## Executive summary
The current autocomplete model is already centralized in `src/components/AutocompleteTextarea.tsx`: it detects token triggers, debounces search, hides the menu on exact matches, and applies a canonical `insertText` plus trailing space. `#` tag autocomplete can piggyback on that model with minimal UI churn. The best suggestion source is the active project's existing task tags, derived from task summaries the app already loads for mentions/chat reference data, plus the current task's own tags for task comment surfaces. That keeps the feature project-scoped, deterministic, and free of new backend/API work while still giving comments and session/chat composers a useful tag vocabulary.

## Current-state findings
- `src/components/AutocompleteTextarea.tsx` already supports multiple trigger sources, per-source `allowEmptyQuery`, exact-match suppression, arrow navigation, Enter/Tab accept, Escape dismiss, and click accept.
- `src/components/TaskCommentMentionsTextarea.tsx` currently wires `@` (project tasks/agents/roles) and `$` (task file references). It is reused by `TaskCommentComposer`, which is used for task comments, replies, and repo-file comment flows.
- `src/components/SessionChatPanel.tsx` and `src/components/SupervisorQuickChatModal.tsx` each wire `AutocompleteTextarea` directly with an `@` source.
- `src/lib/orchestraData/appShell.ts` already fetches non-archived project task summaries with `tags` through `useProjectReferenceData(...)`, so chat/session surfaces already have a project-scoped tag corpus in memory.
- Task tag canonicalization already exists in `src/lib/taskTags.ts` (`normalizeTaskTags`, lower-case syntax rules), so inserted tags can use stored/display form without inventing new normalization rules.

## Recommended product semantics

### Scope
- Comments: top-level task comments, inline replies, and repo-file comment/reply composers via shared `TaskCommentMentionsTextarea`.
- Chat/session inputs: `SessionChatPanel` composers (Chat page + Sessions page) and `SupervisorQuickChatModal`.

### Trigger + interaction
- `#` should open autocomplete when it starts a token under the existing `AutocompleteTextarea` boundary rules (same trigger parsing model as `@`/`$`).
- Set `allowEmptyQuery: true` for `#`, so typing bare `#` immediately shows suggestions.
- Keep existing keyboard behavior: Arrow Up/Down navigate, Enter/Tab accept, Escape dismiss, click accepts.
- Typing a boundary character, especially a space after `#`, should dismiss the menu. That preserves markdown heading input without adding special-case parser logic.

### Suggestion source
- Base source: union of canonical tags from non-archived task summaries already loaded for the active project/surface.
- Task comment boost: prepend the current task's canonical tags, even if they are not present in the broader project list or the task is archived/off-list.
- Deduplicate after normalization; do not add recently-used state or a new backend tag endpoint in this slice.
- Empty-query order:
  1. current task tags (task comment surfaces only),
  2. remaining project tags in deterministic alphabetical order.

This keeps empty-query results predictable and aligns with existing canonical tag sorting elsewhere in the product.

### Matching + insertion
- Search over canonical tag tokens using the existing fuzzy matcher.
- Candidate insert text should always be `#${canonicalTag}`.
- Display should also use the canonical form (`#backend`, not the user's mixed-case draft).
- Applying a suggestion should keep the existing trailing-space behavior from `AutocompleteTextarea`.

### No-match / duplicate behavior
- No matches => no dropdown.
- If the active token already exactly equals a canonical inserted tag (for example `#backend`), hide the dropdown using the existing exact-match suppression path.
- Do not suppress a tag just because it already appears elsewhere in the draft or on the task; comments/chat references are plain text, so repeated references stay user-controlled.

## Recommended implementation
1. **Add a shared tag-candidate helper**
   - Extend `src/lib/referenceMentions.ts` (or add a small adjacent helper if keeping tags separate feels cleaner) with a function that:
     - accepts `TaskSummary[]` plus optional prioritized/current-task tags,
     - normalizes/deduplicates via `normalizeTaskTags`,
     - returns `ComposerAutocompleteCandidate[]` searchable via `fuzzySearch`.
2. **Wire task comment surfaces once**
   - In `src/components/TaskCommentMentionsTextarea.tsx`, add a `#` source beside existing `@` and `$`.
   - Accept optional `currentTaskTags` / `prioritizedTags` from `TaskCommentComposer`, sourced from the active task.
   - Because `TaskCommentComposer` is reused, this single change should cover task comments, replies, and repo-file comment composers.
3. **Wire session/chat surfaces**
   - In `src/components/SessionChatPanel.tsx` and `src/components/SupervisorQuickChatModal.tsx`, add the `#` source beside the existing `@` source using the already-loaded `referenceTasks`.
   - No new fetches should be necessary.
4. **Keep scope narrow**
   - Do not change rendered markdown mention resolution in `src/components/MarkdownContent.tsx` for this task; inserted hashtags can remain plain text references.
   - Do not add create-new-tag flows, recent-tag persistence, or cross-project/global tag search.

## Regression coverage

### Unit
Update `tests/referenceMentions.test.ts` (or add a sibling focused tag-autocomplete test) to cover:
- canonicalization/deduping from mixed task tag inputs,
- current-task tag prioritization,
- fuzzy partial matching,
- empty-query ordering.

### E2E
- `tests/e2e/tasks.spec.ts`
  - Add or extend a task comment autocomplete case to verify:
    - bare `#` shows suggestions,
    - partial query filters (`#bac` → `#backend`),
    - selecting inserts canonical `#tag `,
    - exact token suppresses the list,
    - no-match input hides the list.
- `tests/e2e/chat.spec.ts`
  - Add or extend a session composer case with the same representative assertions.
- If quick-chat coverage is wanted explicitly, add a small `supervisor-composer-input` assertion in `tests/e2e/sessions.spec.ts`; it should be cheap because it uses the same new source shape.

## Validation
- `npm run build`
- `npx vitest run tests/referenceMentions.test.ts`
- `npm run test:e2e -- tests/e2e/tasks.spec.ts tests/e2e/chat.spec.ts`
- If quick-chat coverage is added, include `tests/e2e/sessions.spec.ts` in the targeted run.

## Non-goals
- clickable/rendered hashtag links in comments or transcripts
- new backend/API endpoints for project tags
- recent-tag persistence or MRU ranking
- mutating task metadata from comment/chat hashtag usage
