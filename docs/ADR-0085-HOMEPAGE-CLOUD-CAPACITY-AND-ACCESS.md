# ADR-0085: Homepage cloud capacity and active-book access status

## Status

Accepted — 2026-10-30. Supplements ADR-0068, ADR-0069 and ADR-0070.

## Context

The book-library header identifies the signed-in Cloudflare user but does not
show whether the personal D1 database is approaching its practical limit. It
also does not expose the current book lease at that account-level surface, even
though the cloud panel already distinguishes an owned editing lease from a
read-only lease that can be explicitly taken over.

The data Worker can observe the physical D1 database size through the
`size_after` metadata returned by a bounded query. It cannot determine the
user's complete account-wide allowance or paid subscription without expanding
OAuth into billing permissions. A capacity display must therefore state the
boundary it actually measures instead of presenting an invented account quota.

## Decision

- Data Worker release 4 adds authenticated `GET /v1/storage`. It runs one
  bounded storage probe and returns the D1 physical size, measurement time,
  storage mode and an explicit quota basis.
- D1-first installations receive `D1_CAPACITY_BYTES=500000000`. For that mode,
  remaining capacity is the conservative difference from Cloudflare's free
  per-database ceiling. The homepage tooltip says that paid accounts may have a
  higher limit. This is not presented as total account-wide free space.
- Successful sync responses may carry the same storage snapshot, allowing the
  public cloud state to refresh after writes without a second polling loop.
- `CloudSyncState` exposes optional `storageUsage` and a nonfatal
  `storageUsageError`. Capacity failure does not change book sync phase or block
  the project list. Older data Workers show the existing explicit upgrade path
  rather than a misleading zero value.
- The book-library account area renders the used/remaining storage summary and
  derives the active-book access label from public cloud state: editable,
  read-only with takeover available, offline local editing, conflict-paused,
  pending confirmation or no active cloud book.
- The book-library plugin continues to consume only the typed `cloudSync.state`
  query and signal. It does not inspect cloud-plugin internals or leases.

## Consequences

- Users can see a conservative D1 capacity warning surface before a write
  fails, with no new billing scope or long-lived credential exposure.
- Paid-plan capacity and future R2 object usage remain explicitly unknown until
  a provider-specific quota contract is added.
- Existing installations must use the already governed one-click data Worker
  upgrade from release 3 to 4. No D1 schema or document/file-format migration is
  required.

## Verification

- Data Worker contract tests verify authenticated storage reporting, physical
  size, free-capacity arithmetic and the release-4 upgrade boundary.
- Hosted browser coverage verifies the homepage used/remaining copy and both
  editable and read-only-takeover access labels.
- Type, architecture, cloud sync and portable gates continue to enforce the
  existing OAuth, origin and offline boundaries.
