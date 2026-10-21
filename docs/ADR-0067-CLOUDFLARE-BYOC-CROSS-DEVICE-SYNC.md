# ADR-0067: Cloudflare BYOC cross-device persistence

## Status

Accepted — 2026-10-14. The mandatory-R2 portion is superseded by ADR-0068; the control/data-plane split and synchronization protocol remain in force.

## Context

The hosted canvas must be available from one public URL while letting unrelated users keep independent data and continue on another browser. The owner does not want to pay for or become the custodian of every canvas body. The existing application already has authoritative transactions, a local recovery journal, 64 KiB immutable text chunks, compact checkpoints and explicit document replacement.

## Decision

Use a split control plane / data plane.

- The application owner's Worker serves the UI, completes Cloudflare Authorization Code OAuth, provisions resources and stores only encrypted grants plus installation metadata in a control D1 database.
- Each selected user account receives one module Worker, one D1 database and one R2 bucket. The user Worker owns project heads, ordered commit records, idempotency, leases and checkpoint pointers. R2 owns structural checkpoints and immutable content chunks.
- The browser obtains an installation-scoped, ten-minute HS256 JWT from the control plane and then talks directly to the user's Worker. Long-lived Cloudflare OAuth credentials never enter the browser or user data Worker.
- Existing committed transaction records form the incremental wire log. `textContentChunk` values are replaced by references in D1 operations and uploaded to R2 first. Shared checkpoints contain the document and plugin catalog but no undo/redo history.
- One non-expired editing lease is allowed per project. Other devices open read-only and may explicitly take over. This is cross-device single-user editing, not concurrent collaboration and not CRDT.
- Local commits remain in the managed personal text-asset store while offline. A head mismatch stops automatic writes. The user must create a local recovery point before replacing the document with the remote version.
- Hosted startup uses `restore-session`; the portable single-HTML composition retains its fresh-start and explicit `.echo8` workflow.

## Consequences

- Static asset traffic and editing CPU scale at Cloudflare's edge and in each browser; canvas payload traffic is distributed across user-owned Workers.
- The application owner still operates sensitive OAuth metadata and must protect the control D1, encryption keys, sessions, redirect origin and provisioning audit trail.
- User resource installation requires broad account-level write scopes. Consent must be explicit, resource names predictable and installation retry-safe.
- Existing installations require an explicit upgrade path when the data Worker protocol or D1 schema changes.
- Multi-device simultaneous editing deliberately remains serialized. A later CRDT design must be a new protocol decision rather than an implicit change to transaction semantics.
