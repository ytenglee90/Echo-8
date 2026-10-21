# ADR-0026: Smart guides, strong snapping and selected-node grid layout

## Status

Accepted.

## Problem

Free dragging makes precise edge, center and equal-spacing placement slow. A durable command for every pointer movement would also flood global history and persistence. Batch layout must remain a normal broadcast operation, reset node sizes predictably and undo as one user action.

## Decision

`smart-layout` is an independently stoppable built-in plugin and owns alignment candidate calculation, the public `layout.snap@1` and `layout.resizeSnap@1` capabilities, the `node.arrangeSelectedGrid` command, its toolbar button, command-palette action and `Ctrl/Command + Shift + L` shortcut. The button contributes to the canvas-status toolbar group at priority 7, placing it directly after Focus and before the zoom percentage. Plugin Center stop removes both capabilities, command, button, action and shortcut together.

`layout.snap@1` is a deliberately synchronous, bounded and read-only interaction-frame capability. The core rejects asynchronous providers on this path. The plugin maintains rebuildable spatial indexes from all public `selection.entities@1` contributions rather than reading node or group storage. Node dragging requests all node and group bounds. Group dragging requests top-level references, where every group replaces its contained members with one derived outer frame. A moving container and all of its member IDs are excluded from its own candidates.

Candidate rules cover left/right and top/bottom edges, horizontal and vertical centers, and repeated horizontal or vertical gaps. The strong threshold is 18 screen pixels and is converted to world units using the current zoom, so the interaction feels consistent at every scale. Detailed comparison is capped at 96 nearest spatial candidates. Visible guide strokes use a quiet half-CSS-pixel semantic selection color.

节点右下角缩放通过同步只读的 `layout.resizeSnap@1` 比较缩放框与邻近节点、群组框的上下左右边；当前可移动的右边和下边进入吸附，固定的左边和上边保持不动。缩放过程继续广播 `canvas.node.resize.preview` 与 `canvas.snap.preview`，松手清除参考线并只提交一次既有 `node.resize` 指令。停用智能布局时，画布自动退化为无吸附的原始缩放。

Tentative snapped positions and `canvas.snap.preview` guide records use the coalesced ephemeral channel. They never enter document state, persistence or history. Releasing either a node or a whole group clears the guides and dispatches the existing `node.moveMany` command once; cancellation clears every preview without a durable write. A single shared offset preserves every moving node's relative position.

The text-node plugin provides the non-mutating `layout.gridPlan@1` capability because it owns node geometry. The smart-layout command requests public selection, asks that capability for owner-labelled standard patches, and submits one transaction. The plan keeps directly selected text nodes only, sorts them by current reading order (`y`, then `x`, then stable ID), anchors the result at the selection's minimum `x` and `y`, and uses a near-square number of columns. Every included node returns to the standard 280 by 158 size. Cells use a 40-unit horizontal and vertical gap. Position and size patches therefore undo and redo as one operation even though the initiating plugin owns no text data.

## Performance and compatibility

Snapping does not scan the whole document per pointer event: committed entity changes rebuild a spatial index, each request queries a bounded neighborhood, and the pure alignment function caps detailed comparison at 96 nearest candidates. Equal-spacing evaluation is therefore bounded independently of total canvas size. Grid layout is linearithmic in the selected-node count because of deterministic sorting.

No document schema or file-format version changes. The result is stored only as ordinary node geometry already supported by save, recovery and history.

## Verification

- Pure tests cover drag edge snapping, resize-frame edge snapping and repeated-gap snapping.
- Plugin integration tests cover whole-group frame snapping, hot stop cleanup, deterministic grid positions, default-size restoration and one-step global undo.
- Type checking, lint, the full contract suite and the portable single-HTML build remain release gates.
