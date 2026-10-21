# ADR-0032: Plugin auto-start is dependency ordered

## Status

Accepted.

## Context

Plugin manifests already declared required plugins and capabilities, but automatic startup iterated the registration map. The built-in array happened to place providers first. Reordering files, adding lazy plugins or loading external plugins could therefore turn a valid dependency set into a startup failure. Direct explicit dependency cycles were also reported only indirectly as inactive prerequisites.

## Decision

The plugin manager computes an automatic start plan from current manifests, active plugins and already available capabilities. A plugin becomes ready only after:

- every explicit required plugin is active in the proposed order;
- every required capability has been registered by an active provider.

Ready plugins retain deterministic registration order, but registration order no longer overrides dependency readiness. If no plugin can progress, the resolver reports missing plugins, disabled dependencies, missing capability providers, or the providers still involved in the unresolved chain.

Explicit plugin cycles are detected whenever registration closes a cycle. The newly registered plugin and its namespace ownership claims are rolled back immediately. Self-dependency is invalid manifest data. Optional dependencies and optional capabilities appear in manifests but never block activation or create mandatory graph edges.

Manual `start(id)` still requires its declared prerequisites to be active. It reports registered inactive capability providers explicitly instead of silently enabling unrelated plugins. This preserves user control in the plugin center.

## Consequences

- Built-in and future lazy plugin startup is independent of array order.
- Alternative capability providers can satisfy a consumer; the resolver waits for actual capability availability instead of binding the consumer to one implementation.
- Mandatory cycles and missing providers fail before partial consumer startup.
- Hot stop remains guarded by the existing reverse dependency and last-required-capability checks.
- A future diagnostic graph view can consume `planAutoStart` without duplicating ordering logic.
