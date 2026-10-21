# ADR-0021: Canvas node detail level of detail

## Status

Accepted for the current DOM/SVG renderer.

## Problem

Spatial culling already prevents all canvas nodes from being mounted, but a distant zoom can still leave many visible cards. Mounting a正文 preview element for every one of those cards spends DOM, style and paint work on text that is too small to read. Replacing the renderer with WebGL before profiling would increase accessibility, text layout, hit-testing and portable-build risk.

## Decision

Node rendering has a pure view-only level-of-detail rule. At zoom values below `0.5`, a visible node becomes one flat title tile: the complete card uses that node's current title-bar color and mounts only its title in a large, bold, centered, automatically contrasted treatment. The ordinary header, type dot, color button, count,正文 preview and visible resize handle are not mounted. Transparent connection hit regions remain available. At `0.5` and above, the complete header, bounded preview and resize handle are mounted normally. Selection, dragging, connection geometry, keyboard focus, node identity, document data, broadcasts and history do not change.

ADR-0066 adds a deliberate exception for the durable `text-box` presentation. A text box remains the same transparent, border-only, single-title shape at every zoom and retains its resize and presentation controls; it never becomes the filled distant-title tile. Viewport culling and the canvas world transform still apply normally.

The interactive camera is clamped to `0.4–2.4` (40%–240%) at every entry point: wheel previews, toolbar input, shortcuts, focus-to-bounds calculations, committed workspace state and reads of older workspace values. This keeps the supported distant overview usable while preventing unreadable single-digit zoom states.

Both node detail levels use the same grapheme-aware end-ellipsis rule: when a title exceeds its available presentation budget, the visible beginning remains and the first omitted position is marked by one trailing ellipsis. The hidden ending is not repeated. A blurred editor title field uses the same rule, while focus restores the complete editable title. This is derived presentation only and never shortens stored title data.

Connections keep their independent adaptive SVG renderer: ordinary visible edges remain accessible elements and dense visible sets collapse into a compound path with spatial hit testing. A future Canvas 2D, WebGL or WebGPU renderer must remain behind the same content, selection and connection protocols and requires measurements showing that culling, batched edges and node LOD cannot meet the supported envelope.

## Consequences

- Distant overview rendering uses a single title-colored tile and bounded title text, so nodes remain identifiable without mounting long previews or ordinary card controls.
- Moving through the threshold remounts only the already bounded visible set.
- The current renderer keeps native text, focus and assistive-technology behavior at useful reading scales.
- This decision does not claim unlimited DOM scalability; release performance budgets and representative browser profiles remain the authority.

## Verification

A pure contract test locks the threshold. The existing 2,000-node viewport-culling, spatial-index, connection-rendering, pointer-transaction and portable-build checks remain required.
