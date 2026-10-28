# ADR-0079: Mixed appearance updates, color catalog and reset

## Status

Accepted. This supplements ADR-0005 and ADR-0078 and replaces ADR-0078's restriction that a selection-scoped picker may contain only one appearance kind.

## Context

The selection color picker originally accepted one owner and one appearance kind. That prevented a user from applying one color to a mixed selection such as a text node, connection and group. Its color records were also reconstructed mostly from text summaries, so local connection, group, annotation and range-format colors could be absent. The global-color panel had no owner-safe way to restore document and personal colors to product defaults.

## Decision

`appearance.color.preview` keeps its legacy singular target fields and adds an optional `targets` array. A mixed selection publishes one shared preview color with one target entry per appearance kind. On commit, the palette sends every revision-checked request through `appearance.updatePlan@1`, waits for every owner plan, and combines all document patches into one transaction and one undo step. A stale target rejects the complete operation before any patch is applied.

Appearance owners additionally expose two optional versioned capabilities:

- `appearance.colors@1` returns bounded, rebuildable `{ color, count }` records for colors the owner currently renders. Text nodes include title, document-format and range-mark colors; connections include global and object-level line/label colors; canvas, groups and annotations report their effective colors.
- `appearance.resetPlan@1` returns standard owner-labelled document patches that remove local overrides and restore intrinsic defaults. The palette combines these plans into the undoable `palette.resetAppearance` command and never reads or writes another owner's namespace.

The global-color panel places an icon-only Reset action beside Close. One click runs the document reset and then restores palette-owned personal workspace preferences to the built-in light defaults. These remain two explicit transactions because core forbids mixing document patches with personal-workspace patches: the document portion enters global history, while personal chrome preferences continue to use `history: false` as required by ADR-0005.

A connection with a chosen local color renders that exact picker RGB value rather
than applying the automatic global-line contrast correction. Hover, keyboard
focus and selection retain the same color and use one bounded stroke-width cue;
they do not add a drop-shadow filter or substitute the canvas selection color.
This keeps pale and saturated object colors consistent with other recolored
modules while avoiding the blurred halo shown during color editing. Automatic
and global inherited connection colors retain their existing adaptive contrast.

## Compatibility and migration

The singular preview fields remain valid, so existing picker and editor producers do not require migration. The new capabilities are optional and contain no durable state. Reset deletes optional override records or fields and writes existing schemas only. Project-container and plugin data versions therefore do not change.

## Consequences

- One palette commit can recolor different selected module kinds uniformly, render the same chosen RGB value on each kind and undo them together.
- The picker records colors from every active appearance owner instead of inferring them from node summaries.
- Reset remains ownership-safe, revision-independent at the UI boundary and undoable for document appearance.
- Personal interface colors intentionally do not enter document history or travel with the canvas.

## Verification

Contract tests cover mixed node/connection/group updates, one-step undo, cross-owner color records, reset of global and local connection colors, node titles, document and range text colors, groups and annotations, personal preference defaults, and undo restoration. Browser tests cover the Reset control restoring canvas and toolbar defaults and a locally colored connection retaining the exact picker color in its ordinary, hovered and selected states without a shadow. Type checking, linting, full contract, browser and portable-build suites remain release gates.
