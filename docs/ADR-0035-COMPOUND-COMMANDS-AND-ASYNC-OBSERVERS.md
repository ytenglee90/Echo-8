# ADR-0035: Compound commands fail fast and committed observers are isolated

## Status

Accepted.

## Context

Echo-8 deliberately serializes formal commands so every durable operation crosses one transaction and one global history timeline. A handler that called `await dispatch(child)` while its parent still occupied that queue could wait forever: the child was behind the parent, while the parent was waiting for the child. Asynchronous handlers also need stable causation after their first `await`. Separately, awaiting every committed-event listener made one slow optional plugin capable of delaying the complete command queue.

## Decision

The router keeps ordinary `dispatch` as the public queued command boundary and rejects a nested dispatch from an executing parent immediately. Scoped plugin contexts add two declared, permission-checked paths:

- `commands.invoke` executes a true alias or bounded compound child inside the same serialized turn;
- `commands.defer` queues a follow-up after the current turn and returns `void`, so a handler cannot accidentally wait on it.

Both paths create a normal typed envelope, retain correlation and causation IDs, increment propagation depth, run command validation and permission checks, and commit any returned standard transaction through the same transaction manager. Maximum depth and pending-command limits still apply. Shared alias handlers return the same plan; they do not reach into another plugin implementation.

The plugin manager retains the active formal-command envelope until an asynchronous handler settles, so a child created after `await` keeps the correct lineage. The router tracks every executing command ID for the full asynchronous lifetime and diagnoses misuse rather than leaving a pending promise.

Committed events remain immutable facts. The router gives each receiving plugin its own ordered delivery tail and does not await those tails from transaction commit. One plugin therefore observes its events in order, but a slow or failed observer cannot block formal commands or another plugin. Listener removal and plugin admission are rechecked immediately before delivery.

## Consequences

- Shortcut aliases, compound editor actions and system actions cannot self-deadlock the command queue.
- Correlation and causation survive asynchronous command preparation.
- Optional indexes, statistics and autosave observers cannot hold interactive commands hostage.
- Event listeners must not be relied on as a synchronous second half of a transaction; required atomic work belongs in the original owner-labelled patch plan.
- Tests cover fail-fast nested dispatch, inline invocation lineage, deferred ordering, asynchronous causation, slow-listener isolation and per-plugin event order.
