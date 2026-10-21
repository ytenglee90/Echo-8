# Plugin and Capability Contract

## Manifest

Each plugin declares at least:

```javascript
{
  id: "text-node",
  name: "文本节点",
  version: "1.0.0",
  apiVersion: "1",
  dependencies: [],
  optionalDependencies: ["connections"],
  requiresCapabilities: ["canvas.layer@2"],
  providesCapabilities: ["content.read@1", "content.search@1"],
  permissions: ["store.own.read", "store.own.write", "ui.canvas.contribute"],
  commands: [], events: [], queries: [], reducers: [],
  ui: [], shortcuts: [], migrations: [],
  install() {}, start() {}, pause() {}, stop() {}, uninstall() {}
}
```

Validate IDs, versions, dependencies, permissions, schemas, capability compatibility, command names, shortcuts, and UI slots before activation. Duplicate ownership or unresolved mandatory dependencies fail activation without damaging the document.

## Scoped context

Construct a least-privilege context from the manifest. Typical facades are:

- `commands.dispatch` for ordinary queued requests made by UI, tasks and post-commit observers;
- `commands.invoke` only for a declared child/alias that must complete inside the active formal command turn;
- `commands.defer` for a declared follow-up that must run after the active turn and must not be awaited;
- `events.subscribe` for committed facts;
- `queries.ask` for read-only request/response;
- `capabilities.request` for versioned semantic services;
- `ui.contribute` for declarative UI;
- `resources` for owned listeners, timers, tasks, workers, object URLs, caches, and file leases;
- `transactions.propose` for registered durable changes;
- `diagnostics` for structured health and error reporting.

Every returned subscription, contribution, lease, or task is tagged with the plugin ID so the kernel can clean it even if plugin cleanup throws.

## Capability design

- Depend on abilities, not implementations.
- Keep contracts small and versioned. Add a new version rather than changing behavior underneath consumers.
- Make potentially slow capabilities asynchronous and accept an `AbortSignal` or equivalent cancellation token.
- Large-content capabilities return ranges, cursors, async iterators, or streams. They include source revision and stable offsets or anchors.
- Queries are read-only. A capability that mutates must dispatch a command or return a proposed transaction; it cannot secretly write.
- When several providers satisfy a capability, the conflict arbiter applies an explicit user choice, configured priority, or deterministic default. Never use activation race order.
- A provider disappearing produces a typed unavailable result. Consumers degrade gracefully and do not reach into retained plugin data.

## Lifecycle and hot disable/enable

Use these transitions:

```text
discovered -> validated -> installed -> starting -> active
active -> pausing -> paused -> stopping -> stopped
stopped -> starting
stopped -> uninstalling -> removed
any transition failure -> faulted
```

To stop a plugin:

1. Reject new commands and capability calls addressed to it.
2. Cancel queued cancellable work.
3. Wait for the current atomic transaction, or roll it back at its boundary.
4. Remove UI, keyboard, menu, layer, and command-palette contributions.
5. Unregister handlers and capabilities.
6. Release listeners, timers, workers, file leases, caches, and temporary objects.
7. Preserve plugin state by default as opaque versioned data.
8. Verify no owned resource remains and publish the lifecycle event.

Do not force-unplug midway through a durable write. Fault containment can catch ordinary exceptions and roll back registered work, but do not claim complete isolation from infinite loops, out-of-memory failures, or hostile same-realm code.

## Fault handling

- Execute plugin callbacks behind error boundaries with timeout or yield rules where applicable.
- Tag errors with plugin, message, transaction, entity, and revision IDs without exposing secrets.
- Roll back uncommitted standard patches.
- Mark the plugin faulted, release resources, keep unrelated plugins active, and offer a controlled restart.
- Never allow an error panel itself to depend on the failed plugin.

## External plugins

Version one supports built-in plugins that are packaged with the application and can be enabled or disabled. Reserve an external-plugin protocol, but do not load arbitrary JavaScript into the main realm. Future untrusted plugins require isolation, permission review, message-only access, resource quotas, and a signing or provenance policy.
