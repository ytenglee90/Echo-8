# ADR-0002: Flat groups and provider-planned internal clipboard

## Status

Accepted for the first group and clipboard slice.

## Decision

Version one groups are flat containers. A text node belongs to at most one group, group position is derived from member-node geometry, and a group stores only its stable ID, member IDs, retained legacy title metadata and revision metadata. Titles are no longer rendered as refined by ADR-0022. Ungroup deletes only the container. Deleting members repairs the group in the same transaction and removes the container when fewer than two members remain. Group containers and member nodes are independently selectable.

The internal clipboard uses `application/x-echo-8-canvas+json` version 1. Copy asks every `clipboard.serialize@1` provider for its own fragment. Paste preallocates fresh IDs for every serialized entity, then asks every `clipboard.instantiate@1` provider for owner-labelled standard patches. Text, connection and group patches are committed as one history entry. Cut commits the workspace clipboard first and queues the ordinary selection-delete command for the next command turn.

## Consequences

- The group plugin never writes node positions or calls the text-node plugin.
- Copying a directly selected group preserves internal connections and its group container; directly selecting all members copies only those members.
- Cross-project identity collisions are avoided because paste never reuses source IDs.
- System clipboard MIME exchange remains a future permission-adapter feature; this slice is an application-internal clipboard with a bounded plain-text preview.
- Nested groups and multiple group membership require a new schema version and explicit migration rather than a silent behavior change.

## Verification

Contract tests cover unique membership, retained multiline title data, member-deletion repair, identity remapping, one-entry paste undo, cut ordering and required-capability stop arbitration.
