# ADR-0015: Batched retrieval and user-governed memory center

## Status

Accepted for the AI assistant slice.

## Problem

A fixed top-ten memory cutoff can miss a lower-ranked source that covers an otherwise unanswered part of a compound question. Increasing the number to fifty without reporting coverage merely hides the cutoff. The canvas hub node also cannot by itself show stale indexes, conflicts, paused memories or applicability scopes. Finally, natural-language decisions must not become formal memory through an automatic guess.

## Decision

Local memory-index matching runs in deterministic batches of ten. After each batch it measures which query branches have at least one index match. Ordinary requests stop after all branches are covered; requests containing an explicit exhaustive intent continue through the bounded candidate pool of at most fifty. Original ranges are admitted through a weighted shared context budget rather than an equal per-memory split. Explicitly modified or confirmed facts and memories covering an uncovered query branch are considered before weak candidates; recency breaks ties instead of deleting older authoritative material. The prepared context records batch count, matched candidates, index branch coverage, complete-evidence branch coverage, skipped oversized structures, stale recoveries, evidence-memory count and deferred candidates. The panel shows this report before transmission, and the runtime model protocol forbids claiming complete coverage when candidates were deferred.

The AI assistant panel has three workspace-only views: chat, memory center and the user guide. The memory center reads `ai.memoryCatalog`, a derived public query that checks every stored relation against generic content summaries. It shows ready, paused and attention counts, unresolved explicit conflicts, keywords, creation time, applicability scope and whether a memory was used in the current preparation.

`ai.memory.setEnabled` and `ai.memory.setScope` are durable, undoable broadcasts owned by the assistant. Optional `enabled`, `scope` and `updatedAt` fields keep older records compatible. Paused memories never enter candidate matching. A matching scope boosts an index but cannot bypass evidence or revision checks.

`ai.memory.rebuild` schedules a cancellable range-based indexing task. Content-change events also schedule the same core-owned task after a short debounce; rapid typing cancels and replaces only the pending task for that source. `ai.memory.rebuild.commit` revalidates the original revision, asks the content owner to replace or recreate the readable index, recreates a missing hub when necessary, asks the optional connection owner for semantic relations and commits the rebuilt machine index once. No whole long document is joined, no feature-local timer owns the lifecycle, and stale formal claims remain inactive until the commit succeeds.

The composer performs conservative local detection for explicit phrases such as confirmation, old-to-new changes and deprecation. A detection is ephemeral and only proposes a standard directive. The user must press the confirmation button before it is inserted into the message; it becomes durable memory evidence only after the resulting exact conversation is saved. Free-form discussion and assistant output never receive formal status automatically.

## Compatibility and history

- Existing memory records default to enabled and an empty applicability scope.
- View selection is personal workspace state and never enters document history.
- Pause, resume, scope changes and rebuilds enter the global linear document history.
- The project-container format does not change because all new document fields are optional plugin-owned values.
- Stopping the assistant cancels both save-index and rebuild-index tasks and releases the panel and signals.

## Verification

Contract tests cover more than ten matching saved memories, multiple index batches, exhaustive intent, visible retrieval reports, scope preference, pause exclusion, undo, stale-source detection, background rebuild, memory catalog status and workspace-only view switching.
