# ADR-0084: Session-only workspace restore boundary

## Context

The workspace domain contains both durable personal preferences and transient interface state. Persisting the whole domain made a browser refresh reopen search, AI, editor and property surfaces with their old dimensions, camera and selection. That behavior confused recovery of meaningful book data with resuming an incidental screen arrangement.

The application still needs browser recovery for document content, colors, connections, annotations, AI conversations and queued cloud work. It also needs durable functional preferences such as palette colors, Prompt templates, model settings and shortcut overrides.

## Decision

`PluginManifest.sessionOnlyWorkspace` is the owner-declared persistence boundary for workspace namespaces. A plugin can mark an entire owned workspace namespace as session-only or list individual keys in a mixed namespace.

The kernel compiles those declarations into one persistence policy before opening recovery storage. The policy:

- removes session-only values from restored checkpoints, including checkpoints written by older versions;
- removes session-only patches from recovery-journal records;
- omits journal records that contain only session UI changes;
- removes session-only values from new checkpoints and recovery points.

The live store and transaction rules do not change. Session-only state remains typed, owner-scoped, observable and available for undo-independent interaction during the current page lifetime. Only the durable recovery projection is filtered.

Built-in session-only state includes panel visibility and geometry, editor panes and dock size, selection, canvas camera/tool, internal clipboard, annotation popups, command and diagnostic panels, group-membership UI and runtime writing metrics. Mixed namespaces keep functional settings while filtering only their UI keys: palette preferences, shortcut overrides, AI session settings and Prompt templates continue to persist, while their open state, assistant window records and window geometry do not.

Document namespaces are unaffected. Nodes, titles, bodies, colors, connections, groups, annotations, AI transcripts and saved memories still enter recovery and project persistence according to their existing owners. Portable `.echo8` files remain document-only and their format does not change.

When saving a read-only cloud book fails, the file owner defers the public `cloudSync.open` command before reporting the takeover-required error. The cloud owner therefore opens its governed property surface through the normal right-surface arbitration path, exposing the existing `cloudSync.takeover` action without coupling the file plugin to cloud UI implementation. That panel opening is runtime state and is not restored after a browser refresh.

## Consequences

- Refresh starts with a clean interface instead of reconstructing prior panels and sizes.
- Recovery still protects book data and durable personal preferences.
- Plugins must explicitly classify new workspace UI state; the plugin manager rejects declarations for namespaces the plugin does not own or for non-workspace namespaces.
- The recovery schema and `.echo8` file format do not need a migration. Old persisted UI values are discarded during hydration.

## Verification

Unit tests cover mixed and fully session-only namespaces, old-checkpoint scrubbing, mixed journal filtering and omission of UI-only journal records. Kernel contract tests verify that a read-only cloud save queues the public cloud-panel command. Browser regression reloads with open AI/search/editor surfaces and confirms that they close while connection data and palette preferences survive; a mocked read-only cloud project confirms that the failure notice is followed by the visible takeover panel.
