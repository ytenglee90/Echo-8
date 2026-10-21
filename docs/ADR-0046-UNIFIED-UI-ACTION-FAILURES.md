# ADR-0046: User-triggered command failures are reported once by the kernel

## Context

Many views intentionally ignore rejected promises after a click because the component has no useful local recovery action. Treating every `.catch` as a missing user message would duplicate notices for commands, turn cancellation and cleanup into false errors, and make each plugin invent its own wording.

## Decision

Every `ViewClient.dispatch` passes through the kernel. A rejected user command emits the content-safe `system.ui.action.failed` signal before the promise is returned to the component. The shell owns one highest-layer action notice, while diagnostics retain the originating owner and command without echoing arbitrary document or secret payloads. A component may still catch the returned promise to avoid an unhandled rejection; that does not suppress the kernel notice.

Native picker cancellation, abort signals, best-effort resource cleanup, optional diagnostic probes and superseded previews are not command failures and may end silently. Plugin-internal background failures continue through task status or their explicit feature status rather than manufacturing a second global alert.

## Consequences

- Buttons, menus, shortcuts and command-panel actions share one visible failure path.
- Feature plugins do not gain a shell dependency or duplicate toast components.
- Sensitive request content is not copied into the user notice.
- New UI operations must use their governed view client; direct store mutation or unmanaged command invocation remains forbidden.
