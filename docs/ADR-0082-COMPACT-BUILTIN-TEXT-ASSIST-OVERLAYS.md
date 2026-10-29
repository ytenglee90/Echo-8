# ADR-0082: Compact built-in text-assist overlays in portable books

## Status

Accepted — 2026-10-29. Supplements ADR-0006, ADR-0038 and ADR-0061.

## Context

The text-assist plugin created one hidden system text node containing the full
packaged correction dictionary. That dictionary is about 267 KB before
compression and dominated otherwise small `.echo8` files: a book with only a
few short nodes and connections could still approach 100 KB after gzip.

The packaged rules are identical for every installation of the same product
version. Repeating them in every book does not improve user-data durability.
User-authored overlays and explicitly imported rule files are different: those
may be unique and must remain portable.

## Decision

- A fresh rule resource that uses the same-origin packaged dictionary stores a
  short, editable overlay node instead of copying the dictionary. Its binding
  records `ruleStorage: builtin-overlay` and the built-in rule version.
- Runtime compilation reads the packaged dictionary through the governed asset
  capability, merges it with the book-owned overlay and preserves overlay
  precedence. The compiled model remains derived state and is never serialized.
- The overlay node explains that packaged rules are versioned application data
  and that additions or overrides written below the header travel with the
  book. Opening and editing the rule resource therefore stays inside the
  existing text-node and transaction boundaries.
- On startup, a legacy resource whose body exactly equals the current packaged
  dictionary is replaced with the compact overlay through the ordinary
  revision-checked content mutation plan. A resource consisting of the exact
  packaged prefix plus appended custom content retains that suffix as its
  overlay. Any other embedded content is left unchanged.
- A TXT explicitly imported by the user remains embedded in the document and
  is marked `ruleStorage: embedded`, even though the personal source asset is
  also retained on the current device. Portability takes precedence over size
  for unique user data.
- The text-assist portable data version advances from 1 to 2. Its declared
  namespace migration is intentionally a no-op because compaction also touches
  content owned by the text-node plugin; the live plugin performs that change
  through the public mutation capability after document replacement.

## Compatibility

The `.echo8` container remains format version 2 and older readers can still
open the compact book because the overlay is ordinary text-node data. An older
text-assist implementation may not understand the new binding schema and will
rebuild its resource rather than interpreting a compact overlay as a full
dictionary. The current implementation accepts binding schemas 1 through 4,
normalizes them to schema 4 and preserves non-matching custom resources.

The optimization also reduces cloud checkpoints and browser recovery records
after the one-time compaction because all three persistence paths consume the
same authoritative document snapshot.

## Verification

- Kernel coverage verifies that fresh rules are compact while built-in
  corrections still compile.
- A legacy book containing the complete packaged dictionary is compacted to a
  versioned overlay without entering undo history.
- A representative book with six short nodes and five connections must remain
  below 32 KiB after `.echo8` serialization.
- Existing custom rule text remains document-owned and imported TXT continues
  to use embedded storage.
