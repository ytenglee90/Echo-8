# ADR-0030: Local checkpoints deduplicate immutable text chunks

## Status

Accepted.

## Context

Text bodies already use immutable 64 KiB records and local edits reuse every unaffected chunk ID. Local IndexedDB checkpoints nevertheless serialized the complete `textContentChunk` namespace inside every latest snapshot and every manual recovery point. History patch values could contain the same immutable chunks again. Large documents therefore paid repeated IndexedDB write and storage costs even when most chunk IDs were unchanged.

## Decision

IndexedDB schema version 4 adds a `contentChunks` object store keyed by immutable text chunk ID. The local latest checkpoint and recovery-point records contain:

- the normal application snapshot with the live chunk namespace emptied;
- the IDs currently active in the document;
- the union of chunk IDs required by the live document and its history;
- lightweight history references in place of repeated chunk values.

On checkpoint, the persistence service writes only chunk IDs not already present in the object store, writes the small structural snapshot, and clears the journal in the same durable checkpoint boundary. Loading hydrates the chunk namespace and history patch values before recovery replay or store import, so the rest of the application still receives the unchanged `PersistedApplication` contract.

Recovery points share the same immutable chunk records. After a latest checkpoint or recovery-point pruning, garbage collection retains the union referenced by the latest snapshot and remaining recovery points, then deletes unreferenced chunk records. Starting with the shipped `fresh-session` policy clears snapshots, journal, recovery points and chunk records together, while personal preferences remain intact.

The portable `.echo8` format is unchanged. This is an internal local-recovery representation only.

## Consequences

- Unchanged 64 KiB body chunks are not rewritten for every complete checkpoint.
- Latest snapshots, manual recovery points and history share immutable body data by ID.
- Journal records remain incremental and self-contained until the next complete checkpoint.
- Snapshot capture still creates a stable point-in-time view before externalization; further reduction of capture memory requires a separate measured change to the store snapshot API.
- A missing referenced chunk is treated as local recovery corruption and fails explicitly instead of returning partial text.
