# ADR-0022: Titleless groups and spatial selection scopes

## Status

Accepted.

## Problem

A group title strip no longer serves a current operation but still consumes canvas space and creates another hit region. Treating a set of all member IDs as if the group ID had been selected makes copy, ungroup and toolbar actions change meaning behind the user's back. Selecting both a group and all of its members during global Select All also produces duplicate node highlights and an unclear direct selection.

Box selection needs two distinct intents: a lasso that completely encloses the container selects the group, while a lasso that reaches only nodes inside it selects those nodes. Keyboard Select All also needs a local scope when the pointer is inside a group and a canvas-wide scope otherwise.

## Decision

The canvas renders groups as titleless derived frames with uniform 25-world-unit padding around member geometry. Legacy title, title-style and title-mark fields remain in the version-one record for file compatibility but do not affect bounds, hit testing or visible UI. No document migration is required.

Direct IDs are authoritative. A group operation requires the group ID to be directly present in selection. Selecting every member ID never implies, inserts or serializes the group ID. `selection.resolve@1` expands members only when the group ID was directly selected. Group clipboard serialization likewise requires the direct group ID.

The generic selection catalog adds the view-only `boxMatch` rule. Group entities use `contain`, so a lasso must contain the complete derived group bounds to hit the container. When a hit container and its contained nodes are both candidates, the selection plugin stores the container and removes those duplicate member IDs. A partial lasso does not hit the group and keeps only the nodes it reaches. Existing connection precedence remains unchanged.

Select All obtains the current world pointer through optional `canvas.pointer@1`, then asks optional `selection.scopeAt@1` providers for a spatial scope. The group provider deterministically chooses the smallest group bounds containing that point and returns its member nodes as direct selections. With no matching scope, Select All collapses the full catalog to top-level groups plus ungrouped entities. Thus group-local Select All highlights members, while canvas-wide Select All highlights the group frame and does not add black selected borders to its members.

Pointer tracking is an ephemeral coalesced `canvas.pointer.preview` signal. Canvas and group views publish world coordinates; the canvas model owns the current snapshot and capability. It never enters document state, workspace persistence or history, and stopping the canvas releases the capability.

## Consequences

- There is one visual group frame and no canvas title bar, divider or title text.
- Member-only operations remain member operations even when every group member is selected.
- A directly selected group still expands to all members for move, copy, cut and delete.
- Box selection and Select All have deterministic spatial behavior without importing another feature implementation.
- Stored legacy titles continue to round-trip through old and new project files but are intentionally invisible.

## Verification

Contracts cover partial member lasso, full-container lasso, connection precedence, group-scoped Select All, canvas-wide collapsed Select All, absence of member highlights by direct ID, rejection of ungroup when only all members are selected, member-only clipboard serialization, direct-group clipboard remapping, uniform title-independent group bounds and global undo behavior.
