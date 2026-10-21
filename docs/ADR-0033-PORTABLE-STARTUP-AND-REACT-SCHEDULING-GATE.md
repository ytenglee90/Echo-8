# ADR-0033: Keep the portable bundle unified until measurement justifies a second build

## Status

Accepted.

## Context

Code splitting and broad React transitions were proposed as general performance improvements. Echo-8 also has a hard portable-delivery requirement: one HTML file that works without a module server. Blob-backed dynamic modules, a second asset graph and delayed plugin injection would add lifecycle, CSP, file-origin and recovery paths. React transitions can make pointer-coupled previews lag behind the cursor.

## Decision

The portable build remains one HTML with an inline managed worker. On 2026-08-31 the final build measured 887,253 bytes and reached visible onboarding node cards in 158 ms on a local HTTP reload in the in-app Chromium environment, with no browser warnings or errors after the background index began. The build-tool warning for a chunk over 500 KiB is therefore recorded, not treated as proof of a user-visible startup failure.

The release gate now also exercises the generated artifact through a real local `file://` URL in a fresh browser context. It requires the onboarding canvas and editor to become usable, treats uncaught page errors, error-level console output and failed requests as failures, and rejects every non-document external request. The fast local gate uses Chromium; the release matrix repeats the hosted and portable checks in Firefox and WebKit. This catches engine-specific editing, origin and accidental asset-reference regressions that an HTTP Chromium development session cannot expose.

A hosted code-split build is deferred until repeatable profiling shows a material regression, such as a median visible-canvas startup above 500 ms on the agreed baseline device, or a large optional plugin dominating parse/compile time. If that threshold is crossed, the portable build remains unified and a separate hosted composition may lazy-load optional AI or semantic-provider view code through the plugin manager.

Canvas pan, zoom, drag, connection, selection and snapping previews continue to use coalesced per-frame ephemeral broadcasts. They must not be wrapped in `startTransition`. React transitions may be introduced only for measured non-urgent view derivations, such as a large search result list, a detailed AI audit report or inactive statistics, and only with a before/after profiler trace and interaction regression test.

## Consequences

- The common portable artifact keeps its simple offline and local-file deployment boundary.
- The application avoids architectural complexity that current startup evidence does not justify.
- The managed inline worker increases the bundle slightly while removing expensive search text loops from the UI thread.
- Bundle size and visible-canvas startup remain release measurements; this decision is revisited when thresholds are exceeded rather than by convention.
