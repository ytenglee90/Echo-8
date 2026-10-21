# ADR-0070: Hosted book library entry and explicit project switching

## Status

Partially superseded by ADR-0076 for the portable-composition exclusion — 2026-10-17.
The hosted library and project-switching decisions remain accepted.

## Context

The hosted application previously entered one canvas immediately. That was
reasonable for a single local document, but it did not give a signed-in user a
safe place to create, name and choose among several cloud books. Automatically
opening the first remote project also made project selection implicit and made
it harder to distinguish the browser recovery copy, a local `.echo8` file and a
cloud book.

The portable single-HTML build remains a local file application and must not
gain hosted account or cloud-installation dependencies.

## Decision

- The hosted composition contributes a `book-library` plugin to the governed
  `application.welcome` slot. The library is the first surface on each hosted
  page load and can be reopened from a centrally registered toolbar action.
  Its open/closed state is ephemeral and never enters document history.
- The library uses only public typed commands and asks. Local opening remains
  owned by `import-export`; account status, login, installation, upgrades and
  remote project listing remain owned by `cloud-sync`.
- Core owns `system.document.new`. It creates a recovery point, replaces the
  document and history through the exclusive replacement boundary, records the
  current plugin catalog and checkpoints the new blank document. This avoids a
  feature plugin deleting namespaces directly.
- Cloud startup lists projects but does not acquire a lease or open one. A user
  explicitly selects a project. Before changing the active project, cloud sync
  flushes the old pending queue, releases its lease and clears the old local
  project binding. If the old project cannot be safely synchronized, switching
  fails visibly instead of carrying edits into another project.
- The earlier separate named-cloud-book creation path is superseded by
  ADR-0073: a blank local book becomes a cloud book on its first ordinary Save.
  Existing cloud books retain explicit names and selection in the library.
- Cloud account identity comes from the existing signed control session. The
  application never stores a Cloudflare password, OAuth grant or data token in
  canvas state.
- Hosted server rendering emits only the inert startup shell. The browser
  creates the application kernel from a React effect after hydration, so
  browser persistence and random identity generation never run in a
  Cloudflare Worker module or server-render scope.
- The original portable exclusion is retained here as historical context and
  superseded by ADR-0076. The `.echo8` cross-session boundary remains unchanged.

## Consequences

- One public URL now supports an account-facing library without coupling the
  shell to Cloudflare, file parsing or feature implementation modules.
- Local books remain user-chosen files. Cloud books gain explicit names and
  selection, while the browser recovery copy remains separately described.
- Switching books may pause briefly to finish the prior remote commit. A
  failure keeps the user in the current book and preserves its queued work.
- The project file format, cloud wire protocol, D1 schema and data Worker
  version do not change for this UI release.

## Verification

- Core contract tests verify blank replacement, cleared history and recovery
  point creation.
- Architecture and CSS tests enforce the public-command, governed-slot and
  stylesheet ownership boundaries. The hosted-runtime boundary test also
  prevents kernel construction from returning to a server-render initializer.
- Browser tests verify that the library gates the canvas, can be entered and
  can be reopened from the toolbar. Portable startup coverage is updated by
  ADR-0076.
