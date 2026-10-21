# Implementation and Verification

## First implementation sequence

Build a running skeleton rather than a pile of disconnected empty files:

1. Headless microkernel, schemas, plugin manager, capability registry, scoped contexts, message router, resource registry.
2. Mandatory store, transaction/history, conflict arbiter, task scheduler, persistence/migration, diagnostics, and UI runtime services.
3. Replaceable shell with governed slots, theme tokens, focus/keyboard/overlay managers, interaction state machine, and command palette.
4. Register all requested feature plugins as minimal contract-valid shells.
5. Complete one thin real vertical slice: create a text node, render it, open the editor, enter text, update a count, undo/redo, autosave, close/reload, and export TXT.
6. Correct contracts exposed by that slice before declaring the architecture frozen.
7. Fill plugins feature by feature without moving their logic into the core.
8. Bundle the modular development source into a portable single HTML only after development and tests; do not author the production system as one unstructured source file.

## Project guardrails

Maintain concise project documents or generated schemas for:

- architecture invariants and ownership map;
- plugin manifest, lifecycle, capability, and permission contract;
- message envelopes and transaction patch schemas;
- file format and migration registry;
- UI slots, design tokens, keyboard and overlay rules;
- performance budgets and benchmark fixtures;
- short architecture decision records for intentional public changes.

Where tooling allows, add build-time dependency-boundary checks and runtime registration validation. Reject cross-feature imports, duplicate message ownership, undeclared permissions, circular mandatory dependencies, incompatible capability versions, shortcut collisions, and unknown UI slots.

## Required test classes

- **Contract:** install/start/pause/stop/uninstall, dependency and capability negotiation, permissions, resource cleanup, UI contribution cleanup.
- **Messaging:** schema rejection, deterministic event order, causation chains, loop detection, idempotent retry, cancellation, backpressure.
- **Transactions:** atomic commit/rollback, cross-plugin patching, stale revision rejection, nested/batch behavior, 1,000-plus linear undo/redo.
- **Persistence:** checkpoint/journal agreement, save/open equivalence, interrupted save, checksum failure, unknown-plugin preservation, migration success and failure.
- **UI:** state-machine transitions, focus restoration, overlay order, shortcut conflicts, contextual actions, three editor panes, fourth-pane policy, reduced motion and keyboard access.
- **Rendered browser:** use Chromium for the fast local gate, then repeat the hosted and real `file://` portable gates in Firefox and WebKit for release; fail on uncaught page errors, external portable assets, plugin-boundary isolation, command timeouts, missing manifest declarations, editor/panel replacement, or broken Esc/shortcut routing.
- **Text:** IME composition, Unicode graphemes, huge paste, chunk boundaries, formatting marks, range reads, selection, streaming TXT.
- **Performance:** representative 2,000-node and large-text fixtures with input latency, frame, DOM, memory, queue, and save metrics.
- **Fault:** plugin throw, worker failure, task cancellation, unplug during queued work, recovery after uncommitted transaction.
- **Property/replay:** randomized valid command sequences followed by undo, redo, save, reload, and invariant comparison.

Do not use tests that merely assert file names or copy wording from specifications. Verify observable invariants and end-to-end outcomes. Run `pnpm run test:e2e` after installing the pinned Chromium with `pnpm exec playwright install chromium` whenever UI manifests, slots, commands, focus or shortcuts change.

## Architecture review checklist

Before accepting a change, answer:

1. Which plugin or mandatory service owns it?
2. What message represents every new user action?
3. Is the message a command, committed event, query, ephemeral signal, or task message?
4. Where is schema, permission, conflict, and revision validation?
5. What is durable, personal, ephemeral, or derived?
6. What standard forward/inverse patch makes it undoable after the plugin is disabled?
7. What capability prevents direct plugin dependency?
8. How are cancellation, cleanup, failure, and hot disable handled?
9. Does any path read all nodes or a whole long document unnecessarily?
10. Does UI enter through a declared slot with focus, keyboard, theme, accessibility, and cleanup rules?
11. How does it save, migrate, recover, and preserve unknown data?
12. What proves it remains responsive under relevant load?

Any unanswered item is unfinished architecture work, not a harmless implementation detail.

## Product semantics to decide before implementing the related feature

Record explicit decisions for:

- character/word count definitions across Chinese, Latin text, whitespace, emoji, and selection;
- writing-time idle timeout, paste/delete treatment, recent and session speed windows;
- group nesting, multiple membership, delete/ungroup behavior, and connection-to-group policy;
- search case, word boundary, regex, normalization, locked/private/chat-node scope, and replace preview;
- fourth-editor behavior, pane pinning, same-node multi-view, and unsaved close behavior;
- title behavior, multiline group titles, style scope, and TXT title/separator rules;
- AI automatic versus preview mode, allowed sources, private overrides, destination, token budget, and retry limits;
- clipboard internal MIME, external plain-text fallback, and cross-project ID remapping.

Do not guess a choice that would materially change stored data or user expectations. Ask once when the decision cannot be inferred safely.

## Diagnostics

Keep a user-readable diagnostic center independent of feature plugins. Show node and content scale, memory pressure estimate, frame/input health, save state, journal/checkpoint state, background tasks, index revision, plugin health, retained unknown data, and recent sanitized errors. Development mode may trace message, handler, transaction, invalidation, and render timing.

## Completion gate

Do not call a feature complete until it works through the required message path, respects ownership, passes rollback and cleanup, survives save/reload when durable, has proportional load evidence, and leaves no direct cross-plugin call or unmanaged global resource. If clean integration requires a new public contract, design and version that contract rather than bypassing the architecture.
