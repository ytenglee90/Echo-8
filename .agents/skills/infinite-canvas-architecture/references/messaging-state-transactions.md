# Messaging, State, and Transactions

## Separate message classes

Do not blur these contracts:

- **Command:** asks the system to perform a durable or controlled operation; returns success or a typed failure.
- **Event:** reports a fact after commit; listeners cannot veto or mutate that fact.
- **Query:** reads without side effects.
- **Ephemeral signal:** communicates high-frequency interaction preview or UI-only state.
- **Task message:** starts, reports, pauses, cancels, retries, or completes background work.

All messages use a standard envelope:

```javascript
{
  id, type, schemaVersion, sourcePlugin,
  transactionId, causationId, correlationId,
  timestamp, priority, payload
}
```

Validate payload schemas and permissions at the router. Keep a causation chain for diagnostics and loop detection.

## Ordering and reentrancy

- Serialize durable commands through the command coordinator unless a documented disjoint transaction policy proves they cannot conflict.
- Never call and await ordinary queued `dispatch` from the command that currently owns the serial queue. It must fail fast. Use explicit inline `invoke` for a true alias/compound child, or non-awaitable `defer` for a follow-up after the current turn.
- Queue commands dispatched from event handling for the next dispatch turn. Do not recursively write during event publication. Committed observers are ordered per plugin and isolated from other plugins; they are not a synchronous second transaction phase.
- Give commands idempotency keys where retries are possible.
- Set propagation-depth and per-turn work limits. Detect cycles and quarantine the offending handler rather than freezing the UI.
- Coalesce only message types whose contract explicitly permits it, such as pointer preview or latest viewport state. Never coalesce distinct durable edits merely because they are close in time.
- Deliver committed events in deterministic order. Slow, noncritical consumers receive queued work and cannot block input.
- Preserve `correlationId`, `causationId`, and depth across `await` in formal handlers. Add a timeout regression for every alias/shortcut path that previously nested commands.

## Single write boundary

UI components, event listeners, query handlers, task workers, and canvas render objects never mutate durable state. Registered command handlers produce validated operations; registered reducers or patch appliers perform the write inside a core transaction.

A durable transaction records:

```text
transaction ID and label
source command and causation
precondition revisions
affected namespaces and entity IDs
forward standard patches
inverse standard patches
schema owner and schema version
merge policy
derived-cache invalidations
result events
```

Apply all or none. Publish result events only after commit. A plugin-specific function call is not sufficient history because the plugin may later be disabled.

## Undo and redo

- Maintain one global linear history across plugins.
- Treat group movement, global replace, AI accepted insertion, and delete-with-connections as single user transactions even when many entities change.
- Merge continuous typing according to an explicit editing-session policy; split on pause, focus change, selection discontinuity, formatting boundary, or explicit command.
- Store text deltas and structural marks, not full document copies.
- Create periodic checkpoints, move cold history to durable storage, and compact according to a declared space policy while retaining at least the required 1,000 meaningful levels when storage permits.
- Persist enough journal and checkpoint data for restart recovery and deterministic replay.
- Undo/redo changes durable state through the same write boundary and emits normal committed events.

## High-frequency interaction

Use an ephemeral interaction session:

```text
begin -> preview signals -> commit one command
                     \-> cancel and discard previews
```

Apply this to node dragging, group movement, lasso, connector creation, resize, zoom detail changes, editor-dock resizing, and color scrubbing. Begin/end may be routed messages but only the final durable change enters document history. Personal layout changes save separately after interaction end.

## Concurrent views and stale work

- Multiple editor panes share one authoritative document buffer; they are views, not copies.
- Every search result, statistic, preview, AI context item, AI proposal, and background edit carries the source revision.
- Reject or rebase stale mutations explicitly. Never let an older result silently overwrite newer text.
- AI output is a proposal until accepted unless the user explicitly enabled a trusted automatic action. Acceptance is one undoable transaction.
- The conflict arbiter resolves capability providers, shortcut collisions, side-panel ownership, active editing sessions, close-versus-save, replace-versus-index, and task resource contention using deterministic policies.

## Examples

**Drag:** pointer movement publishes coalesced position previews; release dispatches `node.move`; the transaction updates stable positions once; connections and group bounds react to the committed event.

**Global replace:** search returns revision-tagged matches; the command revalidates all revisions; one atomic multi-node transaction applies exact deltas; index updates start only after commit.

**Typing:** composition and keystrokes update the authoritative editing buffer through the editor's controlled session; durable deltas are grouped without treating each pointer or composition update as a separate history step.
