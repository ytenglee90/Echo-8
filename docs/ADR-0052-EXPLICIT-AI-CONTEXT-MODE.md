# ADR-0052: AI assistants can restrict context to explicit sources

## Context

Automatic hybrid retrieval is useful for recall but can surprise a user who wants a narrowly scoped answer. A blank memory selection previously meant that every enabled memory and compatible search provider could contribute evidence. The user had no way to keep recent conversation while preventing unrelated historical or semantic matches from entering a request.

## Decision

Each assistant window has a personal `contextMode` setting. It defaults to `automatic` for existing behavior. In `explicit-only` mode, context preparation keeps the current conversation window and user `@` references, and it may use memory sources explicitly selected for that assistant. It does not select every memory by default and does not call lexical or semantic search capabilities.

The setting is stored only in the existing personal assistant workspace settings. It never changes the portable canvas document, memory originals, memory indexes, or their availability. The prepared context carries non-default mode metadata so diagnostics and future UI can accurately explain the evidence boundary.

## Consequences

- Users can choose predictable provenance over automatic recall without losing the conversational thread.
- A selected memory remains explicit evidence in either mode; an `@` reference stays authoritative.
- Existing assistants remain on automatic retrieval after upgrade.
- This is a retrieval boundary, not a security boundary: normal source permissions and the existing privacy rules still apply.
