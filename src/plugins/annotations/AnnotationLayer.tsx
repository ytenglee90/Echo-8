'use client';

import { type CSSProperties, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import type { AnnotationRecord } from '../../protocols/annotations.ts';
import type { CameraState, DragPreview } from '../../protocols/canvas.ts';
import type { ContentSummary } from '../../protocols/content.ts';
import type { GroupRecord } from '../../protocols/groups.ts';
import { Icon } from '../../ui/Icon.tsx';
import { canvasDetailScreenScale, worldPointToCanvasScreen } from '../../ui/canvas-screen-scale.ts';
import { useContentCatalog } from '../../ui/runtime-hooks.ts';
import { ANNOTATION_NAMESPACE } from './model.ts';

const DEFAULT_CAMERA: CameraState = { x: 0, y: 0, zoom: 1 };

export function AnnotationLayer({ client }: { client: ViewClient }) {
  const annotationVersion = useSyncExternalStore(
    client.subscribeState,
    () => client.getOwnStateVersion(ANNOTATION_NAMESPACE),
    () => 0,
  );
  const capabilityVersion = useSyncExternalStore(
    client.subscribeCapabilities,
    client.getCapabilityVersion,
    () => 0,
  );
  const { byId } = useContentCatalog(client, { geometryOnly: true });
  const [annotations, setAnnotations] = useState<AnnotationRecord[]>([]);
  const [groups, setGroups] = useState<GroupRecord[]>([]);
  const [camera, setCamera] = useState<CameraState>(DEFAULT_CAMERA);
  const [previews, setPreviews] = useState<Record<string, { x: number; y: number }>>({});
  const [sizes, setSizes] = useState<Record<string, { width: number; height: number }>>({});

  const refreshAnnotations = () => {
    void client.request<AnnotationRecord[]>('annotations.list@1')
      .then(setAnnotations)
      .catch(() => setAnnotations([]));
  };
  const refreshGroups = () => {
    void client.request<GroupRecord[]>('groups.list@1')
      .then(setGroups)
      .catch(() => setGroups([]));
  };

  useEffect(() => {
    refreshAnnotations();
    refreshGroups();
    void client.request<CameraState>('canvas.camera@1').then(setCamera).catch(() => undefined);
    // Refresh helpers intentionally use the stable plugin client.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [annotationVersion, capabilityVersion, client]);
  useEffect(
    () => client.subscribeSignal('annotations.invalidated', refreshAnnotations),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client],
  );
  useEffect(
    () => client.subscribeSignal('groups.invalidated', refreshGroups),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client],
  );
  useEffect(
    () => client.subscribeSignal<CameraState>('canvas.camera.preview', (message) => setCamera(message.payload)),
    [client],
  );
  useEffect(
    () => client.subscribeSignal<DragPreview>('canvas.drag.preview', (message) => {
      setPreviews(message.payload.clear
        ? {}
        : Object.fromEntries((message.payload.positions ?? []).map((item) => [item.id, item])));
    }),
    [client],
  );
  useEffect(
    () => client.subscribeSignal<{ id?: string; width?: number; height?: number; clear?: boolean }>(
      'canvas.node.resize.preview',
      (message) => {
        const payload = message.payload;
        setSizes(payload.clear || !payload.id || payload.width === undefined || payload.height === undefined
          ? {}
          : { [payload.id]: { width: payload.width, height: payload.height } });
      },
    ),
    [client],
  );

  const nodeMap = useMemo(() => new Map([...byId].map(([id, node]) => [
    id,
    { ...node, ...previews[id], ...sizes[id] },
  ])), [byId, previews, sizes]);
  const groupMap = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);
  const targetOrder = new Map<string, number>();

  return (
    <div className="annotation-layer" aria-label="画布注释">
      {annotations.flatMap((annotation) => {
        if (annotation.target.kind === 'text-range') return [];
        const targetKey = `${annotation.target.kind}:${annotation.target.targetId}`;
        const order = targetOrder.get(targetKey) ?? 0;
        targetOrder.set(targetKey, order + 1);
        const point = annotation.target.kind === 'text-node'
          ? nodeAnchor(nodeMap.get(annotation.target.targetId), order)
          : groupAnchor(groupMap.get(annotation.target.targetId), nodeMap, order);
        if (!point) return [];
        const screenPoint = worldPointToCanvasScreen(camera, point);
        const left = screenPoint.x;
        const top = screenPoint.y;
        if (left < -32 || top < -32 || left > globalThis.innerWidth + 32 || top > globalThis.innerHeight + 32) {
          return [];
        }
        return [(
          <button
            type="button"
            className="annotation-canvas-marker"
            key={annotation.id}
            style={{
              left,
              top,
              '--canvas-detail-screen-scale': canvasDetailScreenScale(camera.zoom),
            } as CSSProperties}
            title={annotation.body || '打开注释'}
            aria-label={`打开注释${annotation.body ? `：${annotation.body.slice(0, 40)}` : ''}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              void client.dispatch('annotation.open', {
                id: annotation.id,
                anchor: { x: event.clientX, y: event.clientY },
              });
            }}
          >
            <Icon name="comment" size={12} />
          </button>
        )];
      })}
    </div>
  );
}

function nodeAnchor(node: ContentSummary | undefined, order: number) {
  if (!node) return undefined;
  return { x: node.x + 16 + order * 17, y: node.y + 21 };
}

function groupAnchor(
  group: GroupRecord | undefined,
  nodes: ReadonlyMap<string, ContentSummary>,
  order: number,
) {
  if (!group) return undefined;
  const members = group.memberIds.map((id) => nodes.get(id)).filter(Boolean) as ContentSummary[];
  if (members.length === 0) return undefined;
  const left = Math.min(...members.map((node) => node.x));
  const top = Math.min(...members.map((node) => node.y));
  const right = Math.max(...members.map((node) => node.x + node.width));
  const bottom = Math.max(...members.map((node) => node.y + node.height));
  const bounds = { x: left - 25, y: top - 25, width: right - left + 50, height: bottom - top + 50 };
  return { x: bounds.x + bounds.width - 7 - order * 17, y: bounds.y - 7 };
}
