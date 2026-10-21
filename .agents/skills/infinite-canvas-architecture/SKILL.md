---
name: infinite-canvas-architecture
description: "Design, implement, refactor, or review this modular infinite-canvas application and its single-HTML build while preserving its microkernel/plugin architecture, broadcast-only user operations, transaction and history discipline, unified UI system, large-text performance, persistence, recovery, and AI privacy. Use for this infinite-canvas project or direct derivatives, not for generic canvas or web work."
---

# Infinite Canvas Architecture

Use this skill to keep the infinite-canvas product clean, deterministic, plugin-oriented, and responsive as it grows. Treat the architectural invariants below as product requirements, not preferences.

## Non-negotiable outcome

- Every user action enters the system as a typed message. No UI handler directly mutates durable data.
- Plugins do not call, inspect, style, or mutate one another. They communicate through core-routed commands, events, queries, capabilities, and task messages.
- The core is the only coordinator of durable writes, transactions, conflict arbitration, history, resource ownership, and lifecycle transitions.
- UI is architectural from the first implementation: plugins declare contributions; the UI runtime owns rendering conventions, slots, focus, overlays, keyboard routing, animation, and cleanup.
- Durable document state, personal layout state, transient interaction state, and rebuildable caches remain separate.
- Hot disable/enable is real: stop admission, settle or roll back work, unregister every contribution, release every owned resource, and preserve plugin data unless the user explicitly removes it.
- Large content is range-based, chunked, streamed, virtualized, cancellable, and revision-aware. Do not introduce an API that requires loading an entire long document.
- Performance, crash recovery, file migration, privacy, accessibility, and diagnostics are designed in rather than deferred.
- Never bypass these rules to finish a feature quickly. Change a public contract deliberately, version it, migrate it, and test it.
- Never wait for a newly queued formal command from inside the command that currently owns the serial queue. Use the kernel's explicit compound-command or deferred-follow-up path, preserving causation and validation.

## Required operation path

Every durable interaction follows this path:

```text
user input
  -> input adapter emits intent
  -> command router validates identity, schema, permission, and current mode
  -> conflict arbiter chooses or rejects the operation
  -> transaction applies through the single store write boundary
  -> history and persistence receive standard patches
  -> commit publishes result events
  -> render, indexing, statistics, autosave, and diagnostics react
```

High-frequency previews still use messages, but travel through the ephemeral interaction channel. A drag, resize, zoom, or panel adjustment publishes coalesced preview signals and commits one durable command at the end.

## Work procedure

1. Inspect the existing project and its instructions before changing it. Preserve existing user changes and public contracts unless the requested work requires a deliberate versioned change.
2. Identify the owning plugin or mandatory system service. Do not place feature logic in the shell or core merely because it is convenient.
3. Trace every new user operation through input, message, validation, transaction or ephemeral state, result event, UI, persistence, history, and cleanup.
4. Define or reuse capabilities rather than depending on a concrete plugin. Keep public APIs minimal, typed, versioned, cancellable when asynchronous, and streaming when data may be large.
5. Implement one complete vertical behavior before broadening an interface. Prove create/edit/undo/save/reload for new data types or equivalent end-to-end behavior.
6. Run contract, transaction, persistence, interaction, and proportional performance tests. Review the forbidden-boundary checklist before completion.
7. Report any intentional contract, file-format, permission, migration, or performance-budget change explicitly.

## Read the relevant contracts

- For any core, module-boundary, data-ownership, or feature-placement decision, read [references/architecture-contract.md](references/architecture-contract.md).
- For plugin manifests, capabilities, permissions, lifecycle, hot disable/enable, or resource cleanup, read [references/plugin-and-capability-contract.md](references/plugin-and-capability-contract.md).
- For commands, broadcasts, state writes, conflicts, undo/redo, typing sessions, drag previews, or batch operations, read [references/messaging-state-transactions.md](references/messaging-state-transactions.md).
- For components, theme, slots, keyboard, focus, overlays, canvas interaction, editor panes, or accessibility, read [references/ui-interaction.md](references/ui-interaction.md).
- For canvas rendering, 2,000-node behavior, very large documents, search, statistics, workers, scheduling, or benchmarks, read [references/performance-large-content.md](references/performance-large-content.md).
- For file format, autosave, migrations, recovery, import/export, security, AI, privacy, or exact chat memory, read [references/persistence-recovery-security-ai.md](references/persistence-recovery-security-ai.md).
- For scaffolding, implementation order, review, tests, acceptance gates, diagnostics, or final single-HTML packaging, read [references/implementation-verification.md](references/implementation-verification.md).

Read every reference whose subject the requested change touches. Do not load unrelated references merely to restate them.

## Hard rejection conditions

Do not accept an implementation that:

- mutates durable state from an event listener, component, canvas object, or plugin-local shortcut handler;
- imports another feature plugin to call its implementation;
- reads another plugin's private namespace instead of requesting a capability;
- registers global DOM, CSS, keyboard, timer, worker, file, or listener resources outside core ownership;
- records plugin-specific function calls as the only form of undo;
- mixes hover, open menus, drag previews, or editor focus into the document history;
- loads all nodes or all long-document text merely to render, count, search, save, or supply AI context;
- allows stale search results, AI proposals, or editor buffers to overwrite a newer content revision;
- silently discards unknown plugin data, failed migrations, recovery journals, or privacy flags;
- claims hostile third-party plugin isolation inside the same JavaScript realm;
- sacrifices input latency or canvas motion to autosave, indexing, statistics, export, or AI work.
- awaits ordinary `commands.dispatch` from an active formal command handler and can therefore self-deadlock the serial queue.

If the requested feature appears to require one of these violations, pause that implementation path, explain the specific contract conflict, and redesign through a capability, system service, transaction, UI contribution, or versioned migration.
