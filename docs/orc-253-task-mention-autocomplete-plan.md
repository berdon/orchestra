# ORC-253 — task mention autocomplete fix plan

## tl;dr

- The bug is in shared client-side mention search, not backend task visibility.
- Task autocomplete currently indexes task **number** and **raw title**, but not the task's slugified title form.
- Hyphenated slug queries like `@fix-task-slug-autocomplete` fail because fuzzy matching compares them against space-separated title text.
- Both comments and chat also hard-cap results to `12`, so valid task matches can be clipped even when they do match.
- Fix the shared search helper in `src/lib/referenceMentions.ts`, keep canonical task insertion as `@TASK-NUMBER`, add project mention candidates for project-prefix/slug queries, and add regression coverage for comments + chat.

## Executive summary

The comments composer, session chat composer, and supervisor quick chat all use the same `@` mention search helper:

- `src/components/TaskCommentMentionsTextarea.tsx`
- `src/components/SessionChatPanel.tsx`
- `src/components/SupervisorQuickChatModal.tsx`
- shared logic in `src/lib/referenceMentions.ts`

Today that helper builds task candidates with:

- label: `TASK-NUMBER title`
- insert text: `@TASK-NUMBER`
- keywords: task number, title, status, priority, type

That means two separate failure modes exist:

1. **Slug queries are not indexed correctly.**
   - Task slugs are derived from titles by lowercasing and collapsing non-alphanumerics to `-`.
   - The autocomplete search never indexes that slug form.
   - Example: `fix-task-slug-autocomplete` will not match `Fix task slug autocomplete`, because the fuzzy matcher requires the `-` characters to exist in the searched text.

2. **Task matches are globally capped to 12 items.**
   - Even when a query matches valid tasks, results are truncated before all matching tasks can be shown.
   - This especially affects broad slug/identifier prefixes and makes comments/chat appear inconsistent when the ordering changes.

## Intended matching semantics

Task mention autocomplete should use these rules:

1. **Canonical inserted mention format stays stable:** selecting a task inserts `@TASK-NUMBER`.
   - This preserves stable rendered links and avoids title-rename drift.
2. **Search aliases for tasks should include:**
   - full task number, e.g. `ORC-253`
   - task number suffix where helpful, e.g. `253`
   - slugified title, e.g. `fix-task-slug-autocomplete-not-showing-all-matching-task-options-in-comments-and-chat`
   - raw title text for human discovery
3. **Project suggestions should be available for project-style `@` queries.**
   - Project matches should surface alongside task matches for non-hyphenated project-prefix/slug queries such as `@orc`.
   - Once the query becomes task-shaped (for example `@orc-`), project items should drop out so the menu focuses on task identifiers/slugs.
   - Project mentions may resolve from both canonical project slug text and the project task-prefix alias.
4. **Ranking should prefer precise project/task lookup before fuzzy discovery.**
   - exact project prefix / exact project slug
   - exact task number / exact slug
   - prefix project match
   - prefix number / prefix slug
   - title word / title substring
   - fuzzy title/name fallback
   - then agent / role matches
5. **Task suggestions should be numerically sorted by task number.**
   - Within the same ranking bucket, `ORC-2` should appear before `ORC-10`.
6. **Result capping should not hide precise task matches.**
   - Exact and prefix task-number/task-slug matches should all be surfaced.
   - If a cap remains for usability, it should only apply to the fuzzy fallback tail, not the precise task buckets.

## Proposed implementation

1. **Refactor task search in `src/lib/referenceMentions.ts`.**
   - Add a shared task-title-to-slug normalizer that mirrors backend task slug semantics.
   - Build explicit task search metadata instead of relying only on generic fuzzy keywords.
   - Bucket and de-duplicate task matches before appending agent/role results.

2. **Keep renderer/linking behavior canonical.**
   - Continue inserting `@TASK-NUMBER` from autocomplete.
   - Do not make slug text the canonical stored mention form.

3. **Reuse the shared helper in all `@` mention surfaces.**
   - Task comments
   - session/chat composer
   - supervisor quick chat

## Regression coverage

Add or update:

- `tests/referenceMentions.test.ts`
  - project-prefix query includes project + task matches, while hyphenated task-style queries suppress project items
  - slug exact match
  - slug prefix match
  - number exact/prefix match with numeric ordering
  - >12 matching tasks still surface all precise task matches
  - stable task insertion remains `@TASK-NUMBER`
- `tests/e2e/tasks.spec.ts`
  - task comment composer: slug query shows all expected task matches and inserts `@TASK-NUMBER`
- `tests/e2e/chat.spec.ts`
  - chat composer: same slug/identifier behavior as comments

## Notes for implementation

- No backend/API expansion should be required for the fix itself; the active project task list is already loaded client-side.
- The likely root cause is therefore **frontend search semantics plus UI result capping**, not task visibility scope.
- If implementation uncovers stale reference-data refresh issues, address them separately, but they do not appear to be the primary failure from current code inspection.
