# ADR-0023: Fresh-canvas onboarding as ordinary explicit-only text nodes

## Status

Accepted.

## Problem

A fresh session previously created one architecture-demo node. It did not explain the actual AI workflow, model and semantic KEY configuration, memory evidence rules, or daily canvas operations. Replacing it with rich guides creates another risk: common words such as “总结”“处理” and “资料” can cause the guides themselves to pollute automatic AI retrieval.

## Decision

When the text-node plugin starts against an empty document, it dispatches two history-free `node.seed` commands through the normal command router. The resulting records are ordinary editable, selectable, searchable, exportable and deletable text nodes:

- AI assistant usage, model/KEY setup, two-stage sending, memory, conflict and hybrid semantic retrieval;
- canvas creation, editing, selection, grouping, connection, search, file and shortcut operations.

The previous architecture-demo node is no longer created. Seeding runs only during initial empty-document startup. Restarting the plugin against retained nodes does not duplicate the guides, and replacing the document with an opened project removes the temporary fresh-session document as usual.

Each onboarding node carries text-owned `automaticContext: false`. The generic `AIContextSource` projection exposes this as the additive `automaticRetrieval: false` flag. Lexical and remote semantic index providers skip such sources without recognizing their titles or importing text-node internals. The assistant catalog and range-read capabilities still expose them, so an explicit `@` reference remains valid. Canvas-wide user search continues to include them.

## Compatibility and migration

The new text-node field is optional. Missing values mean normal automatic retrieval, so existing files need no migration. Previously saved architecture-demo nodes are user content and are not silently deleted; only newly initialized empty canvases use the new guides.

## Verification

Contract tests verify two seeded ordinary nodes, readable guide bodies, zero undo entries, no duplication after hot restart, exclusion from automatic context search, explicit catalog visibility, updated statistics/search counts and absence of unrelated guide sources in an explicitly referenced AI request.
