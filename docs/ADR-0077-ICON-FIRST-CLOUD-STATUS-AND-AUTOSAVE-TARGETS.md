# ADR-0077: Icon-first cloud status and origin-aware autosave targets

## Status

Accepted — 2026-10-28. Supplements ADR-0006, ADR-0071 and ADR-0075, partially
supersedes the first-manual-Save trigger in ADR-0073, and supersedes the
text-labelled Delete presentation requirement in ADR-0076.

## Context

The book library repeated headings and text actions that obscured the books
themselves. Cloud state was also rendered as a dot plus changing text in the
toolbar, while the same project actions used different presentations in the
library and sync panel.

Autosave treated every document without a retained native destination as a
local book that needed a save-location prompt. That is wrong for an active
cloud book and adds a manual first-save step for a newly created book even when
the user's personal cloud installation is already ready. At the same time, an
opened local file must never be silently converted into a cloud book.

## Decision

- The library brand, browser favicon and toolbar cloud affordance use the one
  canonical `public/favicon.svg` E8 asset; feature code does not redraw an E8
  glyph. The toolbar renders that icon with a compact state dot and opacity:
  green means the active book is fully synchronized, neutral means signed out,
  unbound, offline or otherwise not synchronized, and a bounded animation
  indicates connecting, uploading or queued changes.
  The button's accessible name and hover title always state the exact phase,
  pending count and latest sync detail, so color and motion are not the only
  signals.
- Repeated library headings and book-list action text are visually removed.
  Open, delete, refresh, sync and logout remain ordinary buttons with icons,
  stable accessible names, keyboard focus and native hover titles.
- ADR-0075's confirmation remains mandatory for deletion. ADR-0076's
  requirement that the pre-confirmation Delete control itself be text-labelled
  is replaced by the accessible icon-button presentation above.
- An active cloud project is the automatic-save target. Local save-location
  prompts are suppressed while that binding exists.
- The import/export owner records the core `document.replaced` origin. For
  origin `new`, a ready authenticated personal cloud installation creates the
  first cloud project automatically and keeps the current document in place.
  If the installation is unavailable, the untouched new canvas remains silent;
  a later automatic checkpoint may request the ordinary local fallback. This
  is a typed cloud command, not a direct write.
- Origins `file`, `recovery`, `external` and a cloud book that was explicitly
  disconnected or deleted never trigger implicit cloud-project creation.
  Native-file destinations and their permission behavior remain unchanged.
- Automatic native output compares the checkpoint revision with the last
  saved revision. An unchanged book is not rewritten and short automatic work
  does not flash a progress notice.

## Consequences

- A signed-in user's new book reaches the cloud without a redundant save-path
  prompt or first manual Save, while a local `.echo8` book remains local.
- Deleting the active cloud book cannot immediately recreate it through the
  next autosave checkpoint because its document origin is not `new`.
- Visual chrome is smaller without removing functionality or keyboard and
  assistive-technology labels.
- No project-file schema, cloud data schema or public protocol version changes.

## Verification

- Kernel tests cover immediate automatic cloud binding for a new document, local-origin
  preservation and unchanged native-output suppression.
- Hosted browser tests verify that the brand and E8-only toolbar status both
  load `/favicon.svg`, plus icon actions in both book lists while retaining
  deletion confirmation.
- Portable browser tests verify that the same SVG is embedded as data URLs for
  both the page favicon and E8 brand while preserving the zero-network
  `file://` boundary.
