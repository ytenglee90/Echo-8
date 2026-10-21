# ADR-0045: Supported large-canvas envelopes are exercised in a real browser

## Context

Headless contracts proved chunk storage, file round-tripping, search and spatial-index behavior, but they could not detect browser-only costs such as DOM mounting, layout, accessibility-tree updates or content-editable projection. A synthetic unit duration therefore was not enough evidence for the stated 2,000-node and 20,000,000-character product envelopes.

## Decision

A dedicated Playwright configuration builds a deterministic project in memory with 2,000 text nodes and one 20,000,000-character body, imports it through the public file UI and exercises only public user operations. The gate requires the ordinary viewport to mount fewer than 200 node cards, a full 2,000-node selection to settle within five seconds, the selection to return to one node, and the windowed editor to open and accept text within five seconds. An uncached whole-document count may continue after the editable 256 KiB window paints; the footer must expose that pending state rather than a false zero, and the gate then waits for the exact editor count and navigation count to converge. Uncaught page and console errors fail the run.

This suite is invoked by `pnpm run test:performance-browser` and by the complete `pnpm run verify` release command. It is intentionally separate from ordinary UI workflows so its larger fixture, longer timeout and hardware-sensitive budget are explicit. The existing large core contract test is not split or moved.

## Consequences

- Browser rendering regressions now fail before release even when headless models remain fast.
- The test checks the product's two supported envelopes together without creating the much larger unsupported combination of 2,000 individual 20-million-character bodies.
- Budgets may be revised only with recorded measurements and an architecture decision; a failing threshold is not silently raised.
- Other browser engines remain compatibility gates. Chromium is the local performance reference so cross-machine engine variance is not mistaken for one stable performance baseline.
