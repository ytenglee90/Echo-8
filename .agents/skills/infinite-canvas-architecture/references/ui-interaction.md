# UI and Interaction Contract

## Three UI layers

```text
UI foundation (mandatory system service)
  design tokens | reusable components | overlays/windows | focus/keyboard
  animation | render scheduling | accessibility primitives

replaceable application shell
  top toolbar | left tools | canvas host | right editor dock | bottom status
  modal host | command palette

feature contributions
  buttons | menus | panels | shortcuts | canvas layers | status items
```

Plugins declare contributions; they do not append arbitrary global DOM or decide product-wide styling.

## Slots

Provide named, governed slots for:

- top primary toolbar and contextual toolbar;
- left tool rail;
- right primary panel, editor tabs, and editor format bar;
- bottom status bar;
- node title, body preview, and connection handles;
- canvas background, content, connections, selection, and overlay layers;
- floating layer, context menu, command palette, settings, modal dialogs;
- welcome, empty, loading, recovery, and error states.

Each slot defines allowed component kinds, ordering, capacity, overflow behavior, focus rules, and cleanup. Contributions declare stable ID, label, icon, command, priority, visibility condition, enabled condition, permission, and accessibility text. Visibility conditions read approved selectors; they do not execute arbitrary plugin code during every frame.

## Design language

Use a restrained Apple-influenced language without copying a specific Apple screen:

- system typography, clear spacing, thin low-contrast borders, light shadows, consistent radii;
- predominantly black, white, and gray with limited semantic colors;
- high-contrast selection, red only for necessary danger, one restrained optional AI accent;
- approximately 8–10 px control radii and 12–16 px panel radii as tokens, not hard-coded plugin values;
- flat toolbars, no excessive glass, thick borders, large gradients, or uncontrolled saturation;
- short, quiet motion that respects reduced-motion settings.

Themes are token sets. Light/dark switching and the user's palette operate on semantic tokens. Plugins request tokens such as surface, border, text, selection, danger, and AI accent; they do not hard-code product colors unless representing user content.

## UI state boundaries

Keep open panels, editor widths, focus, hover, menus, lasso, and drag previews out of document undo. Personal layout may persist in a separate preferences store. Stable node position, group relation, connection, content, document color, and completed replacement are durable and undoable.

## Interaction state machine

Define legal transitions for at least idle, panning, lasso selection, dragging nodes, resizing, creating a connection, editing a title, editing body text, resizing the dock, modal interaction, and immersive writing. The arbiter prevents illegal combinations such as starting lasso while creating a connection. Pointer capture, cancellation, Escape behavior, focus return, and transaction commit/cancel behavior must be explicit.

## Focus, keyboard, overlays, and conflicts

- One keyboard manager owns global shortcuts and resolves conflicts before registration.
- Do not trigger canvas shortcuts while an editor or input method owns the keystroke unless the shortcut is explicitly safe.
- One overlay manager owns stacking, modality, outside-click handling, focus traps, Escape order, and focus restoration. Plugins cannot invent global `z-index` values.
- The contextual toolbar changes by selection capability: text-node tools, connection tools, group tools, or mixed-selection tools. Do not crowd the primary toolbar with every plugin action.
- The command palette indexes registered actions and their current availability; plugins do not modify its implementation.

## Editors

- The right dock supports up to three simultaneously open text-node views. Define a clear policy when a fourth is requested, such as prompting to replace the least recently focused unpinned pane.
- The dock and, where useful, pane allocation resize through ephemeral previews and save the final personal-layout value on release.
- Views share an authoritative text buffer and independent selection/scroll view state.
- The toolbar can apply whole-document, paragraph, or selection formatting according to the content model.
- Show total count, selection count, active writing time, and declared speed measures.
- Immersive mode hides application chrome and requests the browser Fullscreen API only after a user gesture. Do not promise suppression of operating-system UI or the browser's guaranteed Escape exit.

## Accessibility and input

- Every icon action has an accessible name and visible tooltip or discoverable label.
- Major operations are keyboard reachable; focus is clearly visible and restored predictably.
- Do not communicate state by color alone. Maintain contrast in light/dark/custom themes.
- Support text zoom, reduced motion, screen-reader landmarks where DOM views exist, and keyboard-configurable shortcuts.
- Treat Chinese IME composition as a first-class editing state. Test emoji, grapheme clusters, mixed scripts, line endings, paste, and selection counting.
- Canvas-only visuals need accessible DOM summaries or navigable alternatives for important content and actions.

## Style isolation

Scope built-in plugin styles to their registered UI roots and use design tokens. Unknown external plugins must eventually render in an isolated environment. Never claim CSS conventions alone are a security boundary.
