# ADR-0016: Hybrid retrieval and complete evidence blocks

## Status

Accepted for local context retrieval and AI memory preparation.

## Problem

Literal substring matching misses related wording, while sending every canvas document to a model is slow, expensive and private by default. Equal division of a fixed context budget can also cut sentences, conversation turns and code blocks into misleading fragments. Treating a source revision change as permanent memory loss makes harmless edits unsafe.

## Decision

The search-index plugin owns a rebuildable, runtime-only per-source chunk index. It range-reads content in 32 KiB windows, keeps a bounded Bloom filter for each chunk and exposes `context.search@3`. Search first eliminates impossible chunks, then calculates BM25 from candidate term frequency, document frequency, chunk length, title matches and exact-phrase matches. It returns only the best bounded range for each source. Node creation, rename and content-change events schedule a core-owned delayed rebuild; plugin stop cancels its task and releases its capability.

BM25 remains a lexical ranking algorithm, not a claimed embedding model. An independent plugin may provide `context.semanticSearch@1`. The assistant queries all available lexical and semantic providers through the capability registry and rank-fuses results by source ID. Removing a semantic provider leaves BM25 operational and does not change durable data.

Memory-index matching and general content search are separate stages. An index or search hit chooses a candidate location; only a range read from the current original is evidence. The evidence allocator has shared character and conservative estimated-token budgets and does not divide either budget equally. Explicit references, current conversation, formal authority, uncovered query branches and relevance determine admission order; recency is a tie-breaker. Ranges expand to natural boundaries. Complete conversation turns, fenced code blocks, Markdown tables, Markdown lists, paragraphs and sentences are preferred. An oversized automatic-retrieval structure is skipped and disclosed rather than silently cut. Explicit user references may still expose a labelled incomplete range when no complete structure can fit, because the user explicitly chose that source.

A stale memory index never authorizes stale formal claims. It may temporarily identify a candidate location only when the current original still matches query or anchor terms. The transmitted source records both the stale index revision and the current verified source revision. A debounced background task rebuilds the index and commits only after revision revalidation.

All indexes, rank scores, pending tasks and progress are derived runtime state. Durable memory originals, user directives and memory enable/scope settings remain document state and continue to use typed broadcasts and global transactions.

## Performance and privacy

- Index construction and rebuilding are cancellable, prioritized and range-based.
- Candidate verification reads chunks instead of joining an entire long source.
- Token estimation is deliberately conservative for CJK, emoji and dense punctuation. It is a local admission guard rather than a claim to reproduce a provider's proprietary tokenizer exactly.
- The default path is local and deterministic; no embedding content leaves the browser unless a separately authorized provider explicitly implements that capability.
- Candidate limits bound CPU and memory, while batched branch coverage avoids a hard top-ten final answer limit.
- Retrieval reports distinguish index coverage from complete-original-evidence coverage and disclose skipped, stale-recovered and deferred material.

## Verification

Contract tests verify delayed task admission and cancellation, dynamic node indexing, BM25 ranking, chunk-range reads, complete conversation/code/table/list evidence boundaries, CJK token pressure, stale-current-original recovery, automatic rebuild and applicability-scope conflict separation. Type checking and the portable single-HTML build remain release gates.
