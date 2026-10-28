# ADR-0078: Selection-scoped object appearance

## Status

Accepted. This supplements ADR-0005, ADR-0017, ADR-0019, ADR-0060 and ADR-0065.

## Context

The global-color panel intentionally changes application or document defaults, while canvas work also needs a fast way to recolor one selected object. The previous text-node title button exposed one special-case picker inside every card, did not cover connections, groups or annotations, and made the title bar visually heavier. A connection also has three independently meaningful paint parts: its curve, label frame and label text.

## Decision

The palette plugin contributes one icon-only `appearance` toolbar group immediately before the clipboard group. Its separator remains shell-owned. Clicking **修改选中项颜色** or pressing `P` resolves the current selection through public capabilities and opens the existing governed color-picker surface at the selected object's screen bounds. The per-node title color button is removed. `Mod+Shift+C` and the global-color panel retain their existing global/default behavior.

`SelectionItem` gains an optional `part` discriminator. It does not create a second durable identity: connection curve, label background and label text all keep the connection ID, while `line`, `label-background` and `label-text` identify the directly selected paint part. Delete, copy and other whole-object operations continue to resolve by the durable connection ID. Selection restoration after history changes preserves a part only while the current catalog still declares it.

`appearance.read@1` accepts `mode: 'global' | 'selection'`, resolved selection items and global fallback defaults. In selection mode each owner returns only the requested object or part, including its effective inherited color, revision and optional screen anchor. The palette owns no document color data and never imports an owner's namespace. It emits `appearance.color.preview` while scrubbing, then asks `appearance.updatePlan@1` providers for revision-checked patches and commits one global-history transaction. ADR-0079 later replaces this ADR's original single-kind selection restriction with a batched, cross-kind preview and commit contract.

Durable ownership is:

- `text-node`: each node's existing `titleColor`; text-box presentation uses the same field.
- `connections`: optional `lineColor`, `labelBackgroundColor` and `labelTextColor` on each connection record; absence inherits the existing global connection/canvas colors.
- `groups`: optional `color` on each group record; absence inherits the personal global group preference.
- `annotations`: optional `color` on each annotation record; absence inherits the personal global annotation preference.

Local overrides affect only the selected record. They do not rewrite the palette's workspace preferences, other records of the same kind, or the global `connectionAppearance` record. Rendering applies previews without store writes, autosave work or history entries. Apply creates one undoable transaction; Cancel, surface close and plugin stop clear the preview.

## Compatibility and migration

The project-container version does not change. The `connections` plugin data version advances from 5 to 6, while `groups` and `annotations` advance from 1 to 2. Their migrations deliberately preserve old namespace payloads unchanged because every new color field is optional. An old record therefore opens with exactly its former global-derived appearance and acquires a local field only after an explicit selection-scoped color commit. Clipboard and project validators accept the optional fields and retain them when present.

## Consequences

- The toolbar has one consistent, icon-first local color entry instead of a text-node-only control.
- Connection label frame and text can be styled independently without splitting a connection into separate entities.
- Global settings remain useful as inherited defaults and do not silently overwrite local intent.
- Appearance providers must report effective colors and validate owner revisions, so stale picker sessions cannot overwrite newer edits.

## Verification

Contract tests cover the `P` shortcut, single-node isolation, one-step undo, independent connection curve/label-frame/label-text persistence, selection-part retention through history, group and annotation overrides, unchanged global preferences and all three compatibility migrations. Chromium verifies toolbar order and separator, removal of the node-local picker, selected-object anchoring, live preview, isolation from an unselected node and undo restoration. Type checking, linting, the complete contract suite, browser suite and portable-build suite remain release gates.
