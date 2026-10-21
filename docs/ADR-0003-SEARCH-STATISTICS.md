# ADR-0003: Revisioned literal search and explicit text measures

## Status

Accepted for the first search/replace and statistics slice.

## Search decision

Search version one scans body text by chunks and uses the stored Unicode sequence without normalization. It performs escaped literal matching, defaults to case-insensitive matching, and optionally enables case-sensitive or complete-word matching. Chinese text therefore uses substring matching by default. Complete-word boundaries use Unicode letter, number and underscore categories. Regular expressions are intentionally not enabled because arbitrary expressions cannot be streamed across chunk boundaries with reliable offsets.

Current-node scope resolves the focused editor first and falls back to exactly one selected text node. Canvas scope scans text nodes sequentially. Results include node ID, exact UTF-16 offset and length, matched text and content revision. Results are capped; replace-all is disabled when the cap was reached.

Replacement asks `content.replacePlan@1` for owner-labelled patches. The provider revalidates every node revision, expected text and overlap before returning any patch. One stale hit rejects the complete operation. A successful multi-node replacement is one global history entry.

## Statistics decision

Statistics distinguish these measures:

- `utf16Units`: JavaScript/storage code units;
- `graphemes`: user-perceived characters using `Intl.Segmenter("zh-CN", grapheme)`;
- `nonWhitespaceGraphemes`: graphemes excluding Unicode whitespace;
- `words`: `Intl.Segmenter("zh-CN", word)` segments marked word-like;
- `lines`: newline count plus one for non-empty content.

Chunk scanners retain the final segment across boundaries so surrogate pairs, emoji sequences and words are not counted twice. Statistics are rebuildable derived data. Content changes cancel stale low-priority tasks and schedule a new calculation. Connections and groups contribute their module counts through `statistics.contribute@1`.

## Compatibility and limits

The document file version is unchanged because authoritative text storage did not change. Search results and statistics are derived and never required for recovery. Regex, Unicode normalization modes, persisted indexes, locked-node filters and worker-backed indexes require later versioned contracts.
