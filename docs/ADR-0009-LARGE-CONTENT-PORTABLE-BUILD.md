# ADR-0009: Independent text chunks, windowed editing and portable HTML

## Status

Accepted for the large-content and single-file delivery slice.

## Problem

A text node may contain twenty million UTF-16 characters while the same canvas may contain more than two thousand ordinary nodes. Keeping an array of chunks inside one store record still makes every store read and patch clone the entire document. Mounting a multi-million-character value in one textarea has the same failure mode in the DOM. A portable one-file delivery must not turn the development source into one monolithic file or create a second application architecture.

## Decision

Text content storage version 2 separates metadata from physical chunks.

- `textContent` owns one small metadata record with ordered chunk IDs, lengths, total length and revision.
- `textContentChunk` owns one record per chunk. The target chunk size is 64 Ki UTF-16 code units.
- `content.read@1` returns bounded ranges and never requires a caller to read the physical namespace.
- `content.storageInfo@1` exposes safe diagnostics about length and chunking without exposing stored text.
- A local delta replaces only the intersecting chunk records plus metadata. Its global-history entry therefore remains proportional to the edit, not to the document.
- Legacy inline chunk arrays are upgraded by `content.migrateStorage`, a normal broadcast command with a standard non-history transaction. Startup and document replacement request that command; plugins never mutate hydration data directly.

The editor mounts at most 256 Ki UTF-16 code units for a document above the ordinary editor threshold. Window changes use the `editor.setWindow` command and persist only personal workspace position. Text deltas include the window's global base offset and the source content revision, so edits remain precise and stale panes are rejected.

Complete store and history snapshots first capture immutable record and patch references synchronously, then clone them incrementally in short slices. This provides a stable point-in-time view without holding the render thread for one whole-canvas clone. Automatic checkpoints are low-priority tasks in the unified scheduler. IndexedDB journal writes and checkpoint writes share one serial I/O queue, so a transaction arriving after snapshot capture can only be written after the checkpoint has cleared older journal records.

Development remains split across `core`, `protocols`, `plugins`, `shell`, workers and tests. The portable build has a separate client entry but imports the same application composition. Vite produces a temporary client build; the build script inlines its emitted CSS and module JavaScript, verifies that no build-asset reference remains, and writes `artifacts/Echo-8.html`. Large editable language data is deliberately not embedded in the HTML: the same build emits `artifacts/Echo-8-text-assist-rules.txt` as a companion file. HTTP builds may read that public asset automatically. Under `file://`, the core-owned `assets.readText@1` capability refuses the forbidden sibling fetch before network access, and the owning plugin exposes an explicit browser-file association control. The canvas remains usable before association, while correction suggestions wait for the external TXT. The build does not concatenate or duplicate feature source by hand.

## Limits

- A text node currently accepts at most 32 Mi UTF-16 code units, covering the stated twenty-million-character target with headroom.
- The two-thousand-node and twenty-million-character scenarios are separate performance envelopes. Two thousand nodes each containing twenty million characters would require tens of billions of characters and is outside a browser's practical memory budget.
- Search, statistics, export and AI context must continue to consume bounded ranges or independent chunks. A new feature that joins every node body is an architecture violation.
- The portable HTML runs locally without external script, style or font assets and never attempts same-directory `fetch`. Text correction data is an intentional companion TXT selected by the user; network-backed AI still requires a reachable endpoint and explicit user authorization.

## Alternatives rejected

- Storing all chunks in one metadata object preserves the original whole-document clone cost.
- Putting a twenty-million-character string in one textarea transfers storage scalability into DOM and selection instability.
- Letting the editor address only local window offsets risks applying an edit to the wrong part of the document.
- Running checkpoints outside the task manager hides resource contention and allows persistence work to compete silently with search or AI.
- Clearing the journal without serializing persistence I/O can delete a transaction newer than the captured snapshot.
- Maintaining a hand-written monolithic production HTML would create a second dependency graph and defeat plugin isolation.

## Verification

The contract suite creates a 20,000,000-character node, inspects independent chunk geometry, changes one middle character, verifies that only two chunk patches enter history, performs undo and redo, serializes and parses the project, hydrates a second runtime, and checks middle and tail ranges. It also scans two thousand ordinary nodes without building one combined corpus, verifies editor window state remains outside document history, and runs the existing import, recovery, hot-stop and bounded AI retrieval contracts.
