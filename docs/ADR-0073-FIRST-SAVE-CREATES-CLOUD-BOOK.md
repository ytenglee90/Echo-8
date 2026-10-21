# ADR-0073: First Save creates the cloud book

## Status

Accepted — 2026-10-16. Supplements ADR-0006, ADR-0070 and ADR-0072.

## Context

The book library exposed two competing creation paths: “New blank book” on the
device side and a separate named “New cloud book” form. The second path always
created another blank document, so it added a decision without adding useful
editing capability. It also made the expected workflow—create, edit, save—less
clear.

## Decision

- The library and cloud-sync panel no longer expose a separate cloud-project
  creation form.
- A cloud book name is editable in place from both the library and cloud-sync
  panel. The edit is ephemeral UI state until the typed
  `cloudSync.renameProject` command validates and writes the new name through
  the user's data Worker.
- The data Worker exposes an authenticated project-metadata `PATCH` route.
  Renaming updates only the project's name and modification time; it does not
  rewrite its checkpoint, content chunks, operation history or lease.
- `cloudSync.saveCurrentAsProject` is a typed cloud-sync command. It creates a
  timestamped project, acquires its lease and uploads a complete checkpoint of
  the current document without replacing that document.
- Ordinary `file.saveProject` invokes this command only when the book has no
  native file destination, no active cloud project, and the signed-in user has
  a ready personal installation.
- An opened local `.echo8` book keeps saving to its retained local handle. An
  active cloud book keeps syncing to the same project. `Save As` always remains
  a local copy operation.
- If no ready personal cloud installation exists, the existing local Save flow
  remains the fallback. A failed cloud creation is surfaced as an error and
  does not silently claim that the book was saved elsewhere.

## Consequences

- The primary workflow is now “New blank book → edit → Save”.
- Cloud project names are generated as `新书籍 <month/day time>` and can be
  changed later by double-clicking the displayed name. Enter or F2 provides
  the equivalent keyboard entry path.
- The UI change does not alter the `.echo8` file format or the user-side D1
  schema.

## Verification

- Contract tests verify that first Save invokes the typed cloud command and
  marks the document revision saved without opening a native file picker.
- Existing tests continue to verify active-cloud Save, local-handle Save and
  local-copy Save As independently.
- Browser tests verify the stronger Continue action remains accessible and the
  library book-switch flow remains free of the in-canvas dirty confirmation.
- Data Worker tests verify authenticated rename, empty-name rejection, CORS
  support for `PATCH` and preservation of renamed metadata through bootstrap.
