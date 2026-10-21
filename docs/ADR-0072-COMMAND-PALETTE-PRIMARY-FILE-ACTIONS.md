# ADR-0072: Command palette owns primary file actions

## Status

Accepted — 2026-10-16. Supplements ADR-0046, ADR-0038, ADR-0070 and
ADR-0071.

## Context

Return to Library, Save, Save As and Open are available through the shared
command palette and shortcuts. Keeping a second permanent copy of all four in
the toolbar crowds the primary editing surface without adding capability.

Open also needs to preserve the existing dirty-document decision, native file
handle support and browser fallback without moving that workflow into a UI
component.

## Decision

- The command palette's File group begins with Return to Home (Library), Save,
  Save Local Copy As and Open, in that order. Stable priorities `-400`, `-300`,
  `-200` and `-100` enforce the order before the remaining file settings.
- Their toolbar contributions are removed. Cloud status remains the first item,
  followed by the command-palette launcher.
- `file.chooseOpenProject` is a typed public command. It first delegates to the
  existing dirty-document decision command, then uses the native picker when
  available. Browsers without that API activate the governed overlay host so a
  second explicit user gesture can open the fallback file input.
- `mod+s` and `mod+o` continue to invoke Save and Open directly. The Book and
  Recovery panel remains available as a separate command-palette action.
- The book-library welcome surface is already an explicit switching context.
  Its local Open action uses the typed `file.openProjectFromLibrary` command,
  skips the in-canvas dirty-book prompt, and relies on the core's mandatory
  pre-replacement recovery point. Entering the library cancels any stale pending
  file-open prompt.
- Plugins expose these entries through registered actions and commands; the
  command palette does not import plugin-owned UI or state.

## Consequences

- The primary toolbar is quieter while all file operations remain
  keyboard-accessible and searchable.
- Save keeps its cloud-first meaning for an active cloud book; Save As remains a
  local `.echo8` copy.
- Dirty-document arbitration remains unchanged for canvas, command-palette,
  panel and drop flows. Book-library switching deliberately avoids a duplicate
  confirmation while preserving recovery.
- No cloud schema, Worker version or project file format changes are required.

## Verification

- Browser workflows assert the exact leading File action order and absence of
  the four redundant toolbar controls.
- Book-library workflows verify New and Open never activate the in-canvas dirty
  prompt; kernel tests verify direct library Open still creates a recovery point.
- Native-picker, fallback-picker and dirty-document open workflows continue to
  run through the typed command path.
- Type, lint, architecture, unit, build and browser checks cover the change.
