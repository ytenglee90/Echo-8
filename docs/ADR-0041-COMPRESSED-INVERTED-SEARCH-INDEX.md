# ADR-0041: Local search uses a bounded compressed inverted candidate index

## Context

The local BM25 provider already range-read source text, built per-chunk Bloom filters in the managed worker, and verified every candidate against current source text. However, each query still visited every indexed chunk to test its Bloom filter. That work is bounded per chunk but grows linearly with the number of chunks, even when only a handful can contain the requested terms.

An unrestricted Chinese bigram/trigram postings index can itself become larger than the source for a very large or high-entropy chunk. The optimization must therefore reduce ordinary query work without pretending that every possible long-text chunk can remain hot in memory.

## Decision

The search-index plugin now builds a managed-worker signature for each 32 KiB source window. Ordinary signatures retain sorted 32-bit term fingerprints in addition to the existing Bloom filter. A second managed-worker job converts those fingerprints into sorted posting lists encoded as unsigned delta varints.

Queries intersect posting lists for every gram in one query term, union the candidates of alternative terms, then range-read and verify the current source exactly as before. Fingerprints are candidate hints only: hash collisions cannot become search results because original text verification and revision-aware range reads remain authoritative.

Term fingerprints are capped per chunk. A chunk exceeding the cap stores only its fixed-size Bloom filter and is tested through the previous bounded fallback. A one-character query, which cannot be represented by the existing two/three-character lexical terms, also keeps the full candidate verification path. These fallbacks preserve recall and bound index memory for isolated very large documents.

Rebuilds, compression, cancellation and lifecycle cleanup remain owned by the search-index plugin through the kernel task and worker services. The public `context.search@2/@3` contracts, ranking rules and returned evidence format do not change.

## Consequences

- Ordinary multi-node queries no longer scan every chunk-level Bloom filter.
- Posting bytes are compact and deterministic, while source-local fingerprints permit incremental source rebuilds.
- Very large or high-entropy chunks trade query speed for bounded memory rather than being silently omitted.
- Approximate index diagnostics now include Bloom filters, retained fingerprints and compressed posting arrays.
- The portable single-HTML product remains self-contained; no external search library or resource is added.
