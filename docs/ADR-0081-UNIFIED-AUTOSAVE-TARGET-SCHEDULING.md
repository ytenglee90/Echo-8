# ADR-0081: Unified automatic-save target scheduling

## Status

Accepted — 2026-10-29. Supplements ADR-0006 and ADR-0071, and partially
supersedes ADR-0077's immediate cloud upload and automatic project-binding
trigger.

## Context

Browser recovery, retained local `.echo8` output and cloud persistence had
grown into overlapping schedules. Core persistence appended a recovery journal
and periodically created a complete checkpoint, the file owner reacted to that
checkpoint to overwrite a retained local destination, while cloud sync started
an independent 900 ms upload timer after every committed document transaction.
An active cloud book therefore appeared to synchronize after every small user
action even though the product already exposed one automatic-save interval.

The recovery journal must remain prompt and device-local. It is a crash-safety
boundary, not a user-selected book destination. Conversely, a local file handle
and an active cloud project are alternative primary save targets and should use
one user-facing cadence.

## Decision

- Core persistence remains the mandatory schedule owner and emits the public
  `system.persistence.automaticSave.requested` signal when the selected cadence
  is due. Target owners react independently without importing one another.
- The choices are real-time, 30 seconds, 1 minute, 2 minutes, 5 minutes,
  10 minutes, 30 minutes and off. Real-time means a one-second trailing debounce
  after committed document work; timed choices start from the first unsaved
  document transaction so continuous editing cannot postpone a save forever.
- Off disables automatic writes to the current primary target and automatic AI
  conversation saves. Manual Save remains immediate. Switching or disconnecting
  an active cloud book still flushes its pending queue before releasing the
  lease, because a destructive target transition cannot silently discard work.
- Every committed transaction still enters the IndexedDB write-ahead journal
  after its short recovery debounce. Complete browser-recovery checkpoints run
  on an internal one-minute maintenance cadence independent of the selected
  target cadence. Neither real-time nor off makes recovery snapshots run on
  every edit or disables recovery journaling.
- The import/export owner overwrites a retained local book and bound text
  exports only on the unified request. The cloud owner records document commits
  in its durable local pending queue immediately, but uploads that queue only on
  the same unified request, explicit Save/Sync, or a forced target transition.
- Lease renewal sends an empty synchronization request. It never drains pending
  document commits and never captures a cloud checkpoint, so turning automatic
  save off has real effect without forfeiting the active editing lease.
- A new unbound book acquires its first cloud target on the first unified
  automatic-save request or explicit Save, not merely because document
  replacement reported origin `new`. Local, recovery, external and explicitly
  disconnected origins retain the existing origin-aware rules.
- Waiting changes are presented as static “waiting for automatic save” or
  “waiting for manual save” state. The processing mark moves only during actual
  connection or network work.

## Compatibility and migration

Existing stored interval values remain valid without migration. The new
personal values are `1000` for real-time and `0` for off. These values stay in
device-local persistence metadata and never enter document history, `.echo8`
files, cloud checkpoints or the D1 schema.

The old `system.persistence.automaticCheckpoint.completed` signal remains a
recovery-maintenance fact, but save targets no longer interpret it as a request
to write. No portable file version, cloud API version or data Worker release is
changed.

## Verification

### Explicit local-to-cloud Save As (2026-11-06)

The file panel exposes “另存到云端” for a book without an active cloud target.
It opens the cloud owner's panel, where the user supplies a name and invokes the
existing `cloudSync.saveCurrentAsProject` command. This is an explicit target
choice; ordinary local saves and automatic saves still follow their existing
origin rules. The current document, including unsaved edits and opaque plugin
data, becomes a new cloud book without replacing the document or clearing its
local undo history. The original local file is retained. Subsequent Save and
automatic-save requests target the cloud book.

Before creation, cloud-sync refreshes the library and chooses the first free
display name using ` (2)`, ` (3)`, etc., within the 120-character limit. Names
are display labels, never overwrite keys: every creation receives a new project
ID. The existing list API returns the latest 200 books; a concurrent creation
or a name outside that list can still share a label, but cannot replace an
existing book. This UI addition does not change the cloud API, file format,
schema, permissions or migration policy.

First-upload errors reject the command and remain visible in the cloud panel.
The local document and recovery data remain available; the retained new cloud
binding allows the same book to be retried instead of creating another copy.
Browser coverage exercises local import, unsaved edits, name collisions,
upload failure/retry, original cloud-book preservation, undo/redo and reopening
the saved book with its complete chunked body.

- Kernel tests cover accepted cadence values, disabled automatic save, local
  destination overwrite and coalesced text exports through the unified signal.
- AI tests retain the shared interval contract and cancel delayed automatic
  conversation work when the cadence is off.
- Browser coverage verifies every visible cadence choice and confirms that off
  leaves the browser-recovery controls available.
- Cloud tests and manual Save coverage retain forced flushing, conflict safety,
  checkpoint upload and lease ownership behavior.
