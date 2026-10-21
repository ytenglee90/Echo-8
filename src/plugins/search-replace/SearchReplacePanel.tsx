'use client';

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import type { SearchNavigationSignal, SearchResult, SearchStatus } from '../../protocols/search.ts';
import type { EditorContextSnapshot, EditorSelectionSnapshot } from '../../protocols/editor.ts';
import type { FloatingPanelRect } from '../../protocols/floating.ts';
import { FloatingPanel } from '../../ui/FloatingPanel.tsx';
import { Icon } from '../../ui/Icon.tsx';
import { useLocalTextHistory } from '../../ui/use-local-text-history.ts';
import { groupHitsByNode } from './result-order.ts';

const DEFAULT_RECT: FloatingPanelRect = { x: 160, y: 88, width: 500, height: 620 };
const DEFAULT_TEXTAREA_HEIGHT = 72;
const MIN_TEXTAREA_HEIGHT = 58;
const MAX_TEXTAREA_HEIGHT = 220;

interface SearchLassoRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface SearchSelectionPreview {
  nodeIds: string[];
  lasso?: SearchLassoRect;
}

export function SearchReplacePanel({ client }: { client: ViewClient }) {
  const uiVersion = useSyncExternalStore(
    client.subscribeState,
    () => client.getOwnStateVersion('searchUI'),
    () => 0,
  );
  const capabilityVersion = useSyncExternalStore(
    client.subscribeCapabilities,
    client.getCapabilityVersion,
    () => 0,
  );
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(DEFAULT_RECT);
  const [query, setQuery] = useState('');
  const [queryComposing, setQueryComposing] = useState(false);
  const [replacement, setReplacement] = useState('');
  const queryHistory = useLocalTextHistory(query, setQuery);
  const replacementHistory = useLocalTextHistory(replacement, setReplacement);
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [status, setStatus] = useState<SearchStatus>({ state: 'idle' });
  const [result, setResult] = useState<SearchResult>();
  const [editorContext, setEditorContext] = useState<EditorContextSnapshot>({ openPanes: [] });
  const [editorSelection, setEditorSelection] = useState<EditorSelectionSnapshot>();
  const [navigationState, setNavigationState] = useState<{ nodeId: string; index: number; total: number }>();
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [lasso, setLasso] = useState<SearchLassoRect>();
  const selectionAnchor = useRef<number | undefined>(undefined);
  const hitListRef = useRef<HTMLDivElement>(null);
  const suppressClick = useRef(false);
  const lassoGesture = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    baseline: string[];
    mode: 'replace' | 'add';
    startedOnRow: boolean;
    dragging: boolean;
    latestNodeIds: string[];
  } | undefined>(undefined);

  useEffect(() => {
    let current = true;
    void client.request<{ open: boolean; rect: FloatingPanelRect }>('search.state@1').then((state) => {
      if (current) {
        setOpen(state.open);
        setRect(state.rect);
      }
    });
    return () => {
      current = false;
    };
  }, [client, uiVersion]);

  useEffect(
    () => client.subscribeSignal<SearchStatus>('search.status', (message) => {
      setStatus(message.payload);
      if (message.payload.state === 'replaced') {
        setResult(undefined);
        setNavigationState(undefined);
        setSelectedNodeIds([]);
        setLasso(undefined);
        selectionAnchor.current = undefined;
      }
    }),
    [client],
  );

  useEffect(
    () => client.subscribeSignal<SearchResult>('search.results', (message) => {
      setResult(message.payload);
      setNavigationState(undefined);
      setSelectedNodeIds([]);
      setLasso(undefined);
      selectionAnchor.current = undefined;
    }),
    [client],
  );

  useEffect(
    () => client.subscribeSignal('search.results.clear', () => {
      setResult(undefined);
      setNavigationState(undefined);
      setSelectedNodeIds([]);
      setLasso(undefined);
      selectionAnchor.current = undefined;
    }),
    [client],
  );

  useEffect(
    () => client.subscribeSignal<SearchSelectionPreview>('search.selection.preview', (message) => {
      setSelectedNodeIds(message.payload.nodeIds);
      setLasso(message.payload.lasso);
    }),
    [client],
  );

  useEffect(
    () => client.subscribeSignal<SearchNavigationSignal>('search.navigation', (message) => {
      setNavigationState(message.payload);
    }),
    [client],
  );

  useEffect(() => {
    if (!open) return;
    client.emit('search.query.preview', {
      query,
      matchCase,
      wholeWord,
      composing: queryComposing,
    });
  }, [client, matchCase, open, query, queryComposing, wholeWord]);

  useEffect(() => {
    if (!open) return;
    let current = true;
    void client.request<EditorContextSnapshot>('editor.context@1').then(
      (snapshot) => current && setEditorContext(snapshot),
      () => current && setEditorContext({ openPanes: [] }),
    );
    void client.request<EditorSelectionSnapshot | undefined>('editor.selection@1').then(
      (selection) => current && setEditorSelection(selection),
      () => current && setEditorSelection(undefined),
    );
    return () => {
      current = false;
    };
  }, [capabilityVersion, client, open]);

  useEffect(
    () => client.subscribeSignal<EditorContextSnapshot>('search.editorContext', (message) => {
      selectionAnchor.current = undefined;
      setEditorContext(message.payload);
      void client.request<EditorSelectionSnapshot | undefined>('editor.selection@1').then(
        setEditorSelection,
        () => setEditorSelection(undefined),
      );
    }),
    [client],
  );

  useEffect(
    () => client.subscribeSignal<EditorSelectionSnapshot>('editor.selection.preview', (message) => {
      setEditorSelection(message.payload);
    }),
    [client],
  );

  const selectedNodeSet = useMemo(() => new Set(selectedNodeIds), [selectedNodeIds]);
  const nodeResults = useMemo(
    () => groupHitsByNode(result?.hits ?? [], editorContext),
    [editorContext, result],
  );
  const selectedHits = useMemo(
    () => result?.hits.filter((hit) => selectedNodeSet.has(hit.nodeId)) ?? [],
    [result, selectedNodeSet],
  );
  const currentEditorHit = useMemo(
    () => result?.hits.find((hit) => (
      hit.nodeId === editorContext.activePane &&
      hit.nodeId === editorSelection?.id &&
      hit.start === editorSelection.start &&
      hit.start + hit.length === editorSelection.end
    )),
    [editorContext.activePane, editorSelection, result],
  );
  const replacementHits = selectedNodeIds.length > 0
    ? selectedHits
    : currentEditorHit ? [currentEditorHit] : [];

  if (!open) return null;

  const publishSelection = (nodeIds: string[], nextLasso?: SearchLassoRect) => {
    client.emit('search.selection.preview', { nodeIds: [...new Set(nodeIds)], lasso: nextLasso });
  };
  const replaceTargets = () => {
    if (!result || replacementHits.length === 0 || result.truncated) return;
    void client.dispatch('search.replaceTargets', {
      hits: result.hits,
      selectedNodeIds,
      currentHit: currentEditorHit,
      replacement,
    }).catch((error) => setStatus({
      state: 'error',
      message: error instanceof Error ? error.message : '无法替换当前目标',
    }));
  };
  const navigate = (command: 'search.previous' | 'search.next') => {
    void client.dispatch(command).catch((error) => setStatus({
      state: 'error',
      message: error instanceof Error ? error.message : '无法定位当前文本编辑区的查找结果',
    }));
  };
  const selectNode = (event: ReactMouseEvent<HTMLButtonElement>, index: number) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    const node = nodeResults[index];
    if (!node) return;
    if (event.ctrlKey || event.metaKey) {
      const next = new Set(selectedNodeIds);
      if (next.has(node.nodeId)) next.delete(node.nodeId);
      else next.add(node.nodeId);
      selectionAnchor.current = index;
      publishSelection([...next]);
    } else if (event.shiftKey && selectionAnchor.current !== undefined) {
      const start = Math.min(selectionAnchor.current, index);
      const end = Math.max(selectionAnchor.current, index);
      publishSelection(nodeResults.slice(start, end + 1).map((item) => item.nodeId));
    } else {
      selectionAnchor.current = index;
      publishSelection([node.nodeId]);
    }
  };
  const beginLasso = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    const startedOnRow = event.target instanceof Element && Boolean(event.target.closest('[data-search-node-id]'));
    if (!startedOnRow) event.currentTarget.focus({ preventScroll: true });
    lassoGesture.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      baseline: selectedNodeIds,
      mode: event.ctrlKey || event.metaKey || event.shiftKey ? 'add' : 'replace',
      startedOnRow,
      dragging: false,
      latestNodeIds: selectedNodeIds,
    };
  };
  const previewLasso = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = lassoGesture.current;
    const list = hitListRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId || !list) return;
    const deltaX = event.clientX - gesture.startClientX;
    const deltaY = event.clientY - gesture.startClientY;
    if (!gesture.dragging && Math.hypot(deltaX, deltaY) < 5) return;
    if (!gesture.dragging) event.currentTarget.setPointerCapture(event.pointerId);
    gesture.dragging = true;
    event.preventDefault();
    const viewport = {
      left: Math.min(gesture.startClientX, event.clientX),
      top: Math.min(gesture.startClientY, event.clientY),
      right: Math.max(gesture.startClientX, event.clientX),
      bottom: Math.max(gesture.startClientY, event.clientY),
    };
    const intersected = [...list.querySelectorAll<HTMLElement>('[data-search-node-id]')]
      .filter((row) => rectanglesIntersect(viewport, row.getBoundingClientRect()))
      .map((row) => row.dataset.searchNodeId!)
      .filter(Boolean);
    const next = gesture.mode === 'add'
      ? [...new Set([...gesture.baseline, ...intersected])]
      : intersected;
    gesture.latestNodeIds = next;
    const listRect = list.getBoundingClientRect();
    publishSelection(next, {
      left: viewport.left - listRect.left + list.scrollLeft,
      top: viewport.top - listRect.top + list.scrollTop,
      width: viewport.right - viewport.left,
      height: viewport.bottom - viewport.top,
    });
  };
  const finishLasso = (event: ReactPointerEvent<HTMLDivElement>, cancelled = false) => {
    const gesture = lassoGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    lassoGesture.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!gesture.dragging) {
      if (!gesture.startedOnRow) {
        selectionAnchor.current = undefined;
        publishSelection([]);
      }
      return;
    }
    event.preventDefault();
    suppressClick.current = gesture.startedOnRow;
    publishSelection(cancelled ? gesture.baseline : gesture.latestNodeIds);
  };

  return (
    <FloatingPanel
      title="查找与替换"
      icon="search"
      rect={rect}
      className="search-floating-panel"
      localHistory
      onActivate={() => void client.dispatch('search.focus')}
      onPreview={(next) => client.emit('search.panel.preview', next)}
      onCommit={(next) => void client.dispatch('search.setPanelRect', next)}
      onClose={() => {
        queryHistory.cancelComposition();
        replacementHistory.cancelComposition();
        void client.dispatch('search.close');
      }}
    >
      <section
        className="search-panel"
        aria-label="查找替换"
        onPointerDown={(event) => {
          const target = event.target as HTMLElement;
          if (target.closest('button, input, textarea, label, .search-hit-list')) return;
          if (selectedNodeIds.length === 0) return;
          selectionAnchor.current = undefined;
          publishSelection([]);
        }}
      >
        <ResizableSearchTextarea
          id="search-query"
          label="查找正文"
          value={query}
          onChange={queryHistory.change}
          onKeyDown={queryHistory.handleKeyDown}
          onCompositionStart={queryHistory.startComposition}
          onCompositionEnd={queryHistory.endComposition}
          onCompositionChange={setQueryComposing}
          placeholder="输入内容后自动查找"
        />
        <ResizableSearchTextarea
          id="search-replacement"
          label="替换为"
          value={replacement}
          onChange={replacementHistory.change}
          onKeyDown={replacementHistory.handleKeyDown}
          onCompositionStart={replacementHistory.startComposition}
          onCompositionEnd={replacementHistory.endComposition}
          placeholder="允许留空，也可以输入多行内容"
        />
        <div className="search-options">
          <label><input type="checkbox" checked={matchCase} onChange={(event) => setMatchCase(event.target.checked)} /> 区分大小写</label>
          <label><input type="checkbox" checked={wholeWord} onChange={(event) => setWholeWord(event.target.checked)} /> 完整词</label>
        </div>
        <div className="search-actions">
          <div className="search-navigation" aria-label="当前文本编辑区查找结果导航">
            <button type="button" disabled={!result?.hits.length} onClick={() => navigate('search.previous')}>
              <Icon name="chevron-left" size={16} />
              <span>上一个</span>
            </button>
            <span>{navigationState ? `${navigationState.index + 1} / ${navigationState.total}` : '当前编辑区'}</span>
            <button type="button" disabled={!result?.hits.length} onClick={() => navigate('search.next')}>
              <span>下一个</span>
              <Icon name="chevron-right" size={16} />
            </button>
          </div>
          <button
            type="button"
            className="search-main-action"
            title={result?.truncated
              ? '结果达到上限，不能执行不完整的替换'
              : selectedNodeIds.length > 0
                ? '替换结果列表中已选节点的全部命中'
                : currentEditorHit
                  ? '没有选择列表节点，将只替换当前文本编辑区选中的这一处'
                  : '请在当前文本编辑区选中一处查找结果，或在结果列表中选择节点'}
            disabled={replacementHits.length === 0 || Boolean(result?.truncated)}
            onClick={replaceTargets}
          >
            <Icon name="replace" size={17} />
            <span>{selectedNodeIds.length > 0 ? '替换所选节点' : '替换当前一处'}</span>
          </button>
        </div>
        <p className={`search-status ${status.state === 'error' ? 'error' : ''}`} aria-live="polite">
          {status.message ?? '默认查找全画布正文；结果选择按节点生效。'}
        </p>
        {result && (
          <div className="search-results">
            <div className="search-summary">
              <div>
                <strong>{result.hits.length} 处</strong>
                <span>{nodeResults.length} 个节点 · 已选 {selectedNodeSet.size} 个 · 已扫描 {result.scannedNodes} 个</span>
              </div>
            </div>
            <div
              ref={hitListRef}
              className="search-hit-list"
              data-keyboard-region="search-results"
              role="listbox"
              tabIndex={0}
              aria-label="查找结果；可拖动框选"
              aria-multiselectable="true"
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
                  event.preventDefault();
                  event.stopPropagation();
                  selectionAnchor.current = nodeResults.length > 0 ? 0 : undefined;
                  publishSelection(nodeResults.map((node) => node.nodeId));
                }
              }}
              onPointerDown={beginLasso}
              onPointerMove={previewLasso}
              onPointerUp={(event) => finishLasso(event)}
              onPointerCancel={(event) => finishLasso(event, true)}
            >
              {lasso && <div className="search-result-lasso" style={lasso} aria-hidden="true" />}
              {nodeResults.map((node, index) => {
                const selected = selectedNodeSet.has(node.nodeId);
                const firstHit = node.hits[0];
                return (
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={selected ? 'selected' : ''}
                    key={node.nodeId}
                    data-search-node-id={node.nodeId}
                    title="单击单选；Ctrl/⌘ + 单击逐个多选；Shift + 单击连续多选；双击打开文本编辑区"
                    onClick={(event) => selectNode(event, index)}
                    onDoubleClick={() => void client.dispatch('editor.open', { id: node.nodeId })}
                  >
                    <strong>{node.title}</strong>
                    <span>{firstHit.preview}</span>
                    <small>{node.hits.length} 处命中 · 首处位置 {firstHit.start}</small>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </section>
    </FloatingPanel>
  );
}

function ResizableSearchTextarea({
  id,
  label,
  value,
  placeholder,
  onChange,
  onKeyDown,
  onCompositionStart,
  onCompositionEnd,
  onCompositionChange,
}: {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  onCompositionStart?: () => void;
  onCompositionEnd?: (value: string) => void;
  onCompositionChange?: (composing: boolean) => void;
}) {
  const [height, setHeight] = useState(DEFAULT_TEXTAREA_HEIGHT);
  const gesture = useRef<{ pointerId: number; startY: number; startHeight: number } | undefined>(undefined);
  const resize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    setHeight(Math.max(
      MIN_TEXTAREA_HEIGHT,
      Math.min(MAX_TEXTAREA_HEIGHT, Math.round(active.startHeight + event.clientY - active.startY)),
    ));
  };
  const finish = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (gesture.current?.pointerId !== event.pointerId) return;
    gesture.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div className="search-field">
      <label htmlFor={id}>{label}</label>
      <div className="search-textarea-shell" style={{ height }}>
        <textarea
          id={id}
          value={value}
          rows={2}
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          onCompositionStart={() => {
            onCompositionStart?.();
            onCompositionChange?.(true);
          }}
          onCompositionEnd={(event) => {
            if (onCompositionEnd) onCompositionEnd(event.currentTarget.value);
            else onChange(event.currentTarget.value);
            onCompositionChange?.(false);
          }}
          placeholder={placeholder}
        />
        <button
          type="button"
          className="search-textarea-resize-handle"
          aria-label={`调整${label}输入框高度`}
          title={`拖动调整${label}输入框高度；双击恢复`}
          onDoubleClick={() => setHeight(DEFAULT_TEXTAREA_HEIGHT)}
          onPointerDown={(event) => {
            event.preventDefault();
            gesture.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: height };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={resize}
          onPointerUp={finish}
          onPointerCancel={finish}
        >
          <Icon name="resize" size={14} />
        </button>
      </div>
    </div>
  );
}

function rectanglesIntersect(
  left: { left: number; top: number; right: number; bottom: number },
  right: { left: number; top: number; right: number; bottom: number },
): boolean {
  return (
    left.left <= right.right &&
    left.right >= right.left &&
    left.top <= right.bottom &&
    left.bottom >= right.top
  );
}
