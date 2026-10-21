# ADR-0071: Cloud-first save and personal AI boundary

## Status

Accepted — 2026-10-15. Supplements ADR-0006, ADR-0039, ADR-0056,
ADR-0067, ADR-0068 and ADR-0070.

## Context

A hosted cloud book already persists document transactions through the user's
own data Worker, but the local file plugin still interpreted an automatic
checkpoint without a native file handle as a reason to request a local save
location. The toolbar's Save command also continued to open the local file
picker. This mixed the primary cloud destination with optional local exports.

Correction rules are document resources and therefore already travel with a
cloud book. Local semantic model assets and indexes are intentionally
device-local. Remote AI and semantic API keys are personal secrets rather than
book data and must not be inserted into cloud checkpoints.

## Decision

- When a cloud project is active, `file.saveProject` invokes the public typed
  cloud synchronization command as a compound command. It never opens a local
  file picker. The existing `mod+s` shortcut therefore follows the same rule.
- Automatic local project output does not request a native destination while a
  cloud project is active. Browser recovery checkpoints continue independently,
  and the cloud plugin continues to debounce normal transaction uploads.
- `file.saveProjectAs` explicitly exports one local `.echo8` copy. It does not
  bind that file as an automatic-save destination or replace the current cloud
  target.
- Opening a local book explicitly disconnects the active cloud project after
  safely flushing it, preventing later local edits from entering the old cloud
  book.
- Correction and completion rules remain document-domain resources and are
  included in cloud checkpoints. Local semantic model binaries and derived
  indexes remain per-device. Local and remote semantic preferences and remote
  AI/semantic API keys remain per-device personal configuration, are excluded
  from book and cloud checkpoints, and can be transferred through the existing
  explicit personal-configuration export/import flow.
- Hosted UI states these boundaries directly. Cloud status occupies the first
  item in the file toolbar group, and the cloud panel exposes Return to Library.

## Consequences

- Save has one predictable meaning for an active cloud book, while users retain
  an explicit local-copy escape hatch.
- A browser or network failure still leaves the governed local recovery copy;
  Save reports a failure until the remote target acknowledges the sync.
- Moving to a new device restores book content and correction rules, but the
  user must redownload the local semantic model and re-enter remote API keys.
- No cloud schema, data Worker version or project file format change is needed.

## Verification

- Kernel contract tests verify cloud-first Save, suppression of local-location
  prompts, and one-shot local Save As without changing the active destination.
- Type, lint, architecture and browser workflow checks cover manifest ownership,
  toolbar ordering and the right-panel navigation entry.
