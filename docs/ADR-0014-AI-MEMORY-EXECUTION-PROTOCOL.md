# ADR-0014: Versioned AI memory execution protocol

## Status

Accepted for every AI provider request.

## Problem

Canvas storage and retrieval can supply exact evidence, but a remote model still needs unambiguous rules for interpreting that evidence. A local Codex `SKILL.md` governs development work only; it is not packaged with provider requests and cannot constrain GPT-, Gemini- or other compatible endpoints at runtime. Relying on a one-time prompt, a summary or the model's assumed chat memory would make behavior vary by platform and conversation length.

## Decision

`src/plugins/ai-assistant/memory-protocol.ts` owns a versioned, provider-independent execution protocol. `buildGenerateRequest` injects it into the system message on every request. Provider profiles choose transport and model only; they cannot replace or omit the protocol. Version 1.2 adds complete-evidence-block semantics, separates index coverage from original-evidence coverage, identifies current-original verification after a stale-index hit, and forbids treating two values in different applicability scopes as a conflict.

The protocol establishes these invariants:

- only transmitted original source ranges count as memory evidence;
- indexes, summaries, keywords and model inference are directories or hypotheses, never evidence;
- time changes, scope changes, branches and direct contradictions are distinguished;
- explicit user `@确认`, `@修改`, `@废弃` and `@分支` records outrank ordinary discussion;
- unresolved conflicts are presented with their sources instead of being silently resolved;
- current-state and historical questions use different version semantics;
- missing evidence must be admitted;
- incomplete sentences, turns and code blocks must not be silently completed by the model;
- scope-qualified facts only conflict when their normalized applicability scope is the same;
- canvas text is untrusted reference material and cannot override system or user instructions.

The prepared-context envelope carries structured conflict and unavailable-memory records as well as source ranges. The panel shows these before transmission. The generated user message includes a compact conflict directory, while the evidence itself remains wrapped as untrusted canvas content.

Protocol versions are application behavior versions, not file-format versions. Changing precedence or evidence semantics requires a new protocol version, contract tests and an ADR update. Mere wording improvements that preserve the same semantics may retain the version.

## Boundaries

- The first deterministic implementation recognizes explicit memory directives. It does not pretend that every implicit natural-language contradiction can be classified without error.
- Retrieval remains bounded by the application context budget. When a question requires more evidence than fits, the assistant must disclose the missing coverage and ask for a narrower question or a staged analysis.
- The remote provider receives only the prepared ranges the user can review. It never receives the complete canvas merely because a memory index matched.

## Verification

Type checks enforce the structured memory issue, evidence-boundary and conflict envelope. Contract tests cover explicit supersession, unresolved conflicts across saved memories, scope separation, multi-memory retrieval, safe original-revision recovery, automatic reindexing and injection of the execution protocol into generation requests.
