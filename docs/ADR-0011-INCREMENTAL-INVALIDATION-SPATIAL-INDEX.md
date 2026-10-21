# ADR-0011: Incremental invalidation, command availability and spatial indexes

## Status

Accepted.

## Problem

The first implementation correctly kept durable writes behind commands and transactions, but several read paths were still too broad. A single character edit advanced the document revision, causing canvas, connection, group, palette, statistics and AI views to reload or rescan unrelated data. Camera movement also linearly tested every node, connection and group. Optional UI controls could remain clickable briefly after their provider plugin stopped, and an active color-picker session was not explicitly settled during hot-stop.

Those behaviors preserved data correctness but violated the performance and lifecycle parts of the architecture contract.

## Decision

- `content.catalog@2` is the versioned incremental metadata feed. Consumers request changes since their last catalog version; a bounded change log falls back to a full reset when a consumer is too old. `content.catalog.invalidated` identifies whether geometry changed, so geometry-only consumers ignore body-only edits.
- `content.summariesById@1` and `content.metrics@1` provide bounded reads for known node IDs. `content.metrics@2` adds exact Unicode-aware per-node measures without changing the legacy length contract. Selection statistics and editor panes no longer fetch all summaries.
- View clients expose observable command availability. Optional controls derive enabled state from the currently admitted command provider and fail closed if a provider disappears between pointer-down and dispatch.
- Canvas nodes, connection bounds and group bounds use rebuildable uniform-grid spatial indexes. Camera changes query the index; node movement or resize rebuilds geometry state. Ephemeral drag/resize candidates are unioned with indexed results and then exact-tested.
- Editor document invalidation carries affected IDs and revisions. An editor ignores its own already-applied revision and reloads only stale panes. Writing metrics live in the separate workspace namespace `editorMetrics`, so recording activity does not invalidate editor layout.
- Text-color preview carries the exact selection or paragraph range and content revision. The preview is an ephemeral formatting mark; it never changes the document default or history.
- Stopping the palette settles any active picker session as `committed: false`, clears preview state and releases its modal surface before removal completes.
- DOCX decompression passes an owned `ArrayBuffer` to `Blob`, avoiding platform-dependent typed-array backing-buffer incompatibility.

## Compatibility and migration

The new capabilities and invalidation fields are additive. Existing `content.summaries@1` remains available for whole-catalog administrative operations. No document or portable-file schema changes are required.

Legacy editor metric keys under the `editor` workspace namespace are deleted by the existing non-history migration command. Metrics are runtime-session data and are intentionally not copied into `editorMetrics` across a restart.

## Verification

The contract suite verifies coalesced catalog deltas, observable command registration and hot-stop, exact spatial-index results over 2,000 entities, range-scoped color preview, palette-session cancellation, incremental statistics, plugin resource cleanup and the existing 2,000-node/20-million-character performance envelopes. Type checking and linting remain release gates.
