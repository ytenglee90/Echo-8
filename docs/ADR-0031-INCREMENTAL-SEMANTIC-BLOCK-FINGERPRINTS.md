# ADR-0031: Remote semantic cache reuses unchanged sampled blocks

## Status

Accepted.

## Context

The remote semantic provider previously treated a source revision as one cache unit. Editing one character caused every sampled block for that source to be sent to the embedding endpoint again, even when two of three bounded samples were byte-for-byte unchanged. This wastes time, remote quota and user-authorized content transfer.

## Decision

Each bounded semantic sample now carries an independent deterministic fingerprint over the exact title-and-text input sent to the embedding provider. When a source revision changes, the provider rereads its bounded sample windows, compares fingerprints with the previous transient cache, and reuses vectors for matching blocks regardless of the source revision. Only unmatched blocks enter the remote embedding batch.

Reused blocks receive the current source metadata, range and preview before the staged cache replaces the older source entry. A title change intentionally changes every block fingerprint because the title is part of the embedding input. Force rebuild and provider-profile changes still discard all reusable vectors.

The cache remains transient and local to the active browser session. API keys, vectors and sampled text are not written to the canvas document, local checkpoint or portable `.echo8` file.

## Consequences

- A same-length local edit inside one of three samples requests one new document embedding instead of three.
- An edit outside all sampled windows can update source revision metadata without another document embedding request.
- Length-changing edits may move sample windows; content-identical blocks can still reuse vectors by fingerprint, while changed windows rebuild.
- This change reduces remote work but does not claim full-document semantic coverage. Expanding from bounded samples to a larger paragraph catalog requires a separate cost, privacy and context-quality decision.
