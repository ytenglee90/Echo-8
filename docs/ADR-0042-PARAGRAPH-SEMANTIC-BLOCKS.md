# ADR-0042: Semantic retrieval indexes stable paragraph-aware blocks

## Context

The first remote semantic index embedded at most three fixed windows from the beginning, middle and end of each source. That bounded cost, but it could miss every topic between those positions and a hard 1,200-character window could begin or end in the middle of a paragraph.

Embedding every character of an isolated 20-million-character source is not a responsible default either: it can create thousands of remote requests, high cost and a large transient vector cache. The provider therefore needs complete coverage for ordinary documents and explicit bounded behavior for exceptional ones.

## Decision

Sources up to 153,600 UTF-16 characters are range-read in 64 KiB windows and partitioned into paragraph-aware blocks no longer than 1,200 characters. Paragraph breaks are preferred, then line and sentence boundaries; only an overlong paragraph uses a safe hard boundary. Absolute source offsets are preserved.

Larger sources use up to 128 deterministic anchors spread across the entire source. Each bounded probe resolves to the enclosing paragraph, or a centred safe slice when one paragraph is itself too large. The provider reports these sources as partial/stratified coverage instead of implying that every paragraph was embedded.

Every block keeps its own title-and-text fingerprint. After a source revision changes, unchanged blocks reuse their existing vectors even when their offsets moved. Identical block fingerprints share one remote embedding request while retaining separate source ranges. Original range reads and revision checks remain authoritative; the vector cache is transient and never enters the canvas file.

## Consequences

- Ordinary documents receive full paragraph-level semantic coverage rather than three samples.
- Editing one paragraph normally rebuilds only that block.
- Exceptional long sources have far broader deterministic coverage with a hard remote-cost and memory ceiling.
- The settings UI discloses how many long sources have only stratified coverage.
- No public search capability or document file format changes.
