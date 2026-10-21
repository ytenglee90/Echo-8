# Echo-8 performance budgets

These are engineering gates, not promises that every possible dataset fits in browser memory. Measurements must record browser, hardware, build mode and dataset. A regression is investigated before the budget is relaxed.

## Supported envelopes

| Scenario | Required design | Automated gate |
| --- | --- | --- |
| 2,000 ordinary text nodes | incremental catalog; spatial-index viewport culling; distant-zoom正文 LOD; derived geometry; no combined body string | canvas-wide literal search completes under 10 s, the spatial index exactly matches a linear 2,000-entity query, and a real browser keeps the ordinary viewport below 200 node cards |
| One 20,000,000-character text node | 64 Ki independent chunks; bounded reads; windowed editor | create under 5 s; one-character middle edit under 1 s; save and parse each under 5 s; the real browser opens its editor and accepts an input within 5 s |
| Global history | standard owner-labelled patches only; continuous edit sessions compact intermediate immutable chunk generations | at least 1,000 meaningful entries; local huge-document edit stays below 200 KiB serialized forward patches; a 500-edit chunk session retains only its initial and final generations |
| Editor DOM | never mount an unbounded正文 | 256 KiB maximum active window above the full-editor threshold |
| Pointer interaction | coalesced ephemeral preview | one durable transaction only on release |
| Dense visible connections | viewport culling; one batched SVG path above 600 visible edges; spatial pointer hit testing | rendering mode switches without changing connection state or selection broadcasts |
| Background work | shared cancellable scheduler plus kernel-managed worker execution | search, statistics, AI, import/export and automatic checkpoints declare category and priority; CPU-heavy search index jobs do not execute their text loops on the shipped browser UI thread |
| AI streaming | ephemeral answer/reasoning projection; one joined update per visual frame | a 1,000-delta mixed-channel batch preserves order and produces one reduced state without per-token rendering |
| Persistence | journal first, checkpoint later | pending mergeable journal records are compacted; journal/checkpoint I/O is serialized; immutable正文 chunks are reference-captured and externalized before worker transfer; native project handles receive bounded streaming writes |

## Interactive frame targets

- Pointer pan, zoom and drag previews target 60 Hz on a normal visible viewport; a frame over 16.7 ms is a warning, not permission to commit on every pointer event.
- Typing must update the active text window before low-priority statistics, indexing or checkpoint work. Nonessential derived work is delayed or cancelled on newer revisions.
- Deterministic correction and title-reference analysis is limited to a 16 KiB caret-centred interactive window; distant text is reconsidered when the caret moves instead of being synchronously rescanned on every keystroke.
- Canvas DOM rendering is proportional to visible nodes and group frames plus a small overscan area, never the total entity count. Below `0.5` zoom, visible node cards retain title, selection and interactions but do not mount unreadable正文 preview elements. Connections use individual accessible hit paths at ordinary density; above 600 visible edges they collapse into one batched SVG path and use the same spatial index plus curve-distance testing for pointer selection. Camera changes query rebuildable spatial indexes; they do not linearly scan all entities. Drag and resize previews union only affected candidates before an exact bounds check.
- A high-frequency preview may emit a coalesced signal. It must not create history, trigger an immediate full save or synchronously rescan the canvas.
- A body-only edit must not rebuild node, connection or group geometry. Geometry consumers ignore catalog invalidations that do not carry the geometry flag.
- Feature plugins must not create unmanaged workers. Worker jobs are namespaced, declared in the manifest, cancellable by owner and limited to derived computation over bounded immutable inputs.

## Memory rules

- The 2,000-node and 20,000,000-character targets are independent stress cases. They are not multiplied together.
- Stored text is copied only at explicit boundaries: patch ownership, stable snapshot, file serialization or requested read range.
- A feature must not call a whole-namespace read on `textContentChunk`, concatenate all bodies, or cache duplicate full documents.
- Search results and AI context contain bounded excerpts with source IDs, ranges and revisions.
- Derived indexes, previews and counts are rebuildable and excluded from portable files and recovery history.

## Release checklist

