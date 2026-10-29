# ADR-0025: Core arbitration for the editor and right-side panels

## Status

Accepted.

## Problem

The editor dock and `right.primary` panels share the right side of the shell. A panel could remain the active governed surface after `editor.open` committed, causing CSS layout policy to keep a successfully opened editor hidden. The reverse direction was also inconsistent: opening a property panel hid the editor without closing its panes, and opening one property panel could leave an older panel stacked underneath. Closing only the palette from a palette-owned listener fixed one entry path but copied cross-feature coordination and left file, cloud, plugin, shortcut and diagnostic panels inconsistent.

## Decision

The mandatory UI layer owns a `UISurfaceArbiter`. Feature commands that commit an intent to reveal governed UI publish the version-one `system.ui.surface.revealed` event with the slot, owner and contribution identity. The arbiter applies its central conflict table. Revealing `right.editor` conflicts with the active `right.primary` surface; revealing `right.primary` conflicts with `right.editor` or the previously active `right.primary` surface. The newly revealed contribution is excluded from arbitration, so it cannot close itself.

The arbiter never changes another plugin's workspace namespace and never imports a feature. It reads the active surface registration, then queues that surface owner's declared public yield command through the normal router with the reveal event as causation. A surface may declare a distinct ordinary close command and yield command: Escape can close only the active editor pane while right-side replacement uses `editor.closeAll` to release the whole dock. If no yield command is declared, the ordinary close command is used. The owner performs its workspace transaction and surface cleanup on the next serialized dispatch turn. A right-side surface without either command cannot be silently mutated and is reported through diagnostics.

`editor.open` defaults to `mode: 'replace'`: ordinary double-clicks and other normal entry points leave only the requested pane in the dock. Canvas Shift+double-click dispatches `mode: 'add'`, preserving the existing maximum of three panes and the explicit fourth-pane replacement prompt. `editor.open` publishes the reveal fact for both modes, and `editor.replacePane` publishes it again when replacement commits. Every built-in `right.primary` open command publishes the same generic fact. Individual panels therefore contain no editor-specific listeners, and future right-side surfaces participate by registering close/yield commands and publishing their committed reveal identity.

## Compatibility

Only personal workspace UI state changes. Document data, history, persistence format and `.echo8` files are unchanged. Existing `editor.open` callers that omit `mode` adopt the ordinary replacement behavior; explicit additive callers use `mode: 'add'`. Existing right-side panels already register public close commands, so no stored-data migration is required.

## Verification

Contract tests cover ordinary replacement, explicit additive panes, the three-pane limit, property-to-property replacement, editor-to-property replacement, property-to-editor replacement and distinct close/yield commands. Browser tests exercise ordinary double-click, Shift+double-click and both directions of editor/property-panel arbitration. The complete contract suite continues to verify exclusive-surface stacking, hot-stop cleanup and declared command routing.
