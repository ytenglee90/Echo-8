# ADR-0024: Independent AI assistant windows and session-scoped tasks

## Status

Accepted.

## Problem

One global assistant window and one global preparation/generation task cannot support a second visible assistant safely. Copying the panel alone would make both windows share the active conversation, status, stream deltas, cancellation and autosave handle. A request from one window could therefore cancel or visually contaminate the other. Model providers do not manage application windows or conversation ownership on the application's behalf.

## Decision

The assistant plugin stores an array of open assistant-window records in its personal workspace namespace. Each record owns a stable assistant ID, one durable conversation session ID, panel rectangle, composer height and current assistant view. Closing a window removes only its workspace record; it does not delete that conversation or its saved memory nodes.

`ai.assistant.openNew` creates a new durable session. The committed `ai.session.initialized` event then dispatches `ai.assistant.attach`, which adds the personal window record in a separate workspace transaction. This preserves the core rule that document and personal-workspace patches never share one transaction. All window actions continue to enter through typed commands or ephemeral signals.

Preparation, generation, memory-save and delayed-autosave handles are keyed by session instead of being plugin-wide singletons. Status, prepared-context and streaming-delta messages carry a session identity, and each panel ignores messages for other sessions. Canvas reference drop owners and composer-preview signals also carry the assistant identity. Context preparation carries both assistant and session identity and resolves the committed per-assistant memory allow-list at execution time. The core task scheduler remains the sole concurrency arbiter: its current four-lane, cost-16 budget lets two generation-cost-4 tasks coexist with one checkpoint-cost-8 task, while additional work remains priority/cost queued. A provider may impose stricter server-side limits, but it cannot merge application conversations.

Legacy single-window workspace keys remain as a compatibility projection of the first open assistant. Reopening after all windows close restores the last primary layout and conversation without creating another session. New code uses the assistant array.

## Consequences

- Several assistants can stay visible and continue independent conversations without cancelling or displaying one another's stream.
- Window layout remains personal workspace state and never enters canvas undo or portable document state.
- Empty technical session creation remains outside meaningful history, while transcript turns and accepted proposals retain their existing durable semantics.
- The application, not the model, owns parallelism, cancellation, queuing and message routing.

## Verification

Contract tests open two assistants, verify separate sessions and window layout, close one without deleting either conversation, run two streamed generations, and assert that each session receives only its own delta and proposal. The complete contract suite also verifies hot-stop cleanup, persistence, cancellation, history and capability boundaries.
