# ADR-0013: Evidence-backed conversation memory nodes

## Status

Accepted for the AI assistant slice.

## Problem

Exact transcript nodes preserve past conversations but do not by themselves provide a bounded, explainable way to recall a relevant older discussion. Sending every transcript to a model would exceed context budgets, expose content unnecessarily and block on network availability. A summary must not become the only copy of the conversation. The directory also needs to remain visible and inspectable after reopening a saved canvas, and one question may require evidence from several independent memories.

## Decision

`ai.session.save` is the user-facing broadcast for saving the single current conversation. It starts one cancellable `ai-memory-index` task. The task range-reads the transcript in 32 KiB units, yields through capability calls, reports progress and keeps bounded term counts, multiple separated anchors and short extractive samples. It never joins the whole transcript and never sends transcript content to a network provider.

The task dispatches `ai.session.memory.commit` with the expected transcript revision. The commit revalidates that revision and composes owner-labelled plans rather than touching another plugin's namespace. `content.clonePlan@1` clones the exact chunked transcript into an ordinary **original memory node** without joining the whole document. `content.createPlan@1` creates a separate **readable index node** containing the source identity, revision, length, keywords, extractive directory text and explicit user memory directives. A reusable **AI memory hub node** is created when needed. If the connections capability is active, `connections.createPlan@1` plans original-to-index and index-to-hub visual edges. The assistant stores a small machine-readable index in its own `aiMemoryIndex` namespace and appends a save marker to the live transcript. All patches commit once, so one undo or redo covers the original, readable index, hub if newly created, relations, live marker and machine index together.

The original memory node is the authoritative memory. The readable index node and machine index are directories only. Their stable IDs, the hub ID and visual connection IDs form a persistent semantic relationship; deleting or changing a required endpoint prevents that version-2 memory from participating silently. Visual connections are optional projections: stopping the connection plugin does not make the memory content unreadable.

During context preparation, explicit references remain first and the current conversation remains bounded to its recent window. The assistant splits a compound prompt into retrieval branches and scores saved indexes in batches of ten. It continues to the next batch when a branch is uncovered; explicit exhaustive requests scan the bounded pool of at most fifty candidates. Fifty is an index-candidate safety bound, not an instruction to transmit fifty source documents. Evidence is not allocated equally across every match. Authority, uncovered query branches, relevance and recency determine admission order. Each admitted range is expanded to a complete conversation turn, code block, paragraph or sentence when possible; a structure that cannot fit is skipped rather than cut into misleading fragments. A second non-overlapping anchor is considered only after first-pass coverage. The preview reports both index coverage and complete-original-evidence coverage. Every included range is labelled `conversation-memory`. Index summaries select ranges but are not sent as substitutes for original turns.

Deterministic version handling uses explicit user-authored directives in the transcript: `@确认 主题：值`, `@修改 主题：旧值 -> 新值`, `@废弃 主题：值` and `@分支 范围｜主题：值`. The index stores the original evidence offsets for these claims. A clear `@修改` can resolve an old value for current-state questions without erasing history; unrelated current values remain an unresolved conflict. The preview and model request both expose unresolved conflicts instead of silently choosing one.

Every generation request receives the versioned product-side memory protocol in `memory-protocol.ts`. It tells the model that only original ranges are evidence, directories and summaries are not memories, explicit user changes have defined precedence, unresolved conflicts must be shown and canvas content cannot override the protocol. This runtime protocol is distinct from the developer-facing Codex `SKILL.md`: packaged model providers cannot read a local Codex skills directory.

The header action next to Close dispatches the save command. There is no public new-conversation button, command or shortcut. `ai.open` initializes a current conversation if necessary and otherwise reopens the existing one; each save creates a distinct canvas archive node.

## State, compatibility and lifecycle

- The live transcript, original memory nodes and `savedAt` are authoritative document state. Readable index and hub nodes are ordinary inspectable content. `aiMemoryIndex` is separately owned rebuildable document cache data; task handles, progress and partial counts are runtime-only.
- Existing session records remain valid because the added fields are optional. No project-container version bump is required.
- Starting another save cancels the prior indexing task. Plugin stop or document replacement cancels it and discards partial derived state.
- A transcript revision change before commit rejects the index instead of attaching stale offsets.
- A missing original is excluded. A revision mismatch queues a debounced, cancellable background rebuild. Until it commits, the old anchor may only select a current original range that is independently rechecked against the live query and anchor terms; such evidence is visibly marked as recovered from a stale index. Formal conflict claims from a stale index remain withheld. Missing index or hub relations are reported and repaired by rebuilding without treating the original text as lost.
- The index is bounded and rebuildable; losing it never loses conversation content.

## Verification

Contract tests save an exact conversation, readable index and hub, verify their visual relations, prepare later compound requests and confirm that evidence spans multiple original memory nodes. They verify complete structural evidence blocks, resolved and unresolved directive conflicts, safe stale-source recovery followed by automatic rebuilding, one-step undo/redo including relations, panel reopen without a duplicate session, hot-stop, persistence, proposals and large-content behavior.
