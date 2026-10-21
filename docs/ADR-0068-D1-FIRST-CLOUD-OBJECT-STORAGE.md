# ADR-0068: D1-first cloud object storage with an R2 upgrade path

## Status

Accepted — 2026-10-15. Partially supersedes ADR-0067's requirement that every installation create an R2 bucket.

## Context

R2 includes a free monthly allowance but Cloudflare requires a recurring billing method before an account can activate it. That makes the original D1-plus-R2 installation unavailable to users who do not have a supported payment method. The cloud wire protocol already separates ordered commits, immutable content chunks and structural checkpoints, so the storage implementation can change without moving durable writes into the UI or changing the document transaction model.

## Decision

- New user installations create one Worker and one D1 database. They do not create or bind R2 and do not request the `workers-r2.write` OAuth scope.
- D1 continues to own projects, ordered operations and editing leases. It also stores immutable content chunks in `content_chunks`.
- Structural checkpoints are serialized once and divided on UTF-8 boundaries into parts no larger than 512 KiB. `checkpoint_manifests` records the expected byte length and part count; `checkpoint_parts` stores the ordered text parts. This stays below D1's per-row limit while preserving the existing 12 MiB protocol ceiling.
- The browser/data-Worker API remains version 1. Existing chunk externalization, checkpoint shape, conflict handling and lease semantics do not change.
- Provisioned Workers receive `STORAGE_MODE=d1`. The data Worker retains an optional R2 implementation boundary. A later upgrade may create a bucket, bind it as `BUCKET`, set `STORAGE_MODE=r2` and restore the R2 OAuth permission.
- D1 checkpoint keys use `d1:<revision>`. When R2 is enabled later, the Worker still reads D1-keyed checkpoints and falls back to D1 for chunks that have not yet been copied. New checkpoints and chunks can therefore move to R2 without rewriting the browser plugin or making old books unreadable.

## Consequences

- A user can install cross-device storage on the Workers Free plan without adding a payment method.
- Free D1 installations have a smaller practical ceiling than R2 and are intended primarily for text-first books. D1 account, database, row-read and row-write limits still apply.
- Chunk writes are batched and chunk reads use bounded `IN` queries. Missing checkpoint parts, byte-length mismatches and missing chunks fail closed instead of returning a partially reconstructed book.
- Switching to R2 is an explicit installation upgrade. Removing R2 again requires copying any R2-only objects back to D1 before removing the binding.

## Verification

- Contract tests exercise a complete D1-only create, lease, chunk upload, checkpoint sync and bootstrap without a `BUCKET` binding.
- Unicode checkpoint splitting is tested across a part boundary.
- Existing cloud commit externalization and document hydration tests remain unchanged.

