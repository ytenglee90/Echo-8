# Echo-8 file format 2

Extension: `.echo8`  
Media type: `application/x-echo-8-canvas+gzip`  
Container: gzip-compressed UTF-8 newline-delimited JSON

New saves use compact version 2. The compressed payload contains the current document snapshot only: it does not include undo/redo history, local recovery logs, user interface preferences, search indexes, model keys or personal connections. Opening a version 2 book starts a fresh undo history in the receiving browser.

File opening and drag-opening also accept `.eco8` as a forgiving filename alias; recognition and integrity still depend on the internal manifest and checksum, not the extension. Readers continue to accept the uncompressed version 1 format (`application/x-echo-8-canvas+ndjson`) so existing books remain usable.

## Record order

```text
manifest
document entry or start + fragment records
footer
```

Document entries are sorted by namespace and key. Values whose serialized JSON exceeds 64 KiB are emitted as one `start` record followed by ordered `fragment` records. A parser must join only the declared consecutive fragments and parse the resulting value as JSON. The version 2 manifest declares `historyMode: "none"`; history records are invalid in that format.

The shipped reader applies hard resource ceilings before accepting the document: 256 MiB compressed input, 256 MiB expanded stream, 64 MiB per reconstructed logical record, 1024 fragments per record and 250,000 logical entries. Exceeding any ceiling aborts the read before document replacement. These are product safety limits, not additional wire fields; another conforming reader may choose stricter limits but must not silently accept malformed ordering or checksums.

Text storage version 2 is represented as ordinary document records: `textContent` contains ordered chunk metadata and `textContentChunk` contains independent physical chunks. Readers must preserve both namespaces even when the text plugin is unavailable. The project container does not require a reader to concatenate正文 content; fragmentation of a large JSON record and logical text chunking are separate layers.

AI conversations use `aiSessions` plus ordered `aiTranscriptChunks`. Saved-memory originals and readable indexes are ordinary text-content sources referenced by bounded `aiMemoryIndex` records. Optional model reasoning is stored separately in `aiResponseDetails` and is never treated as transcript evidence. A memory's `localFileStem` is a local filename hint with a mutable title-derived prefix and stable identity suffix; its directory handle and any model key remain personal local preferences and are never part of this format.

Connection plugin data version 2 extends endpoint `side` with `title`. Existing `left` and `right` records remain valid and continue to resolve from current node centres. A title connection stores `title` on both endpoints and anchors them at the title-bar leading edge. The version 1 to 2 migration is structural identity because every version 1 record is already valid version 2 data.

Text-node data version 2 adds the canvas `presentation` (`card` or `text-box`) and independent remembered `cardSize` / `textBoxSize` geometry to each text-node record. The `1 -> 2` migration preserves old content and initializes every legacy node as a card using its existing width and height. A text box hides正文 only in the canvas view; its content chunks remain part of the project.

The footer stores the number of logical entries and CRC32 over every preceding encoded line, including newline bytes. The footer itself is not included in the checksum.

## Compatibility rules

- Readers accept only the `echo-8-project` manifest kind and declared format version. Legacy product formats are intentionally not accepted.
- Version 1 files are uncompressed and include undo/redo records. They are read for compatibility, but subsequent saves produce compact version 2 files.
- A future version requires an explicit migration path; it must not be guessed.
- Unknown document namespaces are retained without interpretation.
- Plugin descriptors record whether a provider was available at save time and its positive integer `dataVersion`. A missing `dataVersion` in an older book means 1.
- Plugin implementation `version` and document `dataVersion` are independent. A known plugin upgrades only through its declared consecutive migrations before the document replacement boundary; unsupported newer data aborts opening without changing the current document.
- Unknown plugin namespaces and descriptors remain opaque and survive resave.
- Personal workspace state is not portable document data.
- Search indexes, statistics, previews and other rebuildable caches are not required for recovery.
