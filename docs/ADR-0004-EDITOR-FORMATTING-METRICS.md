# ADR-0004: Three-pane editor, document typography and writing metrics

## Status

Accepted for the first complete editor slice.

## Ownership and messages

The text-node plugin owns durable body typography in the `textFormat` document namespace. The editor never writes that namespace. It dispatches `content.setDocumentFormat`; the text provider validates the style revision and commits a standard patch that remains undoable after the editor is disabled. Text deltas carry an optional expected content revision and typing-session ID. A stale editor view is rejected before any text changes.

The editor plugin owns only personal workspace state: open panes, active pane, pane recency, dock width, immersive pane and aggregate writing metrics. These changes are broadcast commands with `history: false`. Body, title, format, selection and dock-resize previews are coalesced ephemeral signals.

The UI shell owns the governed modal layer and global shortcut suppression while an input or content-editable surface owns the keyboard. The UI runtime supplies one shared one-second clock; editor views subscribe through their scoped client instead of creating unmanaged timers.

## Pane and layout policy

At most three distinct nodes are open. Opening an existing node activates it. Opening a fourth distinct node replaces the least recently activated pane, using the node ID only as a deterministic tie-breaker. No document history entry is created.

Dock width is clamped to 320–760 CSS pixels. Pointer movement publishes `editor.dock.resize.preview`; pointer release dispatches one `editor.setDockWidth` workspace command. Keyboard users can resize the separator with Left and Right arrows.

Immersive mode is a workspace state rendered through `overlay.modal`. Its button also requests the browser Fullscreen API during the user gesture. Fullscreen is best-effort: browsers retain their guaranteed Escape exit and may refuse the request. App chrome is covered by the governed modal even when native fullscreen is unavailable. Feature popups that must live inside immersive writing use the nested exclusive `editor.immersive.overlay` slot rendered by the immersive editor; they never compete with or evict the owning `overlay.modal` surface.

## Formatting scope

The durable format model supports a document default plus stable selection and paragraph marks. The current UI applies a format to the selected range when text is selected; with no selection it changes the document default used by unmarked text and later input:

- font size and weight;
- line height and letter spacing;
- text color;
- first-line indent for every paragraph;
- spacing after every paragraph.

Paragraphs are plain-text newline blocks. TXT content remains unchanged; spacing is presentation data. The editor uses a content-editable DOM only as a projection and never stores HTML. Range marks use explicit before/after anchor bias so edits at an edge do not unpredictably absorb adjacent text.

Body commands and format commands share one serial mutation lane per node because a body delta may also advance the format revision. A failed/stale body delta faults that local lane, discards its already-queued obsolete deltas and reloads authoritative content before accepting more edits. Asynchronous document loads are revision-gated and cannot overwrite a newer local preview merely because an older request completed later.

Canvas cards remain bounded plain-text summaries rather than miniature rich-text editors. Their body preview always uses the canvas card's default preview ink; document-default colors, range color marks and ephemeral color scrubbing are rendered only by editor surfaces. Changing body text color therefore does not recolor the canvas summary or add formatting work to the canvas node renderer.

Cross-browser editing does not depend on `innerText` layout serialization. Top-level line blocks are read through deterministic `textContent`, paste is normalized to plain text, unsupported native rich-format commands are rejected, and ordinary insertion is projected from plain-text offsets. During a typing burst, delayed React/assistance projections cannot replace the active DOM with an earlier body. Programmatic completion, paste and drop keep an explicit post-edit caret until the next real navigation/input action, so a regenerated title-reference span cannot capture following text.

## Writing metric semantics

- Counts use `Intl.Segmenter("zh-CN", { granularity: "grapheme" })` when available.
- Active time grows between edit activities, capped at a 60-second idle timeout.
- Chinese IME composition is recorded once when composition commits.
- While an IME composition is active, only the focused browser editing surface may display the input method's marked text. Echo-8 does not broadcast body/title previews, update text-assist analysis, autosave annotations, persist assistant drafts, or add local undo steps until `compositionend` supplies the final text.
- Typed and composition insertions count toward speed. Replacement text counts as typed output.
- Deletions are tracked separately and do not subtract already produced characters.
- Paste is excluded from speed and recorded separately in UTF-16 units.
- Session speed uses current-session typed graphemes divided by active time.
- Recent speed uses 10-second aggregate buckets in a rolling five-minute window.
- A new plugin runtime starts a new visible writing session; old aggregates remain opaque workspace data until overwritten.

Selection count is ephemeral and never persisted. Writing metrics are personal aggregates and never enter document undo.

## Compatibility and performance

The project format version remains unchanged. Existing nodes without a `textFormat` record receive the default format through a read fallback; their first format change creates the record. Clipboard fragment version one accepts an optional format record, so old fragments remain valid and new copies preserve typography.

Text remains chunked and range-read. The current rich editor mounts at most one million characters per open pane; larger content remains stored and discoverable but shows the chunk-mode guard until paragraph virtualization is implemented. Three-pane, IME-under-background-load and very-large virtual editing remain explicit later performance gates.

## Verification

Tests cover format revision rejection, undo, clipboard preservation, stale text-delta rejection, deterministic fourth-pane replacement, workspace/history separation and grapheme-aware writing metrics with paste exclusion. Browser regression also covers editor-only text color, default canvas-preview ink, completion caret placement, link-boundary isolation, rapid input during format changes and the absence of cascading delta errors.
