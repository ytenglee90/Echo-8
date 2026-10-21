# ADR-0010: Unified notices for long background tasks

## Status

Accepted.

## Problem

Opening or saving a very large project, rebuilding indexes, scanning content, calculating statistics, preparing AI context and checkpointing can continue long enough that an otherwise responsive canvas appears to have ignored the operation. Adding a separate loading popup to each plugin would duplicate timing, styling and cleanup logic and would create conflicting global overlays.

## Decision

The mandatory task scheduler is the single source of truth for long-operation feedback. Its additive task contract accepts a user-readable `label` and bounded `noticeAfterMs`. Every task is observable through a sanitized scheduler snapshot, including state, progress and whether its delayed notice threshold has elapsed.

The default threshold is 1.2 seconds. The scheduler owns that timer and clears it when work completes, fails, is cancelled or is removed with its plugin owner. The shell renders one passive, accessible notice stack from scheduler snapshots. It shows at most three tasks plus an aggregate count, does not block canvas interaction, and does not store UI state or enter history.

## Alternatives rejected

- Immediate spinners for every task cause distracting flashes during ordinary incremental work.
- Plugin-owned global dialogs duplicate presentation and can fight for focus and stacking order.
- Timing commands in the shell misses queued, retried and automatically scheduled work and crosses the message/task boundary.

## Compatibility

The task fields are additive. Tasks without a label fall back to their existing category, so existing and test task providers remain valid. Production tasks declare localized labels. No document, workspace or portable-file schema changes.

## Verification

The task contract test proves that quick work settles without surfacing, long work becomes visible only after its declared delay, and the notice record disappears after settlement. The existing scheduler tests continue to cover queueing, pause, retry, timeout and owner cancellation.
