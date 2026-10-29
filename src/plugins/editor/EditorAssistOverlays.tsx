import {
  type CSSProperties,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import type { AnnotationMarkerAnchorsPreview, AnnotationRecord } from '../../protocols/annotations.ts';
import { appearancePreviewTarget, type AppearancePreview } from '../../protocols/appearance.ts';
import type {
  TextCompletionCandidate,
  TextCorrectionDecoration,
  TextNodeReferenceDecoration,
  TextNodeReferenceTarget,
} from '../../protocols/text-assist.ts';
import { Icon } from '../../ui/Icon.tsx';
import { contrastingInk } from '../../ui/color-contrast.ts';
import { textOffsetToDomPoint } from './dom-text-selection.ts';

export type TextAssistMenu =
  | {
      kind: 'completion';
      candidates: TextCompletionCandidate[];
      activeIndex: number;
      left: number;
      top: number;
    }
  | {
      kind: 'correction';
      decoration: TextCorrectionDecoration;
      left: number;
      top: number;
    }
  | {
      kind: 'node-reference';
      decoration: TextNodeReferenceDecoration;
      left: number;
      top: number;
    };

export function EditorAnnotationMarkers({
  client,
  nodeId,
  rootRef,
  shellRef,
  windowStart,
  windowLength,
  layoutRevision,
  measurementBlockedRef,
  recordsRef,
}: {
  client: ViewClient;
  nodeId: string;
  rootRef: RefObject<HTMLDivElement | null>;
  shellRef: RefObject<HTMLDivElement | null>;
  windowStart: number;
  windowLength: number;
  layoutRevision: number;
  measurementBlockedRef: RefObject<boolean>;
  recordsRef?: MutableRefObject<AnnotationRecord[]>;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const anchorSourceId = useId();
  const capabilityVersion = useSyncExternalStore(
    client.subscribeCapabilities,
    client.getCapabilityVersion,
    () => 0,
  );
  const [invalidation, setInvalidation] = useState(0);
  const [records, setRecords] = useState<AnnotationRecord[]>([]);
  const [appearancePreview, setAppearancePreview] = useState<AppearancePreview>();
  const [positions, setPositions] = useState<Record<string, { left: number; top: number; visible: boolean }>>({});

  useEffect(
    () => client.subscribeSignal('annotations.invalidated', () => setInvalidation((value) => value + 1)),
    [client],
  );
  useEffect(
    () => client.subscribeSignal<AppearancePreview>('appearance.color.preview', (message) => {
      setAppearancePreview(message.payload.clear ? undefined : message.payload);
    }),
    [client],
  );
  useEffect(() => {
    const controller = new AbortController();
    void client.request<AnnotationRecord[]>('annotations.forTarget@1', { targetId: nodeId }, controller.signal)
      .then((items) => {
        const next = items.filter((item) => item.target.kind === 'text-range');
        if (recordsRef) recordsRef.current = next;
        setRecords(next);
      })
      .catch(() => {
        if (recordsRef) recordsRef.current = [];
        setRecords([]);
      });
    return () => controller.abort();
  }, [capabilityVersion, client, invalidation, nodeId, recordsRef]);

  useEffect(() => {
    const root = rootRef.current;
    const shell = shellRef.current;
    if (!root || !shell) return;
    let frame = 0;
    const update = () => {
      globalThis.cancelAnimationFrame?.(frame);
      frame = globalThis.requestAnimationFrame?.(() => {
        if (measurementBlockedRef.current) return;
        const shellRect = shell.getBoundingClientRect();
        const rootRect = root.getBoundingClientRect();
        const next: Record<string, { left: number; top: number; visible: boolean }> = {};
        for (const record of records) {
          if (record.target.kind !== 'text-range') continue;
          const localOffset = record.target.offset - windowStart;
          if (localOffset < 0 || localOffset > windowLength) continue;
          const point = textOffsetToDomPoint(root, localOffset);
          if (!point) continue;
          const range = root.ownerDocument.createRange();
          range.setStart(point.node, point.offset);
          range.collapse(true);
          const rect = range.getClientRects().item(0) ?? range.getBoundingClientRect();
          const left = rect.left - shellRect.left + 2;
          const top = rect.top - shellRect.top - 7;
          next[record.id] = {
            left,
            top,
            visible: rect.top >= rootRect.top - 8 && rect.bottom <= rootRect.bottom + 8 &&
              rect.left >= rootRect.left - 8 && rect.left <= rootRect.right + 8,
          };
        }
        setPositions(next);
      }) ?? 0;
    };
    update();
    root.addEventListener('scroll', update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(root);
    observer.observe(shell);
    return () => {
      globalThis.cancelAnimationFrame?.(frame);
      root.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, [layoutRevision, measurementBlockedRef, records, rootRef, shellRef, windowLength, windowStart]);

  const publishMarkerAnchors = () => {
    const anchors = [...(layerRef.current?.querySelectorAll<HTMLElement>('[data-annotation-id]') ?? [])]
      .map((marker) => ({ id: marker.dataset.annotationId ?? '', rect: marker.getBoundingClientRect() }))
      .filter((anchor) => anchor.id && anchor.rect.width > 0 && anchor.rect.height > 0)
      .map((anchor) => ({
        id: anchor.id,
        rect: {
          x: anchor.rect.x,
          y: anchor.rect.y,
          width: anchor.rect.width,
          height: anchor.rect.height,
        },
      }));
    client.emit('annotations.markerAnchors.preview', {
      sourceId: anchorSourceId,
      anchors,
    } satisfies AnnotationMarkerAnchorsPreview);
  };
  useEffect(publishMarkerAnchors);
  useEffect(() => () => client.emit('annotations.markerAnchors.preview', {
    sourceId: anchorSourceId,
    clear: true,
  } satisfies AnnotationMarkerAnchorsPreview), [anchorSourceId, client]);

  return (
    <div className="editor-annotation-layer" aria-label="正文注释" ref={layerRef}>
      {records.map((record) => {
        const position = positions[record.id];
        if (!position?.visible) return null;
        const annotationPreview = appearancePreviewTarget(appearancePreview, 'annotation-marker');
        const previewColor = annotationPreview?.entityIds.includes(record.id)
          ? annotationPreview.color
          : undefined;
        const color = previewColor ?? record.color;
        return (
          <button
            type="button"
            key={record.id}
            className="editor-annotation-marker"
            data-annotation-id={record.id}
            data-annotation-offset={record.target.kind === 'text-range' ? record.target.offset : undefined}
            style={{
              left: position.left,
              top: position.top,
              ...(color ? {
                '--annotation-color': color,
                '--annotation-ink': contrastingInk(color),
              } : {}),
            } as CSSProperties}
            title={record.body || '双击打开注释'}
            aria-label={`双击打开注释${record.body ? `：${record.body.slice(0, 40)}` : ''}`}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.stopPropagation();
              publishMarkerAnchors();
              void client.dispatch('selection.set', {
                items: [{ id: record.id, kind: 'annotation' }],
                mode: 'replace',
              });
            }}
            onDoubleClick={(event) => {
              event.stopPropagation();
              publishMarkerAnchors();
              void client.dispatch('annotation.open', {
                id: record.id,
                anchor: { x: event.clientX, y: event.clientY },
              });
            }}
          >
            <Icon name="comment" size={9} />
          </button>
        );
      })}
    </div>
  );
}

export function TextAssistMenuView({
  menu,
  onChooseCompletion,
  onChooseCorrection,
  onChooseReference,
  onActiveCompletion,
}: {
  menu: TextAssistMenu;
  onChooseCompletion: (candidate: TextCompletionCandidate) => void;
  onChooseCorrection: (decoration: TextCorrectionDecoration, replacement: string) => void;
  onChooseReference: (target: TextNodeReferenceTarget) => void;
  onActiveCompletion: (index: number) => void;
}) {
  const style = { left: menu.left, top: menu.top } as CSSProperties;
  const keepEditorFocus = (event: ReactPointerEvent<HTMLElement>) => event.preventDefault();
  const completionListRef = useRef<HTMLElement>(null);
  const activeCompletionId = menu.kind === 'completion'
    ? menu.candidates[menu.activeIndex]?.id
    : undefined;
  useEffect(() => {
    if (!activeCompletionId) return;
    completionListRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeCompletionId]);
  if (menu.kind === 'correction') {
    return (
      <aside className="text-assist-menu correction" style={style} aria-label="纠错建议">
        <span className="text-assist-menu-label">{menu.decoration.message}</span>
        {menu.decoration.suggestions.map((suggestion) => (
          <button
            key={suggestion || 'delete'}
            type="button"
            onPointerDown={keepEditorFocus}
            onClick={() => onChooseCorrection(menu.decoration, suggestion)}
          >
            <strong>{suggestion || '删除多余内容'}</strong>
          </button>
        ))}
      </aside>
    );
  }
  if (menu.kind === 'node-reference') {
    return (
      <aside className="text-assist-menu reference" style={style} aria-label="选择要跳转的文字节点">
        <span className="text-assist-menu-label">“{menu.decoration.title}”对应多个节点</span>
        {menu.decoration.targets.map((target) => (
          <button
            key={target.id}
            type="button"
            onPointerDown={keepEditorFocus}
            onClick={() => onChooseReference(target)}
          >
            <strong>{target.title}</strong>
          </button>
        ))}
      </aside>
    );
  }
  return (
    <aside
      ref={completionListRef}
      className="text-assist-menu completion"
      style={style}
      role="listbox"
      aria-label="文字补全候选"
    >
      {menu.candidates.map((candidate, index) => (
        <button
          key={candidate.id}
          type="button"
          role="option"
          aria-selected={menu.activeIndex === index}
          className={menu.activeIndex === index ? 'active' : ''}
          onPointerDown={keepEditorFocus}
          onPointerEnter={() => onActiveCompletion(index)}
          onClick={() => onChooseCompletion(candidate)}
        >
          <span className="text-assist-menu-selection" aria-hidden="true">
            {menu.activeIndex === index ? '→' : ''}
          </span>
          <strong>{candidate.label}</strong>
        </button>
      ))}
    </aside>
  );
}
