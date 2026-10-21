# ADR-0020: Streaming AI generation and prompt policy

## Status

Accepted.

## Problem

Waiting for one complete JSON response hides useful progress during a long generation and gives the user no timely way to stop it. Keeping every system instruction inside the assistant bundle also makes role or domain adaptation require editing the feature implementation. At the same time, arbitrary prompt replacement must not be allowed to remove the product's evidence, memory, privacy and proposal-review rules.

## Decision

The model-provider plugin exposes `ai.generate.stream@1`. Its OpenAI-compatible implementation requests SSE, parses delta and usage events incrementally, accepts NDJSON and ordinary JSON responses as compatibility fallbacks, and binds the response reader to the core task cancellation signal. The non-streaming `ai.generate@1` capability remains available for older providers. The assistant prefers streaming and falls back only when the streaming capability is absent; it never retries a failed in-progress stream through a second provider request.

Provider responses are untrusted input. The transport rejects a declared or observed body above 8 MiB, an unbroken SSE line above 1 MiB, or one combined SSE event above 2 MiB. Ordinary JSON is byte-limited before parsing instead of calling `response.json()` on an unbounded body. Abort, overflow and parse failure cancel and release the response reader.

Each delta is an ephemeral `ai.generation.delta` signal. Deltas update the visible chat response but never enter document state, history, recovery or autosave. Only a successfully completed, non-empty result is committed through the existing `ai.generation.record` command as an assistant transcript turn and a reviewable proposal. `ai.generation.cancel` cancels the core-owned task and discards the incomplete assistant output. The already-submitted user turn remains exact conversation history.

The latest send exposes one bounded runtime-only follow-up action. A failed preparation or generation shows a retry icon; a completed answer changes the same control to a generate-again icon. Visible tooltips and accessible names remain **重试** and **再来一次**. Both enter through the typed `ai.generation.retry` command and expire after 24 hours. Preparation failure defers the original bounded preparation request because no user turn was committed yet. Generation failure reuses the still-valid prepared prompt and evidence instead of appending the question again. After a completed answer, **再来一次** keeps the earlier answer and generates an alternative from that same frozen prompt/evidence envelope. Retry and repeat clicks are recorded as short verbatim user control turns so the append-only transcript stays role-ordered and auditable. Current transcript and non-conversation source revisions are revalidated before the task starts; stale or missing work fails visibly rather than silently reconstructing a different request. The one narrow exception is the current session's own automatically maintained conversation-memory mirror: if only its revision advanced and a bounded reread proves the exact prepared evidence range remains byte-for-byte unchanged, retry rebases that source metadata to the current revision. Any changed evidence text still fails closed. No path retries automatically or loops indefinitely.

The assistant view queues ordered answer/reasoning deltas and commits their ephemeral projection at most once per animation frame, with a timer fallback when `requestAnimationFrame` is unavailable. One frame joins each channel once, rejects stale sequence numbers and drops pending work on completion, cancellation or unmount. The streaming card currently renders escaped plain text rather than reparsing Markdown, so an incremental Markdown parser would add complexity without removing an existing parse cost; rich Markdown, if introduced later, requires a separate bounded-block parsing decision.

The assistant owns a workspace-only prompt-template catalog. User actions create, activate and remove templates through declared commands; templates do not enter canvas history or portable project files. A template can add a system instruction and a task prefix with a small documented variable set. It cannot replace the product memory protocol, evidence rules, privacy disclosure or proposal workflow.

OpenAI-compatible response normalization accepts both string content and provider-style content-part arrays. Explicit reasoning remains a separate UI channel when a normal answer exists. If a provider returns no answer field and reasoning is the only non-empty textual result, that text is promoted to the visible answer rather than reporting a false empty-response failure.

Independent plugins may contribute bounded instructions and generation settings through the optional `ai.promptPolicy@1` capability. The assistant combines contributions deterministically by priority and provider identity. It depends on the capability contract, not a plugin implementation. Invalid, excessive or out-of-range contributions are ignored or clamped at the assistant boundary.

## Consequences

- Long responses become visible immediately and can be stopped without persisting a misleading partial answer.
- Failed sends can be retried once per click, and successful answers can be generated again without duplicating the original question or deleting the earlier answer.
- Token-heavy responses no longer schedule one React state update and growing-string concatenation for every provider delta.
- Provider compatibility remains explicit; no UI code parses network formats.
- Users and future card-type plugins can adapt instructions without changing the assistant implementation.
- Product-side safety and provenance rules remain invariant across user templates and model platforms.
- Workspace templates stay local to the browser profile. Sharing a canvas intentionally does not share personal prompt configuration.

## Verification

Contract tests parse chunked SSE, verify ordered delta broadcasts and final persistence, coalesce large answer/reasoning batches without losing order, reject stale/foreign-session deltas, cancel an in-progress stream and assert that partial assistant text is absent, retry a failed generation, repeat a successful answer without duplicating the original question, verify prompt-template hot restart persistence, and assert that product rules plus expanded template variables reach the provider request.
