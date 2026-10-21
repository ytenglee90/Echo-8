# ADR-0006: Portable files, journal autosave and recovery boundaries

## Status

Accepted for the first complete file and recovery slice.

## Ownership

The mandatory persistence service owns device-local autosave, the write-ahead journal, complete checkpoints and recovery-point storage. It has the kernel write boundary and is not a removable feature plugin.

The `import-export` plugin owns portable file encoding, untrusted-file parsing, TXT assembly, download UI and recovery controls. It receives a read-only `system.project.source` snapshot and cannot inspect another plugin namespace through its scoped store. It cannot replace document state itself.

## Portable project decision

Version one uses newline-delimited `.echo8` records with manifest kind `echo-8-project` and media type `application/x-echo-8-canvas+ndjson`:

1. one manifest with file/core versions, document revision and plugin descriptors;
2. sorted document namespace/key entries;
3. undo and redo entries;
4. bounded fragments for large serialized records;
5. one footer containing logical entry count and CRC32.

CRC32 detects ordinary corruption and interrupted writes; it is not an authenticity or hostile-file security signature. The parser enforces record, line, fragment and entry limits, never executes file content, rejects duplicate namespace keys, and stages the complete verified representation before asking the core to open it.

Portable version 1 files include authoritative document namespaces and document history. Personal workspace state—theme choice, dock width, open panes and selection—is intentionally excluded. Unknown namespaces remain opaque records; imported unavailable-plugin descriptors are retained by persistence and included on resave.

Version 2 changes the portable boundary: new saves are gzip-compressed NDJSON snapshots with media type `application/x-echo-8-canvas+gzip`. They preserve the document, plugin descriptors, bounded fragments and CRC32 validation, but deliberately omit undo/redo history. History is valuable for the active browser session and local recovery, yet it grows with every edit and is not useful to a recipient starting work from a shared book. A version 2 manifest declares `historyMode: "none"`; parsers reject version 2 files that contain history records. Readers still accept uncompressed version 1 books so existing work remains openable, while saving any book writes the smaller version 2 form.

## Document replacement

Opening a file is an exclusive, routed system command rather than an ordinary undoable edit. Before replacement, persistence creates a full recovery point. The transaction manager then replaces only the document domain, restores legacy version 1 history when present (or starts empty for compact version 2), clears ephemeral/derived state, publishes `document.replaced` and forces a new checkpoint. The old canvas is recovered through the safety point rather than by mixing two documents in one global undo stack.

Selection and editor plugins respond to the committed replacement fact by dispatching their own workspace cleanup commands. Events themselves do not mutate durable or personal state.

Requesting another book from the canvas command palette or book/recovery panel does not replace a dirty current document immediately. Those entries first broadcast `file.requestOpenProject`; a clean canvas may open the native chooser at once, while a dirty book enters the file plugin's transient pending-open state before any target file is selected. A dropped book enters the same state while retaining that browser `File` only in plugin memory. The book-library welcome surface is the explicit book-switching boundary: `file.openProjectFromLibrary` does not show that second confirmation, clears stale pending-open UI, and relies on the same mandatory full recovery point that `system.document.replace` creates before replacement.

The shared overlay offers two explicit decisions. Saving invokes native Save As and writes the current book first. A dropped target can then open immediately. For a picker request, browsers do not reliably allow a second native picker after the asynchronous Save As operation has consumed user activation, so the overlay changes to a short “choose book” continuation button. For both that continuation and the explicit “do not save” choice, the user gesture opens the native chooser before the pending decision is cleared. Only after a real file is selected does `file.proceedPendingOpen` grant a short-lived, one-use authorization and `file.openProject` consume it. Cancelling or failing to open the native chooser therefore leaves the pending decision visible. Pending files, authorization IDs, chooser phases and prompts never enter document/workspace storage or global history.

## Autosave and recovery

Every committed transaction still reaches persistence synchronously as a standard commit record, but autosave first appends records after a short debounce instead of rewriting the full canvas after every typing pause. Adjacent records from the same explicit merge session are composed before journal admission. Checkpoints follow the user-configured interval or an explicit save/recovery request; they are not triggered by every fixed number of edits. Checkpoint replacement and journal clearing use one IndexedDB transaction.

The persistence service retains a versioned `restore-session` startup policy that replays records newer than the checkpoint and reconstructs record/undo/redo history actions. The shipped application instead selects `fresh-session`. On every application start, it atomically clears the previous snapshot, journal and recovery stores before plugins start, then writes an empty baseline. This startup-first cleanup is authoritative because browser shutdown callbacks cannot guarantee asynchronous IndexedDB completion.

Autosave, named safety points and pre-open recovery points remain available while the current application session is open, with the latest eight manual/safety snapshots retained. They are deliberately session-scoped and are discarded on the next launch. Manually saved `.echo8` files are not stored in these IndexedDB stores and remain untouched as the only cross-session document boundary. The renamed protocol intentionally rejects legacy `.icanvas` manifests instead of carrying a compatibility branch.

## TXT semantics

Current-node TXT and DOCX put the node title in the first paragraph and正文 in the second. Whole-canvas export sorts text nodes by canvas position and creates one independently named TXT file per node in a user-selected directory. All modes request bounded ranges from `content.read@1`; TXT discards formatting data and emits UTF-8 text with a BOM for broad desktop compatibility.

After a current-node export, the plugin keeps a session-only binding between that node and the native file handle. Content auto-export and project auto-save share a per-target write coordinator: two writable streams can never overlap on the same handle, while unrelated files remain parallel. A new automatic checkpoint never cancels a write already in progress; repeated checkpoint notifications coalesce behind it and run once more with the latest state.

The binding records body revision, the title written inside the file and the title represented by the filename separately. A title-only rename therefore updates the first paragraph even when正文 revision did not change. Where the browser's native handle supports `move(name)`, automatic export also renames the file. Browsers without that API keep writing safely to the retained handle, mark the export as needing attention and require one user-initiated Save As to select the new filename; they never report a filename rename that the browser could not perform.

## Streamed native saves

The portable encoder exposes one bounded asynchronous NDJSON generator. Version 2 pipes that generator through the browser gzip stream. When the browser supplies a retained File System Access handle, manual save and automatic overwrite write compressed chunks directly to its writable stream and report byte progress. The download fallback still assembles a Blob because the browser does not expose a destination stream in that path. Parsing, record limits, CRC32 and document record semantics remain unchanged.

## Deferred work

- opt-in full archive packaging when a user explicitly needs to preserve undo history across machines;
- cryptographic signatures and trusted provenance;
- ordered plugin migrations beyond file format version one;
- worker-backed JSON encoding for theoretical multi-gigabyte non-text plugin records.

The current fragmented format and streamed native writer avoid a second whole-project byte buffer. A single non-text plugin value is still JSON-encoded before record fragmentation; the existing text-body owner avoids that peak through bounded immutable chunks.

## Verification

Tests cover fragmented round trip, corruption rejection, unknown-namespace preservation, dirty-document open arbitration before the native chooser, library switching without a duplicate prompt, native-save-before-open ordering, explicit discard authorization, dropped-file continuation, core replacement, history reset, restore-policy journal replay, range-based TXT generation and file-plugin resource cleanup. They also verify that library switching creates a recovery point, same-target write serialization, autosave coalescing, title/body refresh and native filename synchronization. The application composition fixes the product lifecycle to the separate fresh-session policy.
