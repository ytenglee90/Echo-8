'use client';

import {
  Fragment,
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { UISlot, ViewClient } from '../../core/contracts.ts';
import { IconButton } from '../../ui/Icon.tsx';
import { chooseNativeTextExport } from '../../services/native-save.ts';
import { useCommandAvailability } from '../../ui/runtime-hooks.ts';
import type { AppearancePreview } from '../../protocols/appearance.ts';
import type {
  EditorFormatStepRequest,
  EditorPaneState,
  EditorRevealRequest,
  WritingMetricsSnapshot,
} from '../../protocols/editor.ts';
import type { TextDocumentFormat } from '../../protocols/formatting.ts';
import {
  inferFormatTarget,
  resolveActiveFormat,
  resolveFormatRange,
} from './format-target.ts';
import { applyTextColorPreview } from './appearance-preview.ts';
import {
  EDITOR_PANE_DIVIDER_WIDTH,
  EDITOR_READ_WINDOW,
  MAX_EDITOR_DOCK_WIDTH,
  MIN_EDITOR_DOCK_WIDTH,
  MIN_EDITOR_PANE_WIDTH,
  minimumEditorDockWidth,
} from './constants.ts';
import {
  FormatBar,
  useTextAssistRuntime,
  type TextAssistRuntime,
} from './EditorFormatBar.tsx';
import { EditorMetrics } from './EditorMetrics.tsx';
import { PlainTextWritingArea } from './EditorWritingArea.tsx';
import { DockResizeHandle, PaneResizeHandle } from './EditorResizeHandles.tsx';
import {
  EMPTY_EDITOR_STATE,
  useEditorRuntime,
  type EditorBodyEdit as BodyEdit,
  type EditorDocumentSummary as Summary,
  type EditorSelectionPreview as SelectionPreview,
  type LoadedEditorDocument as LoadedDocument,
} from './editor-runtime.ts';
import type { TextDelta } from './text-edit.ts';

// Keep the synchronous deterministic pass close to the caret. A wider
// document/editor window remains mounted independently; text assistance is
// refreshed as the caret moves instead of rescanning distant paragraphs on
// every keystroke.
export function EditorDock({ client }: { client: ViewClient }) {
  const runtime = useEditorRuntime(client);
  const viewportWidth = useViewportWidth();
  const boundaryWidth = Math.min(viewportWidth, MAX_EDITOR_DOCK_WIDTH);
  const minimumWidth = Math.min(boundaryWidth, minimumEditorDockWidth(runtime.documents.length));
  const width = Math.min(runtime.previewDockWidth ?? runtime.state.dockWidth, boundaryWidth);
  const paneRatios = runtime.previewPaneRatios ?? runtime.state.paneRatios;
  const dockRef = useRef<HTMLElement>(null);
  const paneListRef = useRef<HTMLDivElement>(null);
  useEffect(
    () => client.subscribeSignal<{ id: string }>('editor.formatBrush.requested', (message) => {
      runtime.toggleFormatBrush(message.payload.id);
    }),
    [client, runtime],
  );
  useEffect(
    () => client.subscribeSignal<EditorFormatStepRequest>('editor.formatStep.requested', (message) => {
      runtime.stepFormat(message.payload);
    }),
    [client, runtime],
  );
  if (runtime.documents.length === 0) return null;

  return (
    <section ref={dockRef} className="editor-dock" aria-label="文本编辑区" style={{ width }}>
      <DockResizeHandle
        client={client}
        width={width}
        minimumWidth={minimumWidth}
        boundaryWidth={boundaryWidth}
        onPreview={runtime.setPreviewDockWidth}
      />
      <div
        ref={paneListRef}
        className="editor-pane-list"
        style={{ gridTemplateColumns: paneGridTemplate(runtime.documents, paneRatios) }}
      >
        {runtime.documents.map((document, index) => (
          <Fragment key={document.id}>
            <EditorPane
              client={client}
              document={document}
              appearancePreview={runtime.appearancePreview}
              active={runtime.state.activePane === document.id}
              immersive={false}
              metric={runtime.metrics[document.id]}
              selection={runtime.selections[document.id]}
              now={runtime.now}
              error={runtime.errors[document.id]}
              titleError={runtime.titleErrors[document.id]}
              revealRequest={runtime.state.revealRequest?.id === document.id
                ? runtime.state.revealRequest
                : undefined}
              onBodyPreview={runtime.previewBody}
              onBodyEdit={runtime.commitBody}
              onRename={runtime.renameNode}
              onTitleInput={runtime.clearTitleError}
              onFormat={runtime.commitFormat}
              formatBrushActive={Boolean(runtime.formatBrush)}
              onFormatBrush={() => void client.dispatch('editor.toggleFormatBrush', { id: document.id })}
              onSelection={runtime.previewSelection}
              onWindowChange={runtime.loadWindow}
              onClose={() => void client.dispatch('editor.close', {
                id: document.id,
                currentDockWidth: dockRef.current?.getBoundingClientRect().width,
              })}
            />
            {index < runtime.documents.length - 1 && (
              <PaneResizeHandle
                client={client}
                listRef={paneListRef}
                documents={runtime.documents}
                dividerIndex={index}
                dockWidth={width}
                maximumDockWidth={boundaryWidth}
                ratios={paneRatios}
                onDockPreview={runtime.setPreviewDockWidth}
                onPreview={runtime.setPreviewPaneRatios}
              />
            )}
          </Fragment>
        ))}
      </div>
    </section>
  );
}

export function EditorReplacementPrompt({ client }: { client: ViewClient }) {
  const editorVersion = useSyncExternalStore(
    client.subscribeState,
    () => client.getOwnStateVersion('editor'),
    () => 0,
  );
  const [state, setState] = useState<EditorPaneState>(EMPTY_EDITOR_STATE);
  const [summaries, setSummaries] = useState<Summary[]>([]);

  useEffect(() => {
    let current = true;
    void client.ask<EditorPaneState>('editor.state').then(async (nextState) => {
      const nextSummaries = await client.request<Summary[]>('content.summariesById@1', {
        nodeIds: [...nextState.openPanes, ...(nextState.pendingPane ? [nextState.pendingPane] : [])],
      });
      if (!current) return;
      setState(nextState);
      setSummaries(nextSummaries);
    });
    return () => { current = false; };
  }, [client, editorVersion]);

  if (!state.pendingPane) return null;
  const names = new Map(summaries.map((summary) => [summary.id, summary.title]));
  return (
    <div className="editor-replace-backdrop" onPointerDown={() => void client.dispatch('editor.cancelReplace')}>
      <section
        className="editor-replace-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="editor-replace-title"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <strong id="editor-replace-title">已达三个编辑区上限</strong>
            <span>选择一个已打开的编辑区，替换为“{names.get(state.pendingPane) ?? '新文本节点'}”。</span>
          </div>
          <IconButton icon="close" label="取消替换" onClick={() => void client.dispatch('editor.cancelReplace')} />
        </header>
        <div className="editor-replace-list">
          {state.openPanes.map((id, index) => (
            <button key={id} type="button" onClick={() => void client.dispatch('editor.replacePane', { replaceId: id })}>
              <span>编辑区 {index + 1}</span>
              <strong>{names.get(id) ?? id}</strong>
              <small>{state.activePane === id ? '当前正在使用' : '点击替换'}</small>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

export function ImmersiveEditor({
  client,
  renderSlot,
}: {
  client: ViewClient;
  renderSlot?: (slot: UISlot) => ReactNode;
}) {
  const editorVersion = useSyncExternalStore(
    client.subscribeState,
    () => client.getOwnStateVersion('editor'),
    () => 0,
  );
  const [immersiveId, setImmersiveId] = useState<string>();

  useEffect(() => {
    let current = true;
    void client.ask<EditorPaneState>('editor.state').then((state) => {
      if (current) setImmersiveId(state.immersivePane);
    });
    return () => {
      current = false;
    };
  }, [client, editorVersion]);

  return immersiveId
    ? <ActiveImmersiveEditor client={client} immersiveId={immersiveId} renderSlot={renderSlot} />
    : null;
}

function ActiveImmersiveEditor({
  client,
  immersiveId,
  renderSlot,
}: {
  client: ViewClient;
  immersiveId: string;
  renderSlot?: (slot: UISlot) => ReactNode;
}) {
  const runtime = useEditorRuntime(client);
  const containerRef = useRef<HTMLElement>(null);
  const document = runtime.documents.find((item) => item.id === immersiveId);
  const annotationAvailable = useCommandAvailability(client, 'annotation.createAtContext');

  useEffect(() => {
    containerRef.current?.focus();
    return () => {
      if (globalThis.document?.fullscreenElement) void globalThis.document.exitFullscreen().catch(() => undefined);
    };
  }, [immersiveId]);

  if (!document) return null;

  const exit = () => {
    void (async () => {
      await client.dispatch('editor.exitImmersive');
      await client.dispatch('interaction.end', { mode: 'immersive' }).catch(() => undefined);
    })();
    if (globalThis.document?.fullscreenElement) void globalThis.document.exitFullscreen().catch(() => undefined);
  };

  return (
    <section
      ref={containerRef}
      className="immersive-editor"
      aria-label="沉浸式写作"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          exit();
        }
      }}
    >
      <div className="immersive-corner-actions">
        <IconButton
          icon="comment"
          label="在当前光标位置添加注释"
          className="immersive-annotation-button"
          disabled={!annotationAvailable}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => void client.dispatch('annotation.createAtContext')}
        />
        <IconButton icon="minimize" label="退出沉浸写作" className="immersive-exit-button" onClick={exit} />
      </div>
      <div className="immersive-content">
        <EditorPane
          client={client}
          document={document}
          appearancePreview={runtime.appearancePreview}
          active
          immersive
          metric={runtime.metrics[document.id]}
          selection={runtime.selections[document.id]}
          now={runtime.now}
          error={runtime.errors[document.id]}
          titleError={runtime.titleErrors[document.id]}
          revealRequest={runtime.state.revealRequest?.id === document.id
            ? runtime.state.revealRequest
            : undefined}
          onBodyPreview={runtime.previewBody}
          onBodyEdit={runtime.commitBody}
          onRename={runtime.renameNode}
          onTitleInput={runtime.clearTitleError}
          onFormat={runtime.commitFormat}
          onSelection={runtime.previewSelection}
          onWindowChange={runtime.loadWindow}
        />
      </div>
      <div className="immersive-overlay-layer">
        {renderSlot?.('editor.immersive.overlay')}
      </div>
    </section>
  );
}

function EditorPane({
  client,
  document,
  appearancePreview,
  active,
  immersive,
  metric,
  selection,
  now,
  error,
  titleError,
  revealRequest,
  onBodyPreview,
  onBodyEdit,
  onRename,
  onTitleInput,
  onFormat,
  formatBrushActive,
  onFormatBrush,
  onSelection,
  onWindowChange,
  onClose,
}: {
  client: ViewClient;
  document: LoadedDocument;
  appearancePreview?: AppearancePreview;
  active: boolean;
  immersive: boolean;
  metric?: WritingMetricsSnapshot;
  selection?: SelectionPreview;
  now: number;
  error?: string;
  titleError?: string;
  revealRequest?: EditorRevealRequest;
  onBodyPreview: (id: string, windowStart: number, previous: string, body: string, delta?: TextDelta) => void;
  onBodyEdit: (id: string, edit: BodyEdit) => Promise<void>;
  onRename: (id: string, title: string, previousTitle: string) => void;
  onTitleInput: (id: string) => void;
  onFormat: (id: string, patch: Partial<TextDocumentFormat>) => void;
  formatBrushActive?: boolean;
  onFormatBrush?: () => void;
  onSelection: (id: string, selection: Omit<SelectionPreview, 'id'>) => void;
  onWindowChange: (id: string, start: number) => void;
  onClose?: () => void;
}) {
  const renderedDocument = applyTextColorPreview(document, appearancePreview);
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(document.title);
  const titleBeforeEdit = useRef(document.title);
  const titleComposing = useRef(false);
  useEffect(() => {
    if (titleEditing || titleComposing.current) return;
    setTitleDraft(document.title);
    titleBeforeEdit.current = document.title;
  }, [document.title, titleEditing]);
  const textAssist = useTextAssistRuntime(client);
  const formatTarget = inferFormatTarget(document, selection);
  const formatRange = formatTarget === 'document'
    ? undefined
    : resolveFormatRange(document, formatTarget, selection);
  const textExportAvailable = useCommandAvailability(client, 'file.exportText');
  const wordExportAvailable = useCommandAvailability(client, 'file.exportWord');
  const exportAvailable = textExportAvailable && wordExportAvailable;
  const textExportState = useTextExportState(client, document.id, document.revision);
  const enterImmersive = () => {
    const root = globalThis.document?.documentElement;
    const fullscreen = root?.requestFullscreen ? root.requestFullscreen().catch(() => undefined) : Promise.resolve();
    void (async () => {
      try {
        await client.dispatch('interaction.begin', { mode: 'immersive' });
        await client.dispatch('editor.enterImmersive', { id: document.id });
      } catch {
        await fullscreen;
        if (globalThis.document?.fullscreenElement) await globalThis.document.exitFullscreen().catch(() => undefined);
      }
    })();
  };
  const exportCurrent = () => {
    void exportTextDocument(client, document).catch(() => undefined);
  };

  return (
    <article
      className={`editor-pane ${active ? 'active' : ''} ${immersive ? 'immersive-pane' : ''}`}
      onFocusCapture={() => void client.dispatch('editor.activate', { id: document.id })}
    >
      {!immersive && (
        <div className={`editor-title-block ${titleError ? 'has-error' : ''}`}>
          <div className="editor-title-row">
            <div className={`editor-title-field ${titleEditing ? 'editing' : ''} ${titleError ? 'invalid' : ''}`}>
              <span className="editor-title-display" title={document.title} aria-hidden="true">
                {document.title}
              </span>
              <input
                value={titleDraft}
                aria-label="节点标题"
                aria-invalid={Boolean(titleError)}
                aria-describedby={titleError ? `editor-title-error-${document.id}` : undefined}
                title={document.title}
                onFocus={() => {
                  titleBeforeEdit.current = document.title;
                  setTitleDraft(document.title);
                  setTitleEditing(true);
                }}
                onCompositionStart={() => { titleComposing.current = true; }}
                onCompositionEnd={(event) => {
                  titleComposing.current = false;
                  setTitleDraft(event.currentTarget.value);
                  onTitleInput(document.id);
                  client.emit('editor.title.preview', { id: document.id, title: event.currentTarget.value });
                }}
                onChange={(event) => {
                  setTitleDraft(event.target.value);
                  if (!titleComposing.current) {
                    onTitleInput(document.id);
                    client.emit('editor.title.preview', { id: document.id, title: event.target.value });
                  }
                }}
                onBlur={() => {
                  if (titleComposing.current) {
                    titleComposing.current = false;
                    setTitleDraft(document.title);
                    client.emit('editor.title.preview', { id: document.id, title: document.title });
                    setTitleEditing(false);
                    return;
                  }
                  titleComposing.current = false;
                  onRename(document.id, titleDraft, titleBeforeEdit.current);
                  setTitleEditing(false);
                }}
              />
            </div>
            <IconButton
              icon="download"
              label={textExportState.renameRequired
                ? '节点标题已修改：点击重新选择导出文件名'
                : textExportState.dirty ? '导出当前文字节点（有未导出修改）' : '导出当前文字节点（已导出）'}
              className={`icon-button${textExportState.dirty ? ' is-dirty' : ''}`}
              disabled={!exportAvailable}
              onClick={exportCurrent}
            />
            <IconButton
              icon="close"
              label="关闭编辑器"
              onClick={onClose ?? (() => void client.dispatch('editor.close', { id: document.id }))}
            />
          </div>
          {titleError && (
            <p id={`editor-title-error-${document.id}`} className="editor-title-error" role="alert">
              <span aria-hidden="true">!</span>
              {titleError}
            </p>
          )}
        </div>
      )}
      {!immersive && (
        <FormatBar
          client={client}
          nodeId={document.id}
          textRange={formatRange ? {
            ...formatRange,
            scope: formatTarget as 'selection' | 'paragraph',
            contentRevision: document.revision,
          } : undefined}
          format={resolveActiveFormat(document, selection)}
          brushActive={formatBrushActive}
          textAssist={textAssist}
          onBrush={onFormatBrush}
          onEnterImmersive={enterImmersive}
          onChange={(patch) => onFormat(document.id, patch)}
        />
      )}
      {document.tooLarge ? (
        <LargeDocumentEditor
          client={client}
          document={renderedDocument}
          onWindowChange={(start) => onWindowChange(document.id, start)}
          onPreview={(previous, next, delta) => onBodyPreview(document.id, document.windowStart, previous, next, delta)}
          onEdit={(edit) => onBodyEdit(document.id, { ...edit, baseOffset: document.windowStart })}
          onSelection={(selection) => onSelection(document.id, selection)}
          revealRequest={revealRequest}
          textAssist={textAssist}
        />
      ) : (
        <PlainTextWritingArea
          client={client}
          nodeId={document.id}
          revision={document.revision}
          body={renderedDocument.body}
          format={renderedDocument.format}
          marks={renderedDocument.marks}
          windowStart={0}
          label={`${document.title} 正文`}
          onPreview={(previous, next, delta) => onBodyPreview(document.id, 0, previous, next, delta)}
          onEdit={(edit) => onBodyEdit(document.id, { ...edit, baseOffset: 0 })}
          onSelection={(selection) => onSelection(document.id, selection)}
          revealRequest={revealRequest}
          textAssist={textAssist}
        />
      )}
      {error && <p className="editor-error" role="alert">{error}</p>}
      {!immersive && (
        <EditorMetrics
          totalCharacters={document.characters}
          totalCharactersPending={document.metricsPending}
          selectionCharacters={selection?.characters ?? 0}
          metric={metric}
          now={now}
        />
      )}
    </article>
  );
}

function LargeDocumentEditor({
  client,
  document,
  onWindowChange,
  onPreview,
  onEdit,
  onSelection,
  revealRequest,
  textAssist,
}: {
  client: ViewClient;
  document: LoadedDocument;
  onWindowChange: (start: number) => void;
  onPreview: (previous: string, next: string, delta?: TextDelta) => void;
  onEdit: (edit: BodyEdit) => Promise<void>;
  onSelection: (selection: Omit<SelectionPreview, 'id'>) => void;
  revealRequest?: EditorRevealRequest;
  textAssist: TextAssistRuntime;
}) {
  const pageCount = Math.max(1, Math.ceil(document.length / EDITOR_READ_WINDOW));
  const page = Math.min(pageCount, Math.floor(document.windowStart / EDITOR_READ_WINDOW) + 1);
  const changeAtBoundary = (direction: 'previous' | 'next'): boolean => {
    const nextPage = direction === 'previous' ? page - 1 : page + 1;
    if (nextPage < 1 || nextPage > pageCount) return false;
    onWindowChange((nextPage - 1) * EDITOR_READ_WINDOW);
    return true;
  };
  return (
    <div className="large-document-editor">
      <PlainTextWritingArea
        client={client}
        nodeId={document.id}
        revision={document.revision}
        body={document.body}
        format={document.format}
        marks={document.marks}
        windowStart={document.windowStart}
        label={`${document.title} 正文第 ${page} 页`}
        onPreview={onPreview}
        onEdit={(edit) => onEdit(edit)}
        onSelection={onSelection}
        onWindowBoundary={changeAtBoundary}
        revealRequest={revealRequest}
        textAssist={textAssist}
      />
    </div>
  );
}

function useTextExportState(
  client: ViewClient,
  nodeId: string,
  revision: number,
): { dirty: boolean; renameRequired: boolean } {
  const [state, setState] = useState<{ revision?: number; renameRequired?: boolean }>({});
  useEffect(() => {
    let current = true;
    const refresh = () => void client.request<{ exported: boolean; revision?: number; renameRequired?: boolean }>(
      'file.textExportState@1',
      { nodeId },
    ).then((state) => {
      if (current) setState(state.exported
        ? { revision: state.revision, renameRequired: state.renameRequired }
        : {});
    }).catch(() => {
      if (current) setState({});
    });
    refresh();
    const unsubscribe = client.subscribeSignal<{ nodeId?: string; all?: boolean }>(
      'file.text-export-state.changed',
      (message) => {
        if (message.payload.all || message.payload.nodeId === nodeId) refresh();
      },
    );
    return () => { current = false; unsubscribe(); };
  }, [client, nodeId]);
  return {
    dirty: state.revision === undefined || state.revision !== revision || Boolean(state.renameRequired),
    renameRequired: Boolean(state.renameRequired),
  };
}

async function exportTextDocument(client: ViewClient, document: Pick<LoadedDocument, 'id' | 'title'>) {
  try {
    const choice = await chooseNativeTextExport(document.title);
    await client.dispatch(
      choice.format === 'docx' ? 'file.exportWord' : 'file.exportText',
      { scope: 'current', nodeId: document.id, destination: choice.destination },
    );
  } catch (reason) {
    if (reason instanceof DOMException && reason.name === 'AbortError') return;
    throw reason;
  }
}

function paneGridTemplate(documents: LoadedDocument[], ratios: Record<string, number>): string {
  return documents.flatMap((document, index) => [
    `minmax(${MIN_EDITOR_PANE_WIDTH}px, ${ratios[document.id] ?? 1}fr)`,
    ...(index < documents.length - 1 ? [`${EDITOR_PANE_DIVIDER_WIDTH}px`] : []),
  ]).join(' ');
}

function useViewportWidth(): number {
  const read = () => Math.max(
    MIN_EDITOR_DOCK_WIDTH,
    globalThis.document?.documentElement.clientWidth ?? MAX_EDITOR_DOCK_WIDTH,
  );
  const [width, setWidth] = useState(read);
  useEffect(() => {
    const update = () => setWidth(read());
    globalThis.addEventListener?.('resize', update);
    update();
    return () => globalThis.removeEventListener?.('resize', update);
  }, []);
  return width;
}
