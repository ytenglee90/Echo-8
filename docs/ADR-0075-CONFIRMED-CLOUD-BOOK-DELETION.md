# ADR-0075: Confirmed cloud-book deletion from every book surface

## Status

Accepted — 2026-10-17. Supplements ADR-0067, ADR-0070 and ADR-0073.

## Context

Cloud books could be listed, opened and renamed from both the hosted library and
the cloud-sync panel, but neither surface exposed deletion. Adding independent
network deletion logic to both React views would duplicate destructive-state
handling and let the library bypass the cloud-sync owner.

Deleting the active cloud book also needs an explicit local-content policy. A
remote deletion must not silently remove the currently open canvas or leave its
pending commits targeting a project that can no longer be opened.

## Decision

- `cloud-sync` remains the sole owner of cloud-project deletion. The library and
  sync panel dispatch the typed `cloudSync.requestDeleteProject` command; neither
  view calls the data Worker directly.
- The request opens one cloud-owned contribution in the governed
  `overlay.modal` slot. Cancel, Escape and confirm use separate typed commands,
  and the selected project is revalidated against the pending confirmation.
- Confirm sends the existing authenticated `DELETE /v1/projects/:id` request.
  The data Worker tombstones the project, so project listing and bootstrap stop
  exposing it immediately. The action is not part of canvas undo history.
- Deleting a non-active book only removes it from the shared project catalog.
- Deleting the active book first waits for already admitted sync work and
  creates a browser recovery checkpoint. After remote deletion, cloud-sync
  clears the project binding and its pending upload queue but leaves the current
  document open as an unconnected local canvas. A later ordinary Save may create
  a new cloud book under the existing first-save policy.
- A remote 404 during confirmation is treated as idempotent success because the
  requested project is already unavailable. Other network failures keep the
  confirmation open and preserve the binding and queue.

## Consequences

- Both book surfaces expose the same deletion semantics and confirmation copy.
- The operation removes the cloud book from normal user access but does not
  delete separately exported `.echo8` files.
- The current project file format, D1 schema, browser wire version and data
  Worker release version do not change because the authenticated DELETE route
  and tombstone column already existed.

## Verification

- Data-Worker contract tests verify that DELETE removes a book from listing and
  makes bootstrap return not found.
- Browser tests exercise cancel and confirm from the hosted library and confirm
  from the cloud-sync panel.
- Type, lint, architecture, hosted browser and portable packaging gates continue
  to verify manifest permissions, governed modal ownership and plugin isolation.
