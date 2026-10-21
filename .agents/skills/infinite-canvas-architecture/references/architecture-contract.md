# Architecture Contract

## Product target

The product is a general-purpose infinite canvas, not a writing-only tool. It must support text nodes, left/right connections, groups, three simultaneous editor panes, find/replace, statistics, writing metrics, palette and themes, clipboard operations, selection variants, focus, pan/zoom, save/open/autosave, import/export, global linear undo/redo, and a context-retrieving AI assistant. Design extension points for later content types such as tables, image descriptions, web excerpts, and audio transcripts.

Performance targets are 2,000-plus ordinary nodes on one canvas, smooth group movement/pan/zoom through visibility culling and level of detail, and isolated very large text nodes up to the stated 20-million-character class through chunking and virtualization. Do not interpret this as permission to hold 2,000 maximum-size documents in memory simultaneously.

## Layers

```text
headless microkernel
  plugin lifecycle | message routing | capability registry | transaction boundary | resource permissions

mandatory system services
  store | history | persistence | migration | UI runtime | task scheduler | diagnostics | conflict arbiter

replaceable application shell
  top bar | left tools | canvas host | right editor dock | status bar | command palette | modal host

feature plugins
  canvas | text node | connection | group | editor | search/replace | statistics | palette
  AI assistant | import/export | shortcuts | autosave contributions
```

Mandatory services are not runtime-removable, but remain code-separated from the microkernel so headless tests and future shell replacement do not require rewriting product logic.

## Ownership rules

- The microkernel coordinates; it contains no text-node, connection, group, search, AI, palette, or product-toolbar logic.
- The shell lays out named UI slots; it contains no feature decisions or durable document writes.
- A feature lives in one owning plugin. Shared behavior becomes a narrowly defined system service or versioned capability, not copied cross-plugin code.
- Plugins receive scoped contexts. Do not expose the application singleton, raw store, unrestricted DOM root, worker constructor, or file handles.
- Capability consumers depend on semantic abilities such as `content.read@1`, `content.search@1`, `canvas.layer@2`, or `history.transaction@1`, never on a provider's internal class.
- Public contracts use schemas and versions. Internal implementations may change without consumers changing.

## Store domains

Keep four kinds of state distinct:

1. **Durable document state:** nodes, stable positions, text blocks and marks, groups, connections, document colors, canvas background, completed replacements, plugin-owned document records.
2. **Personal workspace state:** editor-dock width, open panes, preferred theme, palette presets, shortcut choices. Save separately; do not include in document undo.
3. **Ephemeral interaction state:** hover, lasso rectangle, drag preview, resize preview, temporary connection, open menu, focus, composition state. Never persist or put in global history.
4. **Rebuildable derived state:** previews, word counts, group bounds, routed line paths, visibility lists, search indexes, AI retrieval summaries. Cache by revision and rebuild after corruption or incompatible change.

Use namespaces such as `core.document`, `core.viewport`, `plugins.textNode`, and `plugins.connections`. A plugin writes only its namespace through registered reducers or standard patches. Cross-domain mutations require a core transaction coordinating owning reducers.

## Identity and integrity

- Give every persistent entity a stable globally unique ID. Copy creates new IDs; undo restoration restores original IDs.
- References use IDs plus, when relevant, content revision. Never rely on array position, visible title, or DOM identity.
- Define deletion semantics and referential integrity for each entity. Use transaction-local tombstones so connections, groups, AI citations, and history can resolve deletion consistently.
- Preserve opaque unknown-plugin records when their plugin is unavailable.
- Validate invariants at commit: unique IDs, valid ownership, legal group membership, valid connection endpoints, schema compatibility, and revision preconditions.
- Derived data cannot become the only copy of user content.

## Feature plugin map

Start these as registered shells, but prove the architecture with at least one real vertical text-node path:

- infinite canvas and camera;
- text nodes and title/body preview;
- connections;
- groups;
- multi-pane text editor;
- find and replace;
- statistics and writing metrics;
- palette and theme contributions;
- AI assistant and transcript memory;
- import/export;
- shortcuts and command-palette contributions;
- autosave UI and recovery contributions.

Do not create gratuitous micro-plugins. Split a feature when it has an independent lifecycle, permissions, data ownership, capability contract, or replacement value.

## Architecture records

For material decisions, maintain a short decision record containing the problem, chosen contract, alternatives rejected, compatibility impact, migration, and tests. Treat exceptions as versioned decisions, never undocumented shortcuts.
