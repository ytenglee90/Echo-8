# ADR-0012: AI inline commands, reference drops and multiple provider profiles

## Status

Accepted for the AI assistant, canvas and model-provider slices.

## Problem

Separate operation, canvas-reference and conversation selectors duplicate state outside the user's prompt, consume floating-panel space and make a request harder to read after it is recorded. At the same time, users need more than one model platform without placing reusable secrets in a portable canvas, autosave record or recovery snapshot. Dragging a canvas node into the assistant must not introduce a direct canvas-to-AI implementation dependency.

## Decision

The assistant composer is the only operation and reference input. One declarative operation catalog covers general work, content transformation, information processing, analysis/planning and creative generation. Tokens include existing commands such as `@润色`, `@总结` and `@大纲` plus domain-neutral commands such as `@提取`, `@对比`, `@查错`, `@分析`, `@规划`, `@拆解`, `@评估`, `@推演` and `@决策`. The same catalog owns parser recognition, labels, suggestions, task instructions and temperature, so adding an operation cannot create divergent switches in the panel and model adapter. When no task token is present the operation is `general` and the model is explicitly told not to assume an industry, profession or content type. Memory directives `@确认`, `@修改`, `@废弃` and `@分支` are shown in the same `@` menu but remain a separate protocol; they do not become writing operations. The original prompt, including its tokens, is retained verbatim in the transcript. Node tokens display compactly as `@[readable title]`; the controlled preparation message carries a matching `{ token, sourceId }` binding so resolution and proposal provenance still use a stable ID. Duplicate titles receive only a short visible disambiguator. Generic `context.catalog@1` and `context.read@1` capabilities perform the actual reads.

The conversation selector and the public new-conversation action are removed from the floating panel. `ai.open` initializes one current conversation only when no session exists; closing and reopening the panel reuses it. Saving is the explicit archival boundary and creates an ordinary canvas transcript node rather than switching to another live session.

Canvas node drops use three public ephemeral signals. The assistant publishes a screen-space `content.reference.drop-zone`; canvas dragging publishes `content.reference.drag.preview`; releasing over the advertised zone publishes `content.reference.drop`. A successful reference drop inserts a stable token at the composer caret and does not commit a node move. Neither plugin imports the other's implementation or queries its DOM.

The model-provider plugin stores a list of named profiles containing platform name, connection name, endpoint, model and authentication mode, plus one active profile identifier. Each bearer key is held only in a runtime map keyed by profile ID. Profile metadata is personal workspace state with no document history. Keys are never represented as store patches and are erased on plugin stop or application refresh.

Legacy single-provider commands and stored preferences remain readable so existing local settings do not fail abruptly. New clients use `ai.provider.catalog@1` and `aiProvider.profile.*` commands.

## Failure and lifecycle rules

- Unknown operation tokens remain ordinary prompt text and fall back to the general operation.
- An unresolved bound or manually typed reference blocks context preparation with a visible error rather than silently substituting another node.
- Closing or stopping the assistant withdraws its drop zone; cancelling a canvas drag clears reference previews.
- Deleting a provider profile clears its in-memory key after the committed configuration event.
- Stopping the provider aborts active requests and clears every in-memory key while retaining non-secret profile metadata.

## Verification

Contract tests cover inline operation parsing, caret-safe reference insertion, stable-ID context resolution, exact transcript retention, multiple configured profiles, active-profile switching, absence of every key from workspace state, and key erasure after hot-stop/restart. Type checks and plugin manifest validation cover the public commands, capabilities and signals.
