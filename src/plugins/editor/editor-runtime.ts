import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import {
  countNonWhitespaceGraphemes,
  countWritingUnits,
  updateWritingUnitCount,
} from '../../services/text-metrics.ts';
import type { ContentMetricsSnapshotV3 } from '../../protocols/content.ts';
import type { AppearancePreview } from '../../protocols/appearance.ts';
import type { AnnotationClipboardItem } from '../../protocols/annotations.ts';
import type {
  EditorDocumentInvalidation,
  EditorFormatStepRequest,
  EditorMetricsSnapshot,
  EditorPaneState,
  MoveContentRangeRequest,
  WritingActivityKind,
  WritingMetricsSnapshot,
} from '../../protocols/editor.ts';
import type {
  TextDocumentFormat,
  TextFormatMark,
  TextFormattingSnapshot,
} from '../../protocols/formatting.ts';
import {
  inferFormatTarget,
  resolveActiveFormat,
  resolveFormatAtOffset,
  resolveFormatBrushRange,
  resolveFormatRange,
} from './format-target.ts';
import { DEFAULT_EDITOR_DOCK_WIDTH, EDITOR_READ_WINDOW } from './constants.ts';
import { FORMAT_STEP_OPTIONS } from './format-options.ts';
import {
  calculateTextDelta,
  rebaseTextDelta,
  type TextDelta,
} from './text-edit.ts';

const MAX_DOM_DOCUMENT = EDITOR_READ_WINDOW;

export interface EditorDocumentSummary {
  id: string;
  title: string;
  length: number;
  revision: number;
}

export interface LoadedEditorDocument extends EditorDocumentSummary {
  body: string;
  windowStart: number;
  characters: number;
  writingUnits: number;
  metricsPending: boolean;
  tooLarge: boolean;
  formatRevision: number;
  format: TextDocumentFormat;
  marks: TextFormatMark[];
}

interface BodyPreview {
  id: string;
  body: string;
  windowStart: number;
  characters: number;
  writingUnits: number;
  source: string;
}

export interface EditorSelectionPreview {
  id: string;
  characters: number;
  writingUnits: number;
  start: number;
  end: number;
  focused?: boolean;
  screenAnchor?: { x: number; y: number };
}

interface FormatPreview extends TextFormattingSnapshot {
  source: string;
}

export interface EditorBodyEdit {
  previous: string;
  next: string;
  delta?: TextDelta;
  baseOffset?: number;
  kind: WritingActivityKind;
  typingSessionId: string;
  inheritFormat?: TextDocumentFormat;
  annotationCopies?: AnnotationClipboardItem[];
  move?: Omit<MoveContentRangeRequest, 'nodeId' | 'expectedRevision'>;
}

interface FormatBrush {
  sourceNodeId: string;
  sourceStart: number;
  sourceEnd: number;
  format: TextDocumentFormat;
}

export const EMPTY_EDITOR_STATE: EditorPaneState = {
  openPanes: [],
  dockWidth: DEFAULT_EDITOR_DOCK_WIDTH,
  paneRecency: {},
  paneWindows: {},
  paneRatios: {},
};

