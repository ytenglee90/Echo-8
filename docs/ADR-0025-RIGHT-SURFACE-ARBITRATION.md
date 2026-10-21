# ADR-0025: Core arbitration for the editor and right-side panels

## Status

Accepted.

## Problem

The editor dock and `right.primary` panels share the right side of the shell. A panel could remain the active governed surface after `editor.open` committed, causing CSS layout policy to keep a successfully opened editor hidden. Closing only the palette from a palette-owned listener fixed one panel but copied cross-feature coordination and left file, plugin, shortcut and diagnostic panels inconsistent.

## Decision

The mandatory UI layer owns a `UISurfaceArbiter`. Feature commands that commit an intent to reveal governed UI publish the version-one `system.ui.surface.revealed` event with a named slot. The arbiter applies its central conflict table. Revealing `right.editor` conflicts with the currently active `right.primary` surface.

The arbiter never changes another plugin's workspace namespace and never imports a feature. It reads the active surface registration, then queues that surface owner's declared public close command through the normal router with the reveal event as causation. The close command performs the owner's workspace transaction and surface cleanup on the next serialized dispatch turn. A right-side surface without a public close command cannot be silently mutated and is reported through diagnostics.

`editor.open` publishes the reveal fact for a newly opened pane, an already-open pane activated by double-click, and the fourth-pane replacement prompt. `editor.replacePane` publishes it again when replacement commits. Individual right-panel plugins therefore contain no editor-specific listeners, and future `right.primary` panels automatically follow the same rule when they register a close command.

## Compatibility

Only personal workspace UI state changes. Document data, history, persistence format and `.echo8` files are unchanged. Existing right-side panels already register public close commands, so no migration is required.

## Verification

Contract tests open both the global-color panel and an unrelated plugin-center surface, dispatch `editor.open`, then verify that each owner closes its own workspace state and releases `right.primary`. The complete contract suite continues to verify exclusive-surface stacking, hot-stop cleanup and declared command routing.
