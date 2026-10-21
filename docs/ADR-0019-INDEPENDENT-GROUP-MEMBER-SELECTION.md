# ADR-0019: Independent group-container and member selection

## Status

Superseded by ADR-0022. The independent direct-selection rule remains; title rendering, lasso containment and Select All semantics are replaced.

## Problem

The first group selection contract treated a group as an atomic boundary for every input mode. Pointing at a member node was rewritten to the group ID before the selection was stored. That made the group easy to move as one object, but it also prevented a member from showing the normal node highlight or participating independently in copy, cut, paste, delete, additive/subtractive selection and connection commands.

The group title also accumulated a separate rich-text editing surface and formatting controls. Those controls duplicated editor behavior and made the group frame intercept more interaction than its container role requires.

## Decision

A group and each of its text-node members are separate directly selectable entities. `selection.set`, point selection, add/remove/toggle selection and Select All preserve their direct IDs. Selecting a member never rewrites it to its containing group. Selecting a group stores only the group ID; `selection.resolve@1` expands its `contains` list only when an operation needs the group contents, such as whole-group movement, deletion, copy or cut.

Lasso selection uses optional `boxRegions` from the selection catalog. A group exposes its title strip and four visual frame edges as lasso regions while retaining its full bounds for focus and viewport calculations. A lasso wholly inside the group content therefore selects intersected member nodes without silently selecting the container. A lasso covering the frame can select the group and members together. Connections remain directly selectable but excluded from Select All and are omitted whenever a box also hits nodes or groups.

The group title becomes display-only. New groups retain a default title, and existing multiline/rich title data remains readable and portable, but title editing, formatting controls, preview signals and title mutation commands are removed. This changes no document schema and requires no migration.

The selected group frame uses the shared selection token with a three-pixel solid border and an additional focus ring. Member nodes use the existing `.text-node-card.selected` style, so nodes inside and outside groups have identical selection feedback.

## Consequences

- A selected group remains an independent container in workspace selection state.
- A selected member can be copied, cut, deleted, moved, resized, opened or connected without selecting its group.
- Selecting the group still applies whole-container operations to all members through public resolution, without storing hidden member selections.
- Select All may contain a group and its members at the same time; operation expansion deduplicates their IDs.
- Old files keep their title text and styling, but the current UI does not modify it.

## Verification

Contract tests cover member-only lasso selection, connection commands from a member, direct member deletion with group repair, group-only expansion, Select All containing groups and members, member-only copy/paste preserving the original group, and absence of title mutation commands. Existing group movement, membership, clipboard remapping, history and hot-stop tests remain release gates.
