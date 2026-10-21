# ADR-0007: Action catalog, shortcut arbitration and sanitized diagnostics

## Status

Accepted for the command-palette, shortcut-center and diagnostic-center slice.

## Problem

Feature plugins need discoverable commands and configurable shortcuts without inserting logic into the shell or calling one another. Shortcut changes must never create an ambiguous keyboard route. Diagnostics must remain useful when a feature is faulted without gaining permission to read正文 or plugin-private records.

## Decision

The mandatory UI runtime owns two declarative registries:

- actions, keyed by plugin owner plus stable action ID;
- shortcuts, keyed by plugin owner plus stable shortcut ID, with one computed effective chord map.

Plugins declare action and shortcut IDs in their manifests before registration. Every contribution is tracked as an owned resource and disappears on stop. The command palette only asks `system.actions` and `system.shortcuts`; choosing an item broadcasts `system.action.execute`. The core re-resolves the action at execution time and queues the contributed command after the current serialized command turn. The palette never imports or calls a feature implementation.

The shell derives a panel-local ink, muted ink, faint ink, border, control and hover set from the active semantic `panel` background. Governed right-side panels, floating panels and the command palette receive those tokens at their contribution roots; modal dialogs, task notices and inline suggestion surfaces receive the same scope at their own surface roots. Search text, placeholders, action labels, plugin names, group headings, shortcuts, controls, empty/error states and footer text all follow the panel's actual luminance. Document paper and node content remain outside this chrome scope. Feature actions do not choose presentation colors, and switching between bright, dark or custom semantic themes requires no feature-state change.

Shortcut overrides are personal workspace data owned by `shortcut-center`. It submits the complete desired override set to the UI runtime. The runtime normalizes chords, rejects modifier-only chords, checks duplicate controllers and computes all effective bindings before replacing the current set. A conflict leaves the previous effective map unchanged. Stopping the plugin releases its override controller and restores plugin defaults while retaining the preferences for a later restart.

The core exposes `system.runtime` as a read-only diagnostic projection. It includes domain revisions and record counts, plugin states, resource counts, task queues, history depth, persistence state, active interaction, registered capabilities/actions/shortcuts, message counters and recent sanitized errors. It does not include store values. Diagnostic detail is reduced to bounded primitive summaries, error name/message, array length or object key names.

## State and history

Command-palette visibility, diagnostic visibility and shortcut choices use separate workspace namespaces. Their transactions explicitly disable global document history. Executed feature actions retain the normal history semantics of their target commands.

## Alternatives rejected

- Building the command palette from hard-coded feature imports would couple it to every plugin and break hot removal.
- Letting plugins attach global `keydown` listeners would make collision order nondeterministic and cleanup unverifiable.
- Persisting only the final chord-to-command map would lose ownership and make plugin stop/restart unsafe.
- Returning complete store snapshots to diagnostics would expose正文 and private plugin data.

## Compatibility

The plugin manifest gains an `actions` declaration and the scoped UI context gains action and shortcut-override methods. This is an additive API-version-one contract during the pre-release phase. Older built-in manifests receive an empty action declaration through `defineManifest`.

## Verification

Tests cover atomic conflict rejection, restoration of defaults, workspace-only shortcut persistence, override cleanup on hot stop, action execution through the system broadcast, action cleanup, panel-local light/dark text contrast across governed panels and popup surfaces, and absence of unique document content in the runtime diagnostic projection.
