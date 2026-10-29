# ADR-0080: Governed input, one composition list and public state protocols

## Status

Accepted. This supplements ADR-0001, ADR-0035, ADR-0038, ADR-0060 and ADR-0074.

## Context

The text-assist command opened a browser file chooser from a serialized command handler and awaited a fallback promise that had no reliable cancel settlement. Cancelling that chooser could retain the global command turn. The eager and hosted entry points also duplicated the complete built-in plugin order, while cloud wire contracts and feature code imported selected kernel implementation modules for commit records, model-asset types and spatial indexing. These patterns blurred the UI, composition, protocol and service boundaries.

## Decision

Browser file selection belongs to a governed React contribution. `textAssist.loadRulesFile` now emits a typed request signal and finishes immediately; the mounted contribution owns a declarative hidden file input, reads a selected bounded TXT, then dispatches `textAssist.importRulesFile`. Cancelling the browser dialog creates no pending command or synthetic error. The import command validates the filename and 16 MiB ceiling before updating personal assets and the document-owned rule resource.

`src/plugins/composition.ts` owns the single ordered built-in list. Portable/eager and hosted/lazy entry points inject only their semantic-provider variant. Architecture tests fail if those entry points regain feature-list entries.

State snapshots, patch operations and transaction commit records live in `src/protocols/state.ts`; public model-asset identifiers live in `src/protocols/network.ts`. Cloud contracts and feature models import these protocols instead of transaction-manager or network-service implementations. Stateless cross-feature algorithms such as spatial indexing, semantic sampling and abort classification live in `src/services`.

Annotation autosave uses one tracked single-flight loop. It commits the latest draft after an in-flight save, has no detached retry timer, and stops scheduling state changes after unmount.

## Consequences

- Browser cancellation cannot hold the formal command queue.
- Built-in ordering can change in one place without hosted/portable drift.
- Wire data and plugin-visible types do not depend on kernel implementation files.
- Shared algorithms have explicit service ownership instead of an ambiguous feature directory.
- Boundary tests cover dynamic imports, kernel implementation leaks and unmanaged plugin file pickers.

## Verification

Contract tests assert that the file-request command returns immediately and emits exactly one signal. Architecture tests enforce one composition list, public cloud contracts, allowed plugin dependencies and governed file selection. Type checking, linting and the full contract suite remain release gates.
