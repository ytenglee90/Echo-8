# ADR-0028: Search navigation must not await a nested queued command

## Status

Accepted.

## Context

The command router deliberately serializes formal commands. A command handler that dispatches and awaits another formal command creates a cycle: the nested command waits behind the current command, while the current command waits for the nested command. Search previous/next used this pattern for `editor.revealRange`, so navigation never selected text and every later replace command remained queued.

## Decision

`search.previous` and `search.next` synchronously resolve and reserve the next hit for the active editor, then return from the formal command. They schedule a plugin-owned governed continuation with a one millisecond delay. After the original command has left the serialized queue, the continuation broadcasts `editor.revealRange`, then emits the derived navigation/status signals.

The continuation verifies that the source search request is still current before and after revealing. Plugin stop cancels the task through normal resource ownership. Navigation remains workspace-only derived state and never enters document history.

Search navigation was originally constrained to hits belonging to the active open editor. ADR-0083 replaces that range rule with a selected-text-node snapshot or, when no text node is selected, the full canvas result. The delayed continuation and no-nested-await rule in this ADR remain mandatory.

## Consequences

- User operations still travel through public commands and signals.
- The global command queue cannot be deadlocked by search navigation.
- Replacement can observe the editor's programmatic selection and execute normally.
- Rapid navigation clicks reserve distinct indices in command order.
- Contract tests impose a completion deadline so this deadlock cannot return silently.