export function useEditorRuntime(client: ViewClient) {
  const editorVersion = useSyncExternalStore(
    client.subscribeState,
    () => client.getOwnStateVersion('editor'),
    () => 0,
  );
  const metricsVersion = useSyncExternalStore(
    client.subscribeState,
    () => client.getOwnStateVersion('editorMetrics'),
    () => 0,
  );
  const capabilityVersion = useSyncExternalStore(
    client.subscribeCapabilities,
    client.getCapabilityVersion,
    () => 0,
  );
  const now = useSyncExternalStore(client.subscribeClock, client.getClock, () => 0);
  const instanceId = useRef(createEditorViewId('editor-view')).current;
  const [state, setState] = useState<EditorPaneState>(EMPTY_EDITOR_STATE);
  const [documents, setDocuments] = useState<LoadedEditorDocument[]>([]);
  const [metrics, setMetrics] = useState<Record<string, WritingMetricsSnapshot>>({});
  const [selections, setSelections] = useState<Record<string, EditorSelectionPreview>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [titleErrors, setTitleErrors] = useState<Record<string, string>>({});
  const [previewDockWidth, setPreviewDockWidth] = useState<number>();
  const [previewPaneRatios, setPreviewPaneRatios] = useState<Record<string, number>>();
  const [formatBrush, setFormatBrush] = useState<FormatBrush>();
  const [appearancePreview, setAppearancePreview] = useState<AppearancePreview>();
  const [reloadToken, setReloadToken] = useState(0);
  // Body and format commands share one per-node lane because both can advance
  // the formatting revision. Separate queues race under fast input/formatting
  // and make browser scheduling differences visible as stale or lost changes.
  const mutationQueues = useRef(new Map<string, Promise<void>>());
  const pendingContent = useRef(new Map<string, number>());
  const pendingFormats = useRef(new Map<string, number>());
  const contentRevisions = useRef(new Map<string, number>());
  const contentLengths = useRef(new Map<string, number>());
  const contentFaults = useRef(new Set<string>());
  const staleContent = useRef(new Set<string>());
  const authorityEpoch = useRef(0);
  const formatRevisions = useRef(new Map<string, number>());
  const characterCounts = useRef(new Map<string, number>());
  const writingUnitCounts = useRef(new Map<string, number>());
  const selectionRanges = useRef(new Map<string, EditorSelectionPreview>());

  useEffect(() => {
    let current = true;
    void client.ask<EditorPaneState>('editor.state').then((next) => current && setState(next));
    return () => {
      current = false;
    };
  }, [client, editorVersion]);

  const paneKey = state.openPanes.join('\u0000');
  useEffect(() => {
    let current = true;
    const loadEpoch = authorityEpoch.current;
    const load = async () => {
      const summaries = await client.request<EditorDocumentSummary[]>('content.summariesById@1', {
        nodeIds: state.openPanes,
      });
      const loaded = await Promise.all(state.openPanes.map(async (id) => {
        const summary = summaries.find((item) => item.id === id);
        if (!summary) return undefined;
        const existing = documents.find((item) => item.id === id);
        const pending = (pendingContent.current.get(id) ?? 0) > 0;
        const formatPending = (pendingFormats.current.get(id) ?? 0) > 0;
        const tooLarge = summary.length > MAX_DOM_DOCUMENT;
        const requestedWindow = tooLarge ? state.paneWindows[id] ?? existing?.windowStart ?? 0 : 0;
        const windowStart = tooLarge
          ? Math.max(0, Math.min(Math.max(0, summary.length - 1), requestedWindow))
          : 0;
        const format = await client.request<TextFormattingSnapshot>('content.formatting@2', {
          nodeId: id,
          start: windowStart,
          length: tooLarge ? Math.min(EDITOR_READ_WINDOW, summary.length - windowStart) : summary.length,
        });
        let body = existing?.body ?? '';
        if (!pending) {
          body = tooLarge
            ? (await client.request<{ text: string }>('content.read@1', {
                nodeId: summary.id,
                start: windowStart,
                length: Math.min(EDITOR_READ_WINDOW, summary.length - windowStart),
              })).text
            : await readWholeDocument(client, summary);
        }
        const reusableMetrics = existing?.revision === summary.revision;
        const metricsPending = tooLarge && !reusableMetrics;
        const characters = reusableMetrics
          ? existing.characters
          : tooLarge ? 0 : countNonWhitespaceGraphemes(body);
        const writingUnits = reusableMetrics
          ? existing.writingUnits
          : tooLarge ? 0 : countWritingUnits(body);
        const resolvedFormat = formatPending && existing
          ? { revision: existing.formatRevision, format: existing.format, marks: existing.marks }
          : format;
        characterCounts.current.set(id, characters);
        writingUnitCounts.current.set(id, writingUnits);
        return {
          ...summary,
          revision: pending && existing ? existing.revision : summary.revision,
          body,
          windowStart,
          characters,
          writingUnits,
          metricsPending,
          tooLarge,
          formatRevision: resolvedFormat.revision,
          format: resolvedFormat.format,
          marks: resolvedFormat.marks,
          contentAuthoritative: !pending,
          formatAuthoritative: !formatPending,
        };
      }));
      if (!current || loadEpoch !== authorityEpoch.current) return;
      const preserveContent = new Set<string>();
      const preserveFormat = new Set<string>();
      for (const loadedDocument of loaded.filter(Boolean)) {
        const document = loadedDocument!;
        if (!document.contentAuthoritative || (pendingContent.current.get(document.id) ?? 0) > 0) {
          preserveContent.add(document.id);
        } else {
          contentRevisions.current.set(document.id, document.revision);
          contentLengths.current.set(document.id, document.length);
          contentFaults.current.delete(document.id);
        }
        if (!document.formatAuthoritative || (pendingFormats.current.get(document.id) ?? 0) > 0) {
          preserveFormat.add(document.id);
        } else {
          formatRevisions.current.set(document.id, document.formatRevision);
        }
      }
      setDocuments((currentDocuments) => loaded.filter(Boolean).map((loadedDocument) => {
        const candidate = loadedDocument!;
        const next: LoadedEditorDocument = {
          id: candidate.id,
          title: candidate.title,
          length: candidate.length,
          revision: candidate.revision,
          body: candidate.body,
          windowStart: candidate.windowStart,
          characters: candidate.characters,
          writingUnits: candidate.writingUnits,
          metricsPending: candidate.metricsPending,
          tooLarge: candidate.tooLarge,
          formatRevision: candidate.formatRevision,
          format: candidate.format,
          marks: candidate.marks,
        };
        const local = currentDocuments.find((item) => item.id === next.id);
        if (!local) return next;
        return {
          ...next,
          ...(preserveContent.has(next.id) ? {
            body: local.body,
            revision: local.revision,
            length: local.length,
            characters: local.characters,
            writingUnits: local.writingUnits,
            metricsPending: local.metricsPending,
            windowStart: local.windowStart,
            tooLarge: local.tooLarge,
          } : {}),
          ...(preserveFormat.has(next.id) ? {
            formatRevision: local.formatRevision,
            format: local.format,
            marks: local.marks,
          } : {}),
        };
      }));
    };
    void load().catch((error) => current && setErrors((value) => ({
        ...value,
        workspace: error instanceof Error ? error.message : String(error),
      })));
    return () => {
      current = false;
    };
    // documents is the local buffer while a durable command is pending.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capabilityVersion, client, editorVersion, paneKey, reloadToken, state.paneWindows]);

  const documentMetricsKey = documents.map((document) => `${document.id}:${document.revision}`).join('\u0000');
  useEffect(() => {
    if (documents.length === 0) return;
    const controller = new AbortController();
    const frame = globalThis.requestAnimationFrame?.(() => {
      void client.request<ContentMetricsSnapshotV3>('content.metrics@3', {
        nodeIds: documents.map((document) => document.id),
      }, controller.signal).then((snapshot) => {
        if (controller.signal.aborted) return;
        setDocuments((current) => current.map((document) => {
          const metric = snapshot.byNode[document.id];
          if (!metric || metric.revision !== document.revision ||
            (pendingContent.current.get(document.id) ?? 0) > 0) return document;
          characterCounts.current.set(document.id, metric.nonWhitespaceGraphemes);
          writingUnitCounts.current.set(document.id, metric.writingUnits);
          return {
            ...document,
            characters: metric.nonWhitespaceGraphemes,
            writingUnits: metric.writingUnits,
            metricsPending: false,
          };
        }));
      }).catch(() => undefined);
    }) ?? 0;
    return () => {
      if (frame) globalThis.cancelAnimationFrame?.(frame);
      controller.abort();
    };
    // Exact whole-document metrics run only after the editable window has
    // painted. This keeps very large documents interactive while preserving
    // the same eventual count used by the navigation statistics.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, documentMetricsKey]);

  useEffect(() => {
    let current = true;
    if (state.openPanes.length === 0) {
      return () => {
        current = false;
      };
    }
    void client.request<EditorMetricsSnapshot>('editor.metrics@1', { nodeIds: state.openPanes }).then(
      (snapshot) => current && setMetrics(snapshot.byNode),
    );
    return () => {
      current = false;
    };
  }, [client, metricsVersion, paneKey, state.openPanes]);

  useEffect(
    () => client.subscribeSignal<BodyPreview>('editor.body.preview', (message) => {
      characterCounts.current.set(message.payload.id, message.payload.characters);
      writingUnitCounts.current.set(message.payload.id, message.payload.writingUnits);
      setDocuments((current) => current.map((document) => message.payload.id === document.id
        && message.payload.windowStart === document.windowStart
        ? {
            ...document,
            body: message.payload.body,
            characters: message.payload.characters,
            writingUnits: message.payload.writingUnits,
          }
        : document));
    }),
    [client],
  );

  useEffect(
    () => client.subscribeSignal<{ id: string; title: string }>('editor.title.preview', (message) => {
      setDocuments((current) => current.map((document) => message.payload.id === document.id
        ? { ...document, title: message.payload.title }
        : document));
    }),
    [client],
  );

  useEffect(
    () => client.subscribeSignal<FormatPreview>('editor.format.preview', (message) => {
      setDocuments((current) => current.map((document) => message.payload.nodeId === document.id
        ? {
            ...document,
            format: message.payload.format,
            marks: message.payload.marks,
            formatRevision: message.payload.revision,
          }
        : document));
    }),
    [client],
  );

  useEffect(
    () => client.subscribeSignal<EditorSelectionPreview>('editor.selection.preview', (message) => {
      selectionRanges.current.set(message.payload.id, message.payload);
      setSelections((current) => ({ ...current, [message.payload.id]: message.payload }));
    }),
    [client],
  );

  useEffect(
    () => client.subscribeSignal<{ width: number }>('editor.dock.resize.preview', (message) => {
      setPreviewDockWidth(message.payload.width);
    }),
    [client],
  );

  useEffect(
    () => client.subscribeSignal<{ ratios: Record<string, number> }>('editor.panes.resize.preview', (message) => {
      setPreviewPaneRatios(message.payload.ratios);
    }),
    [client],
  );

  useEffect(
    () => client.subscribeSignal<EditorDocumentInvalidation>('editor.document.invalidated', (message) => {
      const payload = message.payload;
      const contentStale = (payload.content ?? []).some(({ id, revision }) =>
        state.openPanes.includes(id) && (revision === undefined ||
          (contentRevisions.current.get(id) ?? -1) < revision));
      const formattingStale = (payload.formatting ?? []).some(({ id, revision }) =>
        state.openPanes.includes(id) && (revision === undefined ||
          (formatRevisions.current.get(id) ?? -1) < revision));
      const metadataStale = (payload.metadataIds ?? []).some((id) => state.openPanes.includes(id));
      if (payload.all || contentStale || formattingStale || metadataStale) {
        authorityEpoch.current += 1;
        if (payload.all) {
          for (const id of state.openPanes) staleContent.current.add(id);
        } else {
          for (const { id, revision } of payload.content ?? []) {
            if (state.openPanes.includes(id) && (revision === undefined ||
              (contentRevisions.current.get(id) ?? -1) < revision)) {
              staleContent.current.add(id);
            }
          }
        }
        setReloadToken((value) => value + 1);
      }
    }),
    [client, state.openPanes],
  );

  useEffect(
    () => client.subscribeSignal<AppearancePreview>('appearance.color.preview', (message) => {
      setAppearancePreview(message.payload.clear ? undefined : message.payload);
    }),
    [client],
  );

  const previewBody = (
    id: string,
    windowStart: number,
    previous: string,
    body: string,
    preparedDelta?: TextDelta,
  ) => {
    const delta = preparedDelta ?? calculateTextDelta(previous, body);
    const characters = Math.max(
      0,
      (characterCounts.current.get(id) ?? 0) - countNonWhitespaceGraphemes(delta.deletedText) +
        countNonWhitespaceGraphemes(delta.insert),
    );
    characterCounts.current.set(id, characters);
    const writingUnits = updateWritingUnitCount(
      writingUnitCounts.current.get(id) ?? 0,
      previous,
      body,
      delta,
    );
    writingUnitCounts.current.set(id, writingUnits);
    client.emit('editor.body.preview', {
      id,
      body,
      windowStart,
      characters,
      writingUnits,
      source: instanceId,
    } satisfies BodyPreview);
  };

  const refreshContentAuthority = async (
    id: string,
    document: LoadedEditorDocument,
  ): Promise<{ summary: EditorDocumentSummary; body: string; windowStart: number }> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const requestedEpoch = authorityEpoch.current;
      const summaries = await client.request<EditorDocumentSummary[]>('content.summariesById@1', {
        nodeIds: [id],
      });
      const summary = summaries.find((item) => item.id === id);
      if (!summary) throw new Error('正文已经不存在，无法继续编辑');
      const tooLarge = summary.length > MAX_DOM_DOCUMENT;
      const windowStart = tooLarge
        ? Math.max(0, Math.min(Math.max(0, summary.length - 1), document.windowStart))
        : 0;
      const body = tooLarge
        ? (await client.request<{ text: string }>('content.read@1', {
            nodeId: id,
            start: windowStart,
            length: Math.min(EDITOR_READ_WINDOW, summary.length - windowStart),
          })).text
        : await readWholeDocument(client, summary);
      if (requestedEpoch !== authorityEpoch.current) continue;
      contentRevisions.current.set(id, summary.revision);
      contentLengths.current.set(id, summary.length);
      return { summary, body, windowStart };
    }
    throw new Error('正文在同步期间再次发生变化，请重试刚才的输入');
  };

  const commitBody = (id: string, edit: EditorBodyEdit): Promise<void> => {
    const delta = edit.delta ?? calculateTextDelta(edit.previous, edit.next);
    if (!edit.move && delta.deleteCount === 0 && delta.insert.length === 0) return Promise.resolve();
    const document = documents.find((item) => item.id === id);
    if (!document) return Promise.resolve();
    pendingContent.current.set(id, (pendingContent.current.get(id) ?? 0) + 1);
    const previousQueue = mutationQueues.current.get(id) ?? Promise.resolve();
    let failed = false;
    let rebased = false;
    const next = previousQueue
      .catch(() => undefined)
      .then(async () => {
        if (contentFaults.current.has(id)) return;
        let effectiveDelta = delta;
        let effectiveBaseOffset = edit.baseOffset ?? 0;
        let rebasedBody: string | undefined;
        if (staleContent.current.has(id)) {
          const authority = await refreshContentAuthority(id, document);
          if (edit.move) {
            throw new Error('撤销或重做刚刚改变了正文，请在同步完成后重新拖动文字');
          }
          effectiveDelta = rebaseTextDelta(edit.previous, authority.body, delta);
          if (edit.previous === authority.body) staleContent.current.delete(id);
          effectiveBaseOffset = authority.windowStart;
          rebasedBody = `${authority.body.slice(0, effectiveDelta.start)}${effectiveDelta.insert}` +
            authority.body.slice(effectiveDelta.start + effectiveDelta.deleteCount);
          rebased = true;
        }
        const expectedRevision = contentRevisions.current.get(id) ?? document.revision;
        const currentLength = contentLengths.current.get(id) ?? document.length;
        const start = effectiveBaseOffset + effectiveDelta.start;
        if (start < 0 || start > currentLength || effectiveDelta.deleteCount < 0 ||
          start + effectiveDelta.deleteCount > currentLength) {
          throw new Error('编辑缓存与正文已经不同步，正在自动重新载入，请重新输入刚才的内容');
        }
        const response = edit.move
          ? await client.dispatch('content.moveRange', {
              nodeId: id,
              start: (edit.baseOffset ?? 0) + edit.move.start,
              end: (edit.baseOffset ?? 0) + edit.move.end,
              target: (edit.baseOffset ?? 0) + edit.move.target,
              expectedRevision,
            } satisfies MoveContentRangeRequest)
          : await client.dispatch('content.applyDelta', {
              nodeId: id,
              start,
              deleteCount: effectiveDelta.deleteCount,
              insert: effectiveDelta.insert,
              expectedRevision,
              typingSessionId: edit.typingSessionId,
              inheritFormat: edit.inheritFormat,
              annotationCopies: edit.annotationCopies,
            });
        contentRevisions.current.set(id, response.revision);
        contentLengths.current.set(id, response.length);
        if (response.formatRevision !== undefined) formatRevisions.current.set(id, response.formatRevision);
        setDocuments((current) => current.map((document) => document.id === id
          ? {
              ...document,
              revision: response.revision,
              length: response.length,
              ...(rebasedBody === undefined ? {} : { body: rebasedBody, windowStart: effectiveBaseOffset }),
            }
          : document));
        if (edit.kind !== 'move') {
          void client.dispatch('editor.recordActivity', {
            nodeId: id,
            kind: edit.kind,
            insertedText: effectiveDelta.insert,
            deletedText: effectiveDelta.deletedText,
          }).catch(() => undefined);
        }
        setErrors((current) => omitKey(current, id));
      })
      .catch((error) => {
        failed = true;
        contentFaults.current.add(id);
        setErrors((current) => ({ ...current, [id]: editorMutationError(error) }));
      })
      .finally(() => {
        const remaining = Math.max(0, (pendingContent.current.get(id) ?? 1) - 1);
        pendingContent.current.set(id, remaining);
        if (remaining === 0 && (failed || contentFaults.current.has(id))) {
          setReloadToken((value) => value + 1);
        } else if (remaining === 0 && rebased) {
          setReloadToken((value) => value + 1);
        }
      });
    mutationQueues.current.set(id, next);
    return next;
  };

  const commitResolvedFormat = (
    id: string,
    patch: Partial<TextDocumentFormat>,
    target: ReturnType<typeof inferFormatTarget>,
    range?: { start: number; end: number },
  ) => {
    const document = documents.find((item) => item.id === id);
    if (!document) return;
    if (target !== 'document' && !range) {
      setErrors((current) => ({
        ...current,
        [id]: target === 'selection' ? '请先在正文中选择一段文字' : '请先把光标放进要设置的段落',
      }));
      return;
    }
    if (target === 'document') {
      const optimistic: TextFormattingSnapshot = {
        nodeId: id,
        revision: document.formatRevision,
        contentRevision: document.revision,
        rangeStart: document.windowStart,
        rangeLength: document.body.length,
        format: { ...document.format, ...patch },
        marks: document.marks,
      };
      client.emit('editor.format.preview', { ...optimistic, source: instanceId } satisfies FormatPreview);
    }
    pendingFormats.current.set(id, (pendingFormats.current.get(id) ?? 0) + 1);
    const previousQueue = mutationQueues.current.get(id) ?? Promise.resolve();
    let failed = false;
    const next = previousQueue
      .catch(() => undefined)
      .then(async () => {
        if (contentFaults.current.has(id)) {
          throw new Error('正文正在重新同步，完成后请再次设置格式');
        }
        const expectedRevision = formatRevisions.current.get(id) ?? document.formatRevision;
        const result = target === 'document'
          ? await client.dispatch('content.setDocumentFormat', {
              nodeId: id,
              expectedRevision,
              patch,
            }).then((snapshot) => ({
              ...snapshot,
              contentRevision: contentRevisions.current.get(id) ?? document.revision,
              rangeStart: document.windowStart,
              rangeLength: document.body.length,
              marks: document.marks,
            }))
          : await client.dispatch('content.setRangeFormat', {
              nodeId: id,
              expectedRevision,
              expectedContentRevision: contentRevisions.current.get(id) ?? document.revision,
              start: range!.start,
              end: range!.end,
              scope: target,
              patch,
            });
        formatRevisions.current.set(id, result.revision);
        client.emit('editor.format.preview', { ...result, source: instanceId } satisfies FormatPreview);
        setErrors((current) => omitKey(current, id));
      })
      .catch((error) => {
        failed = true;
        setErrors((current) => ({ ...current, [id]: editorMutationError(error) }));
      })
      .finally(() => {
        const remaining = Math.max(0, (pendingFormats.current.get(id) ?? 1) - 1);
        pendingFormats.current.set(id, remaining);
        if (remaining === 0 && failed) setReloadToken((value) => value + 1);
      });
    mutationQueues.current.set(id, next);
  };

  const commitFormat = (id: string, patch: Partial<TextDocumentFormat>) => {
    const document = documents.find((item) => item.id === id);
    if (!document) return;
    const selection = selectionRanges.current.get(id);
    const target = inferFormatTarget(document, selection);
    const range = target === 'document' ? undefined : resolveFormatRange(document, target, selection);
    commitResolvedFormat(id, patch, target, range);
  };

  const stepFormat = ({ id, property, direction }: EditorFormatStepRequest) => {
    const document = documents.find((item) => item.id === id);
    if (!document) return;
    const active = resolveActiveFormat(document, selectionRanges.current.get(id));
    const options = FORMAT_STEP_OPTIONS[property];
    const current = active[property];
    const next = direction > 0
      ? options.find((value) => value > current) ?? options.at(-1)!
      : [...options].reverse().find((value) => value < current) ?? options[0];
    if (next === current) return;
    commitFormat(id, { [property]: next } as Partial<TextDocumentFormat>);
  };

  const toggleFormatBrush = (id: string) => {
    if (formatBrush) {
      setFormatBrush(undefined);
      return;
    }
    const document = documents.find((item) => item.id === id);
    const selection = selectionRanges.current.get(id);
    if (!document || !selection || selection.end <= selection.start) {
      setErrors((current) => ({ ...current, [id]: '请先选中作为格式来源的文字' }));
      return;
    }
    setFormatBrush({
      sourceNodeId: id,
      sourceStart: selection.start,
      sourceEnd: selection.end,
      format: resolveFormatAtOffset(document.format, document.marks, selection.start),
    });
    setErrors((current) => omitKey(current, id));
  };

  const previewSelection = (id: string, selection: Omit<EditorSelectionPreview, 'id'>) => {
    const next = { id, ...selection } satisfies EditorSelectionPreview;
    selectionRanges.current.set(id, next);
    setSelections((current) => ({ ...current, [id]: next }));
    client.emit('editor.selection.preview', next);
    if (!formatBrush || (formatBrush.sourceNodeId === id &&
      formatBrush.sourceStart === selection.start && formatBrush.sourceEnd === selection.end)) return;
    const document = documents.find((item) => item.id === id);
    if (!document) return;
    const range = resolveFormatBrushRange(document, selection);
    if (!range) return;
    const sourceFormat = formatBrush.format;
    setFormatBrush(undefined);
    commitResolvedFormat(id, sourceFormat, 'selection', range);
  };

  const loadWindow = (id: string, start: number) => {
    void client.dispatch('editor.setWindow', { id, start }).catch((error) => {
      setErrors((current) => ({ ...current, [id]: error instanceof Error ? error.message : String(error) }));
    });
  };

  const renameNode = (id: string, title: string, previousTitle: string) => {
    void client.dispatch('node.rename', { id, title }).then(() => {
      setTitleErrors((current) => omitKey(current, id));
    }).catch((error) => {
      client.emit('editor.title.preview', { id, title: previousTitle });
      setTitleErrors((current) => ({
        ...current,
        [id]: error instanceof Error ? error.message : String(error),
      }));
      setReloadToken((value) => value + 1);
    });
  };

  const clearTitleError = (id: string) => {
    setTitleErrors((current) => omitKey(current, id));
  };

  return {
    state,
    documents,
    metrics,
    selections,
    errors,
    titleErrors,
    now,
    previewDockWidth,
    previewPaneRatios,
    setPreviewDockWidth,
    setPreviewPaneRatios,
    previewBody,
    commitBody,
    renameNode,
    clearTitleError,
    commitFormat,
    stepFormat,
    formatBrush,
    appearancePreview,
    toggleFormatBrush,
    previewSelection,
    loadWindow,
  };
}

export function createEditorViewId(prefix: string): string {
  return `${prefix}:${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

async function readWholeDocument(client: ViewClient, summary: EditorDocumentSummary): Promise<string> {
  let body = '';
  for (let start = 0; start < summary.length; start += EDITOR_READ_WINDOW) {
    const response = await client.request<{ text: string }>('content.read@1', {
      nodeId: summary.id,
      start,
      length: Math.min(EDITOR_READ_WINDOW, summary.length - start),
    });
    body += response.text;
  }
  return body;
}

function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

function editorMutationError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/Delta start is out of range|Delta delete range is out of bounds/iu.test(message)) {
    return '编辑缓存与正文已经不同步，正在自动重新载入，请重新输入刚才的内容';
  }
  return message;
}
