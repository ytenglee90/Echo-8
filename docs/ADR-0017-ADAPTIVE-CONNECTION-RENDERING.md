# ADR-0017: Adaptive dense-connection rendering

## Status

Accepted for the connection view.

## Problem

Two SVG elements per visible connection provide precise pointer and keyboard behavior at ordinary scale, but hundreds or thousands of visible edges create avoidable DOM and reconciliation work during pan, zoom and node previews. Replacing the whole renderer with WebGL would add text/UI integration, accessibility, hit-testing and portable-build risk before measurements justify it.

## Decision

Connection storage, broadcasts and viewport culling remain unchanged. Up to 600 visible connections use the existing individual SVG hit and visual paths. The wide hit stroke is fully transparent rather than a low-alpha painted stroke, so it preserves pointer reach without creating a visible halo. The connection slot is a sibling of the canvas-background slot, so its owned non-passive wheel listener forwards wheel coordinates and delta through the existing `canvas.wheel.requested` ephemeral signal; the canvas owner remains the only service that computes and commits camera zoom. Above that threshold, the view joins the visible Bézier subpaths into one SVG path. SVG end markers add one target-side arrowhead to each individual path or compound-path subpath without creating per-arrow DOM in dense mode. Selected and hovered connections are rendered as separate adaptive overlays. Pointer movement queries the existing connection spatial index around a twelve-screen-pixel radius and performs bounded curve-distance testing only on those candidates. Clicking still dispatches the normal `selection.set` broadcast.

The switch is derived view state. It creates no store patch, event, history record or persistence data. The connection renderer consumes the optional semantic `canvas.appearance@1` capability plus declared invalidation/preview signals so both the compound path, individual paths and their arrowheads derive a minimum-3:1 color from the actual canvas background. Selected and hovered paths and arrowheads use the stronger adaptive canvas-selection color instead of a fixed red; light canvases use a medium gray whenever it keeps at least 4.5:1 contrast, while other backgrounds fall back to the higher-contrast black/white pole. Dragged or resized endpoints are added to the hit-test candidate set so previews remain interactive before the durable node transaction commits.

## Consequences

- Ordinary canvases retain per-edge keyboard focus and the existing interaction model.
- Wheel zoom remains available while the pointer is over an ordinary connection and across the full batched connection layer.
- Dense canvases reduce visible connection DOM from roughly two elements per edge to one compound path plus selected/hover overlays.
- Light, dark, middle-tone and custom canvas backgrounds retain visible ordinary, draft, hovered and selected strokes without storing presentation colors in connection records.
- This is not described as WebGL or GPU rendering. A future Canvas/WebGL provider remains possible behind the connection layer after profiling demonstrates a need.
- The threshold is an engineering constant covered by a contract test and must not be raised merely to hide a regression.

## Verification

Pure rendering tests cover the exact threshold, Bézier path construction, pointer-distance geometry and adaptive stroke contrast. Browser regression verifies the target-end marker, shadow-free hit path and wheel zoom over a real title connection. Existing connection, selection, viewport culling, node movement, deletion and portable-build contracts remain release gates.
