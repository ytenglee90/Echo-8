# ADR-0055: Confirmed claims provide transient retrieval anchors

## Context

The readable memory summary and keyword list are deliberately lossy directories. A user-confirmed directive can therefore be absent from both while still being the most precise answer to a later question. Requiring an embedding service to recover this known structure would add latency, cost and an unnecessary remote dependency.

## Decision

During memory matching, the assistant also compares each query branch with the subject, value, previous value and effective scope of `user-explicit` indexed claims. A match raises that memory's score and adds the directive's original offset as a preferred evidence anchor. Candidates and legacy `candidate` claims are excluded. Different values for the same subject remain separate records; conflict resolution remains the existing explicit-version system.

This is derived at request time from the existing memory index. It does not add a graph namespace, mutate document data, replace BM25 or allow an index to serve as evidence. Context preparation still range-reads the current original and observes source revisions before it supplies a block to the model.

## Consequences

- Explicit decisions and scoped parameters are recalled even when a summary omits their vocabulary.
- Formal memory has a deterministic, inspectable priority without making unconfirmed model output authoritative.
- A future entity graph can build on the same public claim structure, but is not required for this reliable first hop.
