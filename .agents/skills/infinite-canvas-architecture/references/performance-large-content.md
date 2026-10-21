# Performance and Large-Content Contract

## Honest target

Support 2,000-plus normal nodes and isolated very large documents without loading everything into DOM or memory. The theoretical combination of 2,000 nodes each containing 20 million characters is tens of billions of characters and is not a realistic single-page in-memory target. Preserve access through cold storage and streaming rather than pretending all maxima are simultaneously hot.

## Canvas rendering

- Separate world coordinates, camera transform, and screen coordinates. Set sensible zoom bounds and use origin rebasing or equivalent precision control for very distant areas.
- Maintain a spatial index for visibility, hit testing, selection, and group bounds.
- Cull offscreen nodes. At distant zoom use level-of-detail representations such as shape/title/cached preview; instantiate full interactive node DOM only when visible and sufficiently enlarged.
- Prefer a hybrid renderer: batched canvas or equivalent for connections and low-detail content, governed DOM overlays for currently interactive visible nodes. Choose exact technology by measured behavior, not fashion.
- Schedule at most one visual commit per frame and coalesce pointer/camera previews. Defer detail regeneration until motion settles.
- Cache previews and geometry by content/style/camera revision; invalidate narrowly.

## Text storage and editing

Do not store a long rich document as one mutable JavaScript string or HTML blob. Use a chunked text structure such as a piece table, rope, or measured equivalent, plus:

- stable document and block IDs;
- block types such as paragraph, heading, and future extensions;
- chunked plain text storage;
- interval/tree-based marks for selection formatting;
- stable anchors that survive nearby edits where feasible;
- revisioned range reads and incremental deltas.

Virtualize paragraphs or measured text windows so only the visible neighborhood enters the DOM. Composition, selection, scrolling, clipboard, search navigation, and undo must remain correct across unloaded boundaries. TXT export streams plain text and ignores formatting marks; the project file preserves marks.

## Background task manager

All heavy work uses the kernel task service rather than arbitrary plugin workers. Tasks declare owner, category, priority, estimated cost, cancellation, progress, retry policy, and source revision. The manager controls worker count, memory budget, yielding, pause, timeout, and cleanup.

Suggested priority order:

1. input composition, cursor, pointer capture;
2. visible-frame rendering and interaction commit;
3. authoritative editor updates;
4. incremental save journal;
5. visible search navigation and requested export;
6. statistics, full indexing, preview generation, AI retrieval preparation.

Lower-priority work yields while the user types, drags, or zooms.

## Search, replace, statistics, and AI preparation

- Index and count incrementally by changed chunks. Cache results by revision.
- Current-node search can prioritize the open buffer; global search runs chunked in background and streams hits.
- Define case, whole-word, regular-expression, Unicode normalization, and Chinese matching semantics before implementing replacements.
- Revalidate match revisions immediately before replacement and apply replacement as one atomic transaction.
- Count grapheme/code-point/word measures according to an explicit product definition; do not label all measures simply “字数.”
- AI retrieval selects metadata and relevant ranges first. It never concatenates every canvas document by default.

## Writing metrics

Define idle timeout, composition treatment, deletion treatment, pasted-text treatment, current-session window, and recent-speed window. Keep activity events lightweight. Store aggregate session metrics separately from document undo unless the user explicitly treats them as document content.

## Performance gates

Create repeatable fixtures and record device/browser context. Test at least:

- 2,000 nodes at several zoom levels, selections, groups, and connection densities;
- sustained pan, zoom, lasso, group drag, and connector creation;
- one very large chunked text document without full-DOM loading;
- three editor views, including two views of one source document;
- long typing with IME while autosave, statistics, and indexing run;
- global search and replacement over many chunks;
- 1,000-plus meaningful undo/redo entries including large transactions;
- save, close, reopen, migration, and crash recovery;
- plugin fault and hot disable during queued background work.

Track frame misses, input delay, long main-thread tasks, hot DOM count, resident text cache, queue latency, save latency, and recovery correctness. Averages alone are insufficient; inspect worst-case stalls. Performance regressions fail acceptance rather than becoming unspecified future optimization.
