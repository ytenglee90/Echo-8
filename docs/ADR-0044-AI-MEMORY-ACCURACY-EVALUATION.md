# ADR-0044: AI memory accuracy has a declarative release evaluation set

## Context

Memory retrieval and conflict handling had many unit examples, but no one release gate summarized whether expected memories were recalled, unrelated memories leaked, scopes remained separate, explicit modifications resolved old values, and later decisions could reopen a conflict. Refactoring ranking or indexing could therefore pass narrow tests while weakening the product behavior as a whole.

## Decision

The test suite now includes declarative retrieval and version/scope fixtures separate from implementation code. The first baseline covers direct recall, compound branch coverage, explicit-memory recall without lexical overlap, exhaustive retrieval beyond the first batch, unrelated-memory exclusion, independent applicability scopes, explicit replacement, reopened conflicts and named branches.

The release test computes recall over required sources, rejects any listed unrelated-source leakage, and checks the expected conflict state and current value for every version fixture. The initial gate is exact for this small deterministic baseline. New retrieval algorithms must add cases for newly supported behavior rather than weakening existing expectations.

Conflict resolution now applies explicit claims in chronological memory order and stable transcript sequence. A later confirmation can therefore make an earlier, once-resolved alternative current again; the older modification no longer masks it merely because its previous value appears in a global deprecated set. Evidence records disclose whether a value is current, superseded, deprecated or still competing.

## Consequences

- Memory quality changes have a repeatable product-level regression signal.
- The fixture stays free of provider keys and remote calls and is deterministic in CI.
- This does not claim real-world semantic accuracy; broader anonymized cases should be appended as failures are discovered.
- The large historical core contract file remains untouched; the evaluation is a new focused test asset, not a split of that file.
