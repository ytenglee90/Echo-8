# ADR-0054: Ordinary AI chat bypasses broad memory retrieval

## Context

Hybrid retrieval is valuable for recall and analysis, but applying it to every short greeting or simple question adds latency, cost, and irrelevant context. A learned routing call would itself add cost and make the basic path less predictable.

## Decision

Context preparation uses a small deterministic router. Explicit `@` sources and selected memories always require memory recall. Recall wording and analysis operations receive normal hybrid retrieval. A short general request without either is classified as ordinary conversation: it retains the recent transcript window but does not enumerate historical memory indexes or call lexical/semantic search capabilities. The prepared context records this non-default routing decision and the request status explains it.

The generation instruction also distinguishes ordinary-chat, explicit-only, and normal retrieval coverage. When an answer materially uses supplied canvas evidence, it asks the model to mark the corresponding source as `[来源 N]`; it must not invent a citation when no source was supplied.

The numbered marker is a provider-facing transport convention, not the user-facing label. When an assistant answer is committed, the assistant stores an optional turn-scoped mapping from every ordinal actually used in the answer to the source's stable ID, title snapshot, kind and revision. The transcript view resolves that stable ID against the current context catalog, displays `来源：<当前节点名称>`, and lets an available text source open through the public `editor.open` command. A renamed node therefore shows its current name without redirecting the citation; a missing node keeps the answer-time title and becomes non-interactive. Legacy response-detail records without this optional mapping continue to display their original numbered marker and require no migration.

## Consequences

- Simple chat has a cheaper, lower-latency default path.
- Explicit source selection remains authoritative and never gets bypassed by the heuristic.
- The classifier is intentionally conservative and testable, not a semantic authority. New misclassifications should become deterministic fixtures before changing its cues.
- Human-readable citation labels remain a derived view over stable IDs; they do not rewrite the verbatim transcript or make mutable titles authoritative identities.
