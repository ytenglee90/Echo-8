# ADR-0027: Overflow strips and live shortcut presentation

## Decision

Horizontally overflowing application tool strips remain owned by the UI foundation. The primary navigation bar and every editor format strip translate an ordinary wheel gesture into bounded horizontal movement only while that strip actually overflows. Trackpad horizontal deltas are preserved, browser zoom gestures are not intercepted, and scrolling remains transient UI state outside transactions, history, and project persistence.

Toolbar shortcut text is no longer authoritative plugin prose. The keyboard manager remains the single source of the effective shortcut after conflict arbitration, user override, or explicit clearing. Declarative toolbar buttons resolve their current hint in the shell. Stateful plugin toolbar views may synchronously read only the effective shortcuts owned by their own plugin through the scoped `ViewClient` and use the shared UI presentation helper. Clearing a shortcut removes the stale suffix instead of restoring a hard-coded default label.

## Plugin placement

Automatic arrangement stays inside the independently stoppable `smart-layout` built-in plugin together with smart guides and snapping. It is registered in the built-in plugin catalog and therefore appears in Plugin Center. Stopping that plugin removes its capability, command, button, command-palette action, and shortcut without changing canvas core behavior.
