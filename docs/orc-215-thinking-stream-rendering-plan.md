# ORC-215 plan — fix session thinking-text update rendering

## tl;dr
The likely bug is the live thinking preview renderer, not the stored thinking text itself. We currently push a rapidly mutating multiline string through a WebKit-only line-clamp pattern (`display: -webkit-box` + `-webkit-line-clamp` + `white-space: pre-wrap`), which is a strong candidate for the garbled/stacked repaint seen in the macOS desktop app. Replace that with a deterministic JS-built preview string and cover it with helper + session-stream regression tests.

## Executive summary
`src/lib/sessionTranscriptReducer.ts` already keeps `thinkingText` separate from visible answer text, and existing reducer coverage reflects that. The fragile part is the preview UI in `src/components/TranscriptEventCard.tsx` and `.transcript-event__thinking-preview` in `src/styles.css`, where a live-updating multiline node is visually clamped by WebKit. In Tauri’s macOS WKWebView, that is the most plausible source of the stacked/gobbledygook text.

The safest implementation is to stop line-clamping the raw live node. Instead, compute the preview text in JS (same last-three-line behavior, explicit ellipsis when truncated), render only that stable string, and keep the full `thinkingText` in state for transcript correctness.

## Reproduction
1. Open a session that streams assistant thinking updates.
2. Send multiple quick `thinking_delta` updates that grow across several lines.
3. Observe the live thinking preview block while it is still streaming.
4. Current web coverage only checks text content and the presence of `-webkit-line-clamp`, so it can miss a WebKit repaint bug where the text content is logically correct but visually stacked.

## Root cause hypothesis
- The preview node is a rapidly mutating multiline text block.
- It is styled with:
  - `white-space: pre-wrap`
  - `display: -webkit-box`
  - `-webkit-box-orient: vertical`
  - `-webkit-line-clamp: 3`
- That makes browser layout/paint responsible for truncating live-updating content, which is brittle in macOS WKWebView.

## Implementation plan
1. Extend `src/lib/sessionTranscript.ts` with a small helper for thinking preview truncation (or reuse `buildCollapsedPreview` directly if the behavior matches exactly).
2. Update `src/components/TranscriptEventCard.tsx` to render the computed preview string instead of the full `thinkingText` with CSS line clamping.
3. Simplify `.transcript-event__thinking-preview` in `src/styles.css` to plain overflow-safe text styling; remove WebKit line-clamp behavior from the live thinking preview.
4. Preserve the full `thinkingText` in reducer/session state so final transcript fidelity does not change.

## Regression coverage
- Add/extend unit coverage in `tests/session-transcript.test.ts` for multiline thinking preview truncation.
- Update the thinking-stream scenario in `tests/e2e/sessions.spec.ts` to assert the exact preview text after successive `thinking_delta` updates, instead of only asserting that line-clamp CSS is present.
- If the desktop suite is practical here, add a focused desktop regression for rapid thinking updates in the session preview.

## Secondary sanity check
If the preview’s DOM text itself turns out to be duplicated rather than only visually garbled, the next place to inspect is `handleSessionStreamEvent` in `src/App.tsx`, which currently computes a full reduced session from ref state before `setSessions`. That can miss latest in-flight stream state under bursty updates. But the first implementation pass should target the preview renderer, since the task symptom is specifically stacked thinking text.

## Likely files
- `src/lib/sessionTranscript.ts`
- `src/components/TranscriptEventCard.tsx`
- `src/styles.css`
- `tests/session-transcript.test.ts`
- `tests/e2e/sessions.spec.ts`
