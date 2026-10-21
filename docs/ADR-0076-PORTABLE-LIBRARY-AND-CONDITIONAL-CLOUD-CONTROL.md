# ADR-0076: Portable library entry and conditional cloud control plane

## Status

Accepted — 2026-10-17. Supplements ADR-0033 and partially supersedes the
portable-composition exclusion in ADR-0070.

## Context

The hosted build opened on the book library and exposed Cloudflare sync, while
the portable single-HTML build registered neither plugin and entered the canvas
directly. That composition difference looked like lost product functionality,
made the two distributions teach different navigation models, and hid the
reason cloud access cannot work when a file is opened without an HTTP server.

A local `file://` document has no same-origin `/api/cloud/*` control plane. It
must still remain fully offline: startup cannot probe a guessed remote origin,
emit a failed file request, or weaken the origin allowlist. The portable file's
cross-session document boundary remains explicit `.echo8` files.

## Decision

- Both shipped compositions register `cloud-sync` and `book-library` in the
  same dependency order. Both start at the governed `application.welcome`
  library surface and use the same typed commands to enter or reopen the canvas.
- The portable composition keeps `fresh-session`; adding the library does not
  turn browser recovery into implicit cross-session document restoration.
- Cloud control is conditional on an `http:` or `https:` document origin. At a
  `file:` origin, the cloud plugin registers its status, panel, actions and
  commands but performs no control-plane request and reports a disabled state.
- The library and cloud panel explain that account login and sync require the
  paired HTTP(S) deployment. Local book creation, `.echo8` open/save and canvas
  editing remain available without a server.
- When the same single-file client is served from a paired same-origin HTTP(S)
  deployment, the existing `/api/cloud/*` control plane and BYOC data Worker
  flow remain unchanged.
- Destructive cloud-book actions remain cloud-sync-owned under ADR-0075. Both
  book lists expose a persistent, text-labelled Delete button; discoverability
  does not depend on recognizing an icon or hovering it.

## Consequences

- The homepage and sync affordance no longer disappear merely because the
  single-HTML composition was selected.
- Offline single-file startup still makes zero external requests and does not
  imply that OAuth can run from a local file origin.
- The portable artifact grows by the library and cloud UI code, but remains one
  HTML file with the existing inline worker and `.echo8` interoperability.
- Hosted persistence continues to restore sessions; portable persistence still
  starts fresh. UI composition is unified without collapsing storage policy.

## Verification

- Architecture tests require the portable plugin list to include cloud sync
  before the book library and require an explicit HTTP(S)-only control origin.
- The portable browser gate opens the generated artifact through `file://`,
  verifies the library and cloud boundary notice, enters the canvas, edits a
  node and rejects failed or external requests.
- Hosted browser coverage continues to exercise deletion confirmation from both
  the homepage and the sync panel.
