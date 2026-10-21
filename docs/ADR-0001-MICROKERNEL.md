# ADR-0001: Headless microkernel with governed plugin runtime

## Status

Accepted for the first architecture stage.

## Decision

Use a small headless kernel for message routing, capability discovery, transaction coordination, plugin lifecycle and resource ownership. Keep store, history, persistence, UI runtime, task scheduling, interaction arbitration and diagnostics as mandatory but code-separated services. Implement product behavior as built-in plugins that can be stopped and restarted at runtime.

All user operations begin as a message. Commands request work, events report committed facts, queries are read-only, ephemeral signals carry high-frequency previews, and task messages represent cancellable background work.

## Consequences

- Adding or removing an optional feature does not require editing the kernel or shell.
- History remains linear across plugins because durable writes share one transaction boundary and standard patches.
- UI remains visually coherent because plugins contribute declarations into governed slots.
- Hot disable can be measured by owned-resource cleanup and retained data.
- Plugin manifests declare both provided and consumed messages; declarations are enforced for background logic and UI view clients.
- Namespace ownership is enforced at the durable transaction boundary, including multi-provider deletion plans.
- Headless plugin models remain testable without loading the React shell.
- Third-party hostile-code isolation is not claimed; external plugins remain reserved for a later sandboxed protocol.
- Public capability and file schemas must be versioned and migrated rather than changed silently.
