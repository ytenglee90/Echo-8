# ADR-0005: Semantic themes and owner-planned appearance changes

## Status

Accepted for the palette and theme slice.

## Decision

The UI runtime is the only theme registry. A theme is a complete, version-one set of semantic tokens such as surface, panel, ink, canvas, node surface, editor paper, editor chrome and selection. Plugins register and activate themes only through their scoped UI context. The shell translates the active tokens into CSS custom properties; feature plugins do not write global CSS variables or manipulate shell DOM.

The palette supplies built-in light and dark definitions for compatibility, but the global-color panel exposes canvas background, connection curve, group background, editor writing background, editor-chrome background, navigation background and annotation marker color. Editor, group, annotation and navigation colors are personal workspace state, use `history: false`, and do not travel through document undo. Canvas background and connection curve color are document appearance owned by their feature plugins and participate in global history. The group preference stores one opaque source color; the group view applies a consistent translucent mix, with a stronger mix for selection, so users do not have to manage alpha values. The editor writing override is applied to both the dock and writing paper. The UI runtime derives `--editor-paper-ink` from the actual writing-paper luminance; ordinary default正文 and the caret use that black/white pole, while an explicitly chosen document or range text color remains user content and is not silently rewritten. One editor-chrome token controls the title, formatting and metrics/status bars. Their ink, dividers, hover surfaces and selected controls—as well as the equivalent navigation values—are derived centrally from their respective backgrounds; individual editor or toolbar controls do not choose their own contrast colors. When the palette stops, resource cleanup unregisters both themes and the UI runtime restores its core light fallback. Restart reads the preserved workspace preference and activates it again.

The panel also exposes three implementation-owned presets: A 明调, B 暗调 and C 护眼. A preset reuses the existing typed `palette.setPreferences` and `palette.applyAppearance` operations instead of introducing another stored theme schema. Workspace colors remain personal and history-free; the canvas background remains a canvas-owned document change with normal undo. The preset has no hidden identity in persistence: its selected state is derived from the current colors, so any later manual adjustment simply becomes a custom combination.

## Appearance ownership

- `canvas` owns durable canvas background in `canvasAppearance`.
- `connections` owns the optional durable connection curve source color in `connectionAppearance`.
- `text-node` owns title color in `textNode` and body color in `textFormat`.
- `palette` owns no document appearance data.

The palette resolves current selection and active editor through optional capabilities, then asks all `appearance.read@1` providers for public target descriptions. Each target contains entity IDs, expected colors and owner revisions. On Apply, all `appearance.updatePlan@1` providers validate those references before returning standard owner-labelled patches. The palette combines the plans into one transaction. A stale entity rejects the whole command before any write, and plugin-private namespaces remain private.

## Preview and invalidation policy

Changing a color input broadcasts `appearance.color.preview`. Canvas, connection and editor views render the coalesced value without store writes, autosave work or history entries. Apply or Cancel broadcasts a clear preview; Apply creates exactly one durable transaction regardless of selected-node count. A configured connection source color is retained whenever it already meets 3:1 non-text contrast against the actual canvas background; otherwise the connection view shifts it toward the stronger black/white pole only as far as needed. With no stored override, connections keep the original fully automatic canvas-derived line color.

Personal editor-writing, editor-chrome and navigation previews use `palette.preferences.preview` and are cleared on apply, cancel, panel close and plugin stop. The palette has no editor-specific close listener. Right-side ownership changes are handled by the mandatory UI surface arbiter described in ADR-0025, so the editor never calls palette implementation code or mutates palette state directly.

Canvas foreground feedback is derived from the actual document canvas color, including an active color preview. The shared calculation chooses the stronger black/white pole, generates ordinary strokes at a minimum 3:1 contrast ratio, and supplies stronger selection plus translucent fill tokens. Canvas, connection and group views obtain the background only through `canvas.appearance@1` and declared appearance signals; no feature reaches into another plugin's DOM or state.

Text-box presentation uses the canvas host's rendered document-background token as its fill. It therefore follows canvas-background preview, commit, undo, redo and fallback without storing a second color or reading canvas-owned document state from the text plugin.

The palette does not subscribe to the global workspace revision while open. Selection and active-editor changes arrive as committed events and are translated to `palette.targets.invalidated`, avoiding appearance rereads for unrelated writing-metric and layout updates.

## Compatibility

Existing documents without `canvasAppearance` read the default background at revision zero; the first change creates the record. Connections data migrates from version 3 to 4 by adding an empty `connectionAppearance` namespace; an absent record means automatic color and the first explicit choice creates revision one. Existing palette workspace state without `toolbarBackground`, `editorChromeBackground` or `groupBackground` is normalized to the corresponding built-in theme color. Existing text nodes already have a title color, and missing `textFormat` records retain the documented default-format fallback. The decorative dot-grid layer is no longer rendered; the durable canvas background is shown as a flat color. The project-container format version does not increase.

## Verification

Contract tests cover workspace-only editor-writing/editor-chrome/navigation colors, derived contrast, all three preset definitions, canvas stroke contrast across light/dark/middle/saturated colors, custom connection-color contrast correction, theme cleanup and restart, editor-open panel arbitration, owner-planned title and connection-color changes, single history entries, undo/redo, save and reopen. Chromium verifies live connection preview and the rendered curve color. The general architecture suite continues to enforce feature import boundaries, managed persistence and hot-stop resource cleanup.
