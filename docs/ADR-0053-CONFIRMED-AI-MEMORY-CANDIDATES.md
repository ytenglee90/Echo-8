# ADR-0053: AI-extracted memory is a source-bound candidate until the user confirms it

## Context

Free-form conversation contains useful decisions and constraints, but treating a model extraction as a formal fact would let omissions, inference, or a model error silently change future answers. At the same time, requiring the user to remember a command syntax for every durable fact makes long-running work brittle.

## Decision

Echo-8 stores model output in a separate `aiMemoryCandidates` document namespace. A candidate contains a bounded subject/value structure, extractor identity, confidence, and an exact quoted range in the canonical conversation source. The extractor accepts only JSON that quotes a contiguous user turn; assistant text, unquoted output, and structurally incomplete modifications are discarded. Candidates never enter memory retrieval, conflict detection, or the searchable memory index.

Candidate extraction is manual by default. A per-assistant personal setting may opt into one small, non-streaming extraction call after each completed answer. The setting is off on upgrade and clearly describes the extra model call. Automatic extraction is given the exact range of the just-recorded user entry rather than an arbitrary transcript tail; extraction input is bounded to 7,200 characters.

Accepting a candidate re-reads its exact source quote, then appends the equivalent user `@确认`, `@修改`, `@废弃`, or `@分支` directive to the canonical transcript in one transaction. Existing autosave and indexing subsequently make that explicit directive the only formal fact. Dismissing a candidate records the dismissal without altering the transcript.

## Consequences

- Original conversation remains authoritative; suggestions are derived and reversible.
- Users can audit both the cited wording and the acceptance action.
- Automatic extraction has explicit cost and privacy implications because it sends the bounded user entry to the currently selected model connection.
- A changed or deleted conversation cannot receive a late candidate commit.
- This does not replace the existing formal directives; it creates them only after an explicit user acceptance.
