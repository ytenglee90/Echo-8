# ADR-0018: Independent remote semantic retrieval provider

## Status

Accepted for the first remote semantic-retrieval vertical slice.

## Problem

BM25 is fast, local and explainable, but it cannot reliably connect different wording such as “服务器崩了” with “502、内存溢出”. Shipping one specific local embedding runtime inside the portable HTML would increase the artifact size and still make model availability dependent on the receiving device. Folding embeddings into the chat provider would also couple two services with different endpoints, permissions, privacy timing and failure modes.

## Decision

`semantic-provider` is an independently stoppable built-in plugin. It owns personal profiles for OpenAI-compatible, Voyage and Gemini batch-embedding endpoints, per-profile runtime keys, a cancellable indexing task and an in-memory vector cache. It provides only `context.semanticSearch@1`. The assistant continues to request lexical and semantic providers through the capability registry and rank-fuses their public results. It never imports the semantic implementation.

The UI is aggregated into the existing AI-connection panel through public semantic commands, one state query and one coalesced signal. The chat-provider UI does not read the semantic namespace or call its implementation. If the semantic plugin is stopped, its tab reports that state and BM25 remains available. The ordinary form asks only for a verified quick preset, complete endpoint, embedding model, session key and remote-content consent; protocol/authentication/batch controls remain in an advanced disclosure. Human-facing platform and connection names are derived from the preset, endpoint and model instead of becoming redundant required fields.

Quick presets are shipped only where a public embedding contract has been verified: OpenAI, Alibaba Cloud Model Studio/Qwen, Volcengine Ark/Doubao and Gemini. DeepSeek and Moonshot/Kimi remain visible as unavailable explanatory entries because their public chat APIs do not currently establish an official embedding endpoint. They must not be mapped to invented OpenAI-compatible URLs. A custom compatible service can still be configured through the advanced controls.

Remote content transmission is opt-in per profile. Without that consent, incomplete configuration or a session key, the semantic capability returns no contribution and makes no network request. The first eligible query schedules a visible long-running task. It range-reads at most three bounded samples per source, batches them through the selected embedding adapter and keeps normalized vectors only in plugin memory. Later content revisions are detected through source revisions and re-embedded incrementally on the next query. This overview index is intentionally bounded; detailed evidence is still read from the original source after retrieval. Lexical BM25 remains the deterministic fallback and continues to find exact material outside the overview samples.

The network boundary has a distinct `network.ai.embed` permission and `PluginContext.network.embed` facade. The semantic plugin does not receive `network.ai.generate`. Chat generation and embedding requests therefore remain separately auditable even though users configure both from one panel.

Derived profile labels/platforms, endpoints, model names, adapter types, authentication modes, batch size and the explicit consent flag are personal workspace settings. Keys and vectors never enter document state, history, automatic-save snapshots, recovery journals or `.echo8` files. If the user explicitly binds an AI personal-configuration TXT, the connection fields and keys can be synchronized into that user-chosen local file through the public personal-connection protocol; Prompt templates are not part of that file. A recipient of the portable HTML has the same semantic plugin code, but must configure or import their own reachable endpoint and key. Without doing so, the received canvas still works with local BM25.

## Consequences

- Different wording can be recalled without replacing the local lexical index.
- A provider outage, browser CORS rejection, revoked key or hot-stop cannot remove BM25 results.
- The first semantic query can take time and consume provider quota; the task notice and consent text make that work visible.
- The bounded overview cache is not a full-corpus vector database. A future local or remote full-chunk provider can replace this plugin behind the same capability without changing the assistant.
- Vectors are rebuilt after refresh or plugin restart. Connection settings and keys may be restored from an explicitly imported or bound personal TXT, but vector caches remain transient.

## Verification

Contract tests prove that a semantically related fixture outranks unrelated nodes, disabled consent performs zero network requests, keys and vectors do not enter document state, and hot-stop releases all runtime resources. Personal-backup tests prove that chat and semantic connections round-trip through the explicit TXT channel while Prompt templates stay outside it. Preset tests also reject chat-only platforms as embedding presets and verify that no preset contains a key. Type checking, the full core contract suite and the portable single-HTML build remain release gates.
