# ADR-0040: Compacted editing history and reference-based checkpoints

## Problem

Text bodies are immutable 64 KiB chunks, but a continuous typing session previously appended every intermediate chunk patch to one merged history entry. The same adjacent edit records accumulated in the pending recovery journal. A checkpoint then cloned active and historical chunk values, scrubbed the complete clone by cloning it again, and transferred the full values through the worker boundary before externalizing them.

The document result and undo count were correct, but long sessions could retain obsolete chunk generations and create avoidable checkpoint allocation peaks.

## Decision

The core composes adjacent records only when their explicit `mergeKey` and merge window already permit history merging. For every store target, the composed transition retains the state before the first edit as inverse and the state after the last edit as forward. A record created and deleted entirely inside the merged session is removed from both directions. Different sessions, history actions, targets and transactions remain distinct.

The same pure composition rule is used by global history and by pending recovery-journal records before IndexedDB admission. Undo, redo and crash replay still consume standard owner-labelled patches; no plugin function is retained in history.

Checkpoint snapshots are already private copies, so retired-field migration scrubs them in place instead of cloning the entire application again. Immutable `textContentChunk` values may be reference-captured only by the mandatory persistence path. They are externalized on the main thread through bounded structural traversal before worker messaging, and only the small structural checkpoint crosses the worker boundary. IndexedDB remains the durable clone boundary for chunk values.

Ordinary public store/history exports keep their original deep-copy semantics. The reference-preserving option is not exposed to plugins and must only be used for a namespace whose records are immutable after store admission and immediately externalized.

## Rejected alternatives

- Disabling typing merge would increase undo noise and journal rows.
- Keeping every intermediate chunk because local checkpoints deduplicate by ID would still retain obsolete values in live history and pending journal memory.
- Passing the full text snapshot into and back out of a Worker moves traversal but duplicates the largest payload during structured-clone transfer.
- Returning internal references from all snapshot APIs would let consumers mutate authoritative state outside the transaction boundary.

## Compatibility

There is no command, plugin, project-file or history schema change. Existing snapshots and journals replay normally. Only newly merged live entries become smaller.

## Verification

- Patch-composition tests cover initial/final state preservation, different-session isolation and a 500-edit 64 KiB typing sequence.
- Checkpoint tests cover externalization/hydration, partial-result rejection, public clone semantics, explicit immutable reference capture and in-place retired-field scrubbing.
- The complete type, lint, contract, browser and portable-build gates remain required.
