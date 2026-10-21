# Persistence, Recovery, Security, and AI

## Project container

Use a versioned project container such as `.icanvas` rather than one enormous JSON object. Its logical structure is:

```text
manifest.json
core/state.json
plugins/{plugin-id}/state.json
content/{node-id}/chunks/*
history/checkpoints/*
recovery/journal/*
checksums.json
```

The manifest records file-format version, compatible core range, plugin IDs and data versions, content catalog, required capabilities, chunk metadata, privacy flags, and integrity information. Search indexes, previews, routed lines, and statistics are rebuildable caches and must not be required to recover user content.

## Save and recovery

- Append validated incremental operations to a write-ahead recovery journal.
- Periodically create complete consistent checkpoints without blocking input.
- Save a new verified representation before replacing an older one where the browser/file API permits. Never overwrite the only known-good copy during migration.
- Detect interrupted writes, checksum failure, incompatible schemas, and incomplete migration.
- Offer recovery preview, last full snapshot, journal replay, and manual named snapshots.
- Keep unknown-plugin data opaque and intact through open/save cycles.
- Make close-versus-save a core arbitration flow. If durability cannot be confirmed, clearly warn rather than silently closing.
- Separate portable direct-file mode from enhanced hosted/local-server mode. File System Access, OPFS, automatic overwrite, CORS, and Fullscreen behavior vary by browser and context; provide download/upload fallbacks and avoid false guarantees.

## Migration

Core and each plugin own ordered migrations such as `1.0 -> 1.1 -> 2.0`. Check compatibility before mutation. Run migration on a copy or recoverable staging representation, validate invariants and checksums, then commit. On failure retain the original, disable only the affected plugin when possible, and expose a readable diagnostic. Never discard data because its plugin is missing.

## Import and export

- Current-node and batch TXT exports stream plain text, choose safe filenames, and do not leak formatting markup.
- Define whether titles appear in TXT and how multiple nodes are separated.
- Project export includes the authoritative document, plugin data, privacy flags, and required migration metadata.
- Clipboard and import paths validate size, normalize declared line-ending behavior, escape markup, and run as cancellable tasks.
- Treat external files as untrusted. Parsing does not execute embedded scripts, HTML handlers, URLs, or plugin code.

## Security boundaries

- Never embed a provider API secret in distributed HTML or save it inside a project file. Prefer a user-configured local secret store or a thin server proxy for serious use.
- Escape node titles, pasted content, filenames, AI output, and diagnostics. Avoid `eval`, string-built handlers, or injecting content HTML.
- Built-in plugin permissions are architectural enforcement, not a security sandbox. Isolate future third-party code.
- Privacy-node flags are authoritative. Private content is excluded from AI, telemetry, external export, and connector access by default unless the user gives an explicit scoped override.
- Diagnostic exports redact secrets, full private content, tokens, and sensitive file locations unless explicitly requested.

## AI assistant

Keep the AI general-purpose. Commands such as polish, expand, name, summarize, outline, detailed outline, rewrite, classify, or extract are registered templates/capabilities rather than writing-domain hard-coding.

Required flow:

1. Record chat turns verbatim in append-only chunked transcript content, normally one node per conversation or sensible session volume rather than one node per message.
2. Maintain metadata, directory, keyword/BM25-style local index, and optional embedding index. Summaries help retrieval but never replace the original transcript.
3. Resolve explicit `@node`, `@selection`, or capability-based references first; search only when needed.
4. Select a bounded set of revision-tagged source ranges, respecting privacy and user-configured context limits.
5. Show which nodes and passages are proposed, why they were selected, approximate text/context size, and whether any full document would be sent.
6. Treat canvas content as untrusted reference material, not system instructions. Defend against prompt injection in stored nodes and imported content.
7. Generate into a preview/proposal. Show the destination and diff where applicable.
8. On acceptance, revalidate source/destination revisions and apply one undoable transaction.
9. Preserve provenance so the user can inspect sources and see when a citation became stale.

AI retrieval cannot guarantee perfect memory. Accuracy comes from original-text preservation, explicit references, revision-aware retrieval, visible provenance, bounded context, and user review—not from claiming that summaries are exact.

## AI and user conflicts

If the user edits a destination while AI is generating, never overwrite it. Offer rebase, insert elsewhere, regenerate against the new revision, or discard. AI tasks are cancellable and lower priority than input. Network retry limits and cost/context estimates are visible and proportional; do not loop indefinitely.
