# ADR-0029: Background computation is owned by the kernel

## Status

Accepted.

## Context

Search indexing already runs through the cancellable task scheduler and yields to user input, but Chinese tokenization, Bloom construction, candidate analysis and BM25 ranking still consume the browser UI thread. Allowing each plugin to create its own `Worker` would move the cost while breaking lifecycle cleanup, permissions, diagnostics and portable-build consistency.

## Decision

The kernel owns one lazily created background worker through `WorkerService`. A plugin may submit work only through `context.workers.run` and only when all of the following are true:

- its manifest declares `workers.run`;
- its manifest declares the exact, plugin-prefixed job identifier;
- the request belongs to the calling plugin;
- the job is still owned by an active scheduled task.

Stopping, pausing after a failed start, or uninstalling a plugin cancels its outstanding worker requests. A worker failure rejects all affected requests and the service creates a fresh worker on the next job. Feature plugins must not construct raw workers or attach unmanaged worker listeners.

The task scheduler remains responsible for delay, priority, progress, pause, timeout and user-visible long-task feedback. The worker is only an execution venue. It cannot read or write the store, emit commands, create history or persist data. Plugins read bounded authoritative ranges on the main side, send immutable derived inputs to the worker, and consume its rebuildable results.

The search-index plugin moves these calculations to the managed worker:

- n-gram tokenization and Bloom-filter construction;
- bounded candidate text analysis and preview extraction;
- BM25 document frequency and ranking.

Candidate filtering, revision ownership, bounded source reads and result publication stay in the plugin. Headless tests and unsupported browsers use the same pure job functions as a deterministic fallback only when no worker factory exists.

The portable build uses Vite's inline-worker form, so the worker remains inside the single HTML delivery instead of creating an external JavaScript dependency.

## Consequences

- Large index rebuilds no longer perform their expensive text loops on the UI thread in the shipped browser application.
- Worker usage remains permissioned, declared, cancellable and hot-unpluggable.
- Search behavior is identical between worker and headless fallback paths because both call the same pure functions.
- Worker messages copy bounded text batches; later phases may add transfer-friendly representations if measurement shows message-copy cost is material.
- New worker jobs require a manifest declaration, runtime validator, contract test and performance evidence.