1. Run type checking and linting.
2. Run all architecture and behavior contracts.
3. Record the 20-million-character and 2,000-node test durations.
4. Build the normal application.
5. Build the portable HTML and assert it has no external `./assets/` references.
6. Open the generated artifact through `file://` in a fresh browser context, reject external requests and confirm that node creation and editing work without a server.
7. Confirm the portable artifact size and local HTTP availability.
8. Run the real-browser extreme gate with 2,000 nodes and one 20,000,000-character node; verify culling, full selection, editor opening and input latency.
9. If a budget fails, identify the phase and allocation source; do not hide the regression by raising the threshold without an ADR.
10. Run the Chromium end-to-end gate and the Firefox/WebKit release matrix; reject any plugin-boundary isolation error, uncaught page error or command timeout.

## Recorded baseline — 2026-08-31

These observations describe the current local test environment and are not universal hardware promises:

- portable artifact: 887,253 bytes, including the inline managed worker;
- local HTTP reload to visible onboarding node cards: 158 ms;
- browser console after background index startup: no warnings or errors;
- 2,000-node canvas-wide search contract: 4,021 ms, below the 10-second gate;
- 20,000,000-character chunk/edit/file contract: 477 ms;
- 250,169,159-byte brutal project parse: 3,259 ms, 2,000 nodes, 219,900,000 total characters, 8,000 connections and 200 groups;
- brutal parse process peak observation: 683 MiB RSS and 510 MiB used heap.

The portable bundle warning above 500 KiB is accepted under ADR-0033 because measured visible startup is below the 500 ms review threshold. A hosted split build remains a future response to measured parse/compile pressure, not a default rewrite.

## Verification update — 2026-09-05

The complete release gate was rerun after the command-routing, asynchronous-observer, streamed-save and browser-regression changes:

- portable artifact: 1,007,663 bytes, with no external build-asset reference;
- 2,000-node canvas-wide search contract: 4,151 ms, below the 10-second gate;
- 20,000,000-character chunk/edit/file contract: 465 ms;
- 150 architecture and behavior contracts passed;
- 5 critical Chromium workflows passed in 4.5 seconds.

The earlier cold-start and brutal-project figures remain historical observations rather than silently being presented as freshly remeasured values.

## Compatibility verification update — 2026-09-09

The release gate was rerun after editor projection/revision arbitration and native-file write serialization changes:

- portable artifact: 1,128,779 bytes, with no external build-asset reference;
- 2,000-node canvas-wide search contract: 4,156 ms, below the 10-second gate;
- 20,000,000-character chunk/edit/file contract: 461 ms;
- 249 architecture and behavior contracts passed;
- 19 critical Chromium workflows passed in 19.9 seconds;
- the browser workflow now includes completion-caret isolation, title-link boundaries, rapid typing during format changes and stale-projection rejection;
- file contracts now include same-handle serialization, automatic-save coalescing and exported filename synchronization.

## Cross-engine and local-file verification update — 2026-09-10

- 250 architecture and behavior contracts passed;
- all 19 hosted Chromium workflows passed in 21.2 seconds;
- all 19 hosted WebKit workflows passed in 1.4 minutes;
- the generated 1,129,252-byte portable HTML opened through a real `file://` URL, created a node and accepted editor input in both Chromium and WebKit without any external request or console/page error;
- WebKit exposed and now guards a programmatic `@` mention/local-undo ordering race in the AI composer;
- the downloaded Firefox runtime could not establish Playwright's automation pipe on this Windows host, before any Echo-8 page loaded. Firefox remains mandatory in the Linux release workflow rather than being reported as an application failure or a local pass.

These remain measurements of the current machine. Product behavior is additionally protected by deterministic plain-text DOM projection, IME isolation, revision gates and the CI cross-engine matrix.

## Search, semantic memory and browser-envelope verification — 2026-09-14

- 257 architecture and behavior contracts passed;
- all 19 hosted Chromium workflows passed in 22.5 seconds;
- the generated portable artifact is 1,138,710 bytes and passed its real `file://` startup/edit gate without external network or disk assets;
- the dedicated browser performance gate opened a canvas containing 2,000 nodes and one 20,000,000-character正文, kept the ordinary viewport below 200 mounted node cards, selected all 2,000 nodes, returned to one selection, opened the windowed editor and accepted new text; the latest complete release run passed in 11.9 seconds;
- compressed local postings, paragraph-level semantic blocks, model-aware evidence budgets and the declarative memory-accuracy evaluation all passed their deterministic release gates.

The browser performance fixture deliberately uses a realistic bounded-line ASCII正文. This preserves the 20,000,000 UTF-16-character storage and editor envelope without turning the check into an unrelated 60 MiB test-framework upload limit or a pathological single-unbroken-line layout benchmark.
