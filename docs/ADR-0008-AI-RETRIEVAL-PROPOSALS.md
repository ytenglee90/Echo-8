# ADR-0008: AI retrieval transparency and reviewable proposals

## Status

Accepted for the AI assistant and model-provider slice.

## Problem

AI needs useful cross-canvas context and durable conversation memory without directly reading text storage, hiding transmitted sources, building an unbounded prompt, persisting secrets, or letting a delayed result overwrite user work. The model connection must be replaceable independently from retrieval and document integration.

## Decision

The feature is split into two hot-switchable plugins.

- `ai-assistant` owns session records, transcript nodes, context preparation, provenance, generation tasks and proposals.
- `ai-provider` owns a user-configured Chat Completions-compatible endpoint, model choice and active HTTP requests. A bearer key exists only in the plugin closure for the current runtime session.

Content plugins contribute generic versioned capabilities: `context.catalog@1`, `context.read@1` and optional `context.search@1`. They also return owner-labelled standard patches through `content.createPlan@1` and `content.appendPlan@1`. The assistant does not import a content implementation and cannot directly write its namespace.

Context preparation is a cancellable background task. It can include a bounded recent transcript range, explicit references and ranked keyword ranges, in that order, under a 12,000-character default budget. It never materializes every canvas正文 as one string. The prepared context is ephemeral, expires after ten minutes and must be displayed before the separate generation command is accepted.

Explicit `@[exact title]`, `@node:id`, or UI-generated `@[readable title](node:id)` references are resolved before keyword retrieval. The stable-ID form prevents duplicate titles or later renames from redirecting a reference. The preview shows every selected source and range. Canvas content is wrapped as untrusted reference material in the model request so instructions found inside source正文 are not treated as system or user commands.

Every actually submitted user turn and every returned assistant turn are appended verbatim to the session's transcript text node. A returned result becomes a durable proposal containing provider, model and source range revisions. It does not modify existing正文 before approval. Accepting the proposal revalidates the source revisions, obtains a content-owner delta plan and commits both the requested create/append/replace change and accepted status in one document transaction. Undo therefore restores the pending proposal and reverses the complete content change together.

## State and history

Sessions, proposals and transcript text belong to document state and participate in global history. Panel visibility and active-session choice belong to workspace state and never enter document undo. Prepared contexts, status signals, task handles, abort controllers and the API key are runtime-only.

## Failure and lifecycle rules

- Re-preparing cancels the previous retrieval task; a new generation cancels the previous generation task.
- Stopping either plugin cancels its owned tasks or HTTP requests and releases all commands, capabilities, signals and UI contributions.
- Stopping the provider clears the key. It does not delete assistant sessions or proposals.
- A stale source revision rejects generation or acceptance instead of applying an old result.
- A provider error leaves the reviewed preparation available for a retry until expiry.

## Alternatives rejected

- Giving the assistant direct access to text-node records would couple storage layout to AI and bypass capability ownership.
- Persisting an API key in document, workspace, browser storage or recovery logs would make portable files and crash snapshots secret-bearing.
- Sending immediately from the prompt box would hide which sources are transmitted.
- Letting model output replace正文 on arrival would race user editing and make provenance and undo ambiguous.
- Storing only summaries of chat would violate exact conversation memory and compound semantic drift.

## Verification

Tests cover complete catalog search, exact transcript retention, context preparation, proposal creation, one-entry acceptance and undo, recent-transcript revision revalidation, plugin hot-stop/restart, and absence of the session key from every persisted namespace.
