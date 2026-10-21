'use client';

import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import { SpatialHashIndex } from '../../core/spatial-index.ts';
import type {
  CanvasPointerSnapshot,
  CanvasSnapPreview,
  DragPreview,
  CanvasWheelZoomRequest,
} from '../../protocols/canvas.ts';
import type { ContentSummary, NodePosition } from '../../protocols/content.ts';
import type { GroupMembershipPreview, GroupRecord } from '../../protocols/groups.ts';
import type { SmartSnapRequest, SmartSnapResult } from '../../protocols/layout.ts';
import type {
  SelectionMode,
  SelectionResolution,
} from '../../protocols/selection.ts';
import { boundsIntersect, clientPointInWorld, worldViewport } from '../../protocols/viewport.ts';
import { useCanvasLayerEnvironment } from '../../ui/use-canvas-layer-environment.ts';
import { canvasContrastVariables } from '../../ui/canvas-contrast.ts';
import { resolveGroupDropTarget } from './drop-target.ts';
import { computeGroupBounds } from './layout.ts';

const CULL_MARGIN = 360;
const SNAP_THRESHOLD_PX = 18;

interface GroupDrag {
  groupId: string;
  pointerX: number;
  pointerY: number;
  origins: NodePosition[];
  latest: NodePosition[];
  moved: boolean;
  duplicateOnCommit: boolean;
}

interface PendingGroupDrag {
  pointerId: number;
  startX: number;
  startY: number;
  latestX: number;
  latestY: number;
  released: boolean;
  cancelled: boolean;
  duplicateOnCommit: boolean;
}

export function GroupLayer({ client }: { client: ViewClient }) {
  const {
    capabilityVersion,
    nodes,
    nodeById,
    camera,
    previews,
    sizePreviews,
    selectedIds,
    canvasColor,
    surfaceSize,
    layerRef,
  } = useCanvasLayerEnvironment<HTMLDivElement>(client);
  useSyncExternalStore(client.subscribeKeyboard, client.getKeyboardVersion, () => 0);
  const duplicateModifierActive = client.isShortcutPressed('canvas.duplicate-modifier');
  const [groups, setGroups] = useState<GroupRecord[]>([]);
  const [membershipPreview, setMembershipPreview] = useState<GroupMembershipPreview>();
  const drag = useRef<GroupDrag | undefined>(undefined);
  const pendingDrag = useRef<PendingGroupDrag | undefined>(undefined);

  useEffect(() => {
    let current = true;
    void client.request<GroupRecord[]>('groups.list@1').then((nextGroups) => {
      if (!current) return;
      setGroups(nextGroups);
    }).catch(() => undefined);
    return () => {
      current = false;
    };
  }, [capabilityVersion, client]);

  useEffect(
    () => client.subscribeSignal('groups.invalidated', () => {
      void client.request<GroupRecord[]>('groups.list@1')
        .then(setGroups)
        .catch(() => setGroups([]));
    }),
    [client],
  );

  useEffect(() => {
    client.emit('canvas.snap.preview', { clear: true } satisfies CanvasSnapPreview);
  }, [capabilityVersion, client]);

  useEffect(() => {
    if (pendingDrag.current) pendingDrag.current.duplicateOnCommit = duplicateModifierActive;
    if (!drag.current) return;
    drag.current.duplicateOnCommit = duplicateModifierActive;
    if (drag.current.moved) {
      client.emit('canvas.drag.preview', {
        positions: drag.current.latest,
        duplicateOrigins: duplicateModifierActive ? drag.current.origins : [],
      } satisfies DragPreview);
    }
  }, [client, duplicateModifierActive]);

  useEffect(
    () => client.subscribeSignal<GroupMembershipPreview>('group.membership.preview', (message) => {
      if ('clear' in message.payload || !message.payload.active) {
        setMembershipPreview(undefined);
        return;
      }
      setMembershipPreview(message.payload);
    }),
    [client],
  );

  const stableNodeMap = useMemo(
    () => new Map(nodeById),
    [nodeById],
  );
  const nodeMap = useMemo(
    () => new Map([...stableNodeMap].map(([id, node]) => [
      id,
      { ...node, ...previews[id], ...sizePreviews[id] },
    ])),
    [previews, sizePreviews, stableNodeMap],
  );
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const membershipTarget = useMemo(() => {
    if (!membershipPreview || 'clear' in membershipPreview || !membershipPreview.active) return undefined;
    return resolveGroupDropTarget(groups, nodes, membershipPreview);
  }, [groups, membershipPreview, nodes]);
  const viewport = useMemo(
    () => worldViewport(camera, surfaceSize, CULL_MARGIN),
    [camera, surfaceSize],
  );
  const groupLookup = useMemo(() => {
    const byId = new Map<string, GroupRecord>();
    const byNode = new Map<string, Set<string>>();
    for (const group of groups) {
      byId.set(group.id, group);
      for (const nodeId of group.memberIds) {
        const ids = byNode.get(nodeId) ?? new Set<string>();
        ids.add(group.id);
        byNode.set(nodeId, ids);
      }
    }
    return { byId, byNode };
  }, [groups]);
  const groupIndex = useMemo(() => {
    const index = new SpatialHashIndex<GroupRecord>();
    index.rebuild(
      groups.filter((group) => group.memberIds.filter((id) => stableNodeMap.has(id)).length >= 2),
      (group) => group.id,
      (group) => computeGroupBounds(
        group.memberIds.map((id) => stableNodeMap.get(id)).filter(Boolean) as ContentSummary[],
      ),
    );
    return index;
  }, [groups, stableNodeMap]);
  const visibleGroups = useMemo(() => {
    const candidates = new Map(groupIndex.query(viewport).map((group) => [group.id, group]));
    const affectedNodeIds = new Set([...Object.keys(previews), ...Object.keys(sizePreviews)]);
    if (membershipPreview && !('clear' in membershipPreview)) affectedNodeIds.add(membershipPreview.nodeId);
    for (const nodeId of affectedNodeIds) {
      for (const groupId of groupLookup.byNode.get(nodeId) ?? []) {
        const group = groupLookup.byId.get(groupId);
        if (group) candidates.set(groupId, group);
      }
    }
    if (membershipTarget) {
      const group = groupLookup.byId.get(membershipTarget.groupId);
      if (group) candidates.set(group.id, group);
    }
    return [...candidates.values()];
  }, [groupIndex, groupLookup, membershipPreview, membershipTarget, previews, sizePreviews, viewport]);

  const snapGroupPositions = (positions: NodePosition[], groupId: string): NodePosition[] => {
    const positioned = new Map(positions.map((position) => [position.id, position]));
    const movingNodes = positions.flatMap((position) => {
      const node = stableNodeMap.get(position.id);
      return node ? [{ ...node, ...position }] : [];
    });
    if (movingNodes.length === 0 || positioned.size === 0) {
      client.emit('canvas.snap.preview', { clear: true } satisfies CanvasSnapPreview);
      return positions;
    }
    const dragged = computeGroupBounds(movingNodes);
    let snap: SmartSnapResult;
    try {
      snap = client.requestSync<SmartSnapResult>('layout.snap@1', {
        dragged,
        movingIds: [groupId, ...positions.map((position) => position.id)],
        mode: 'group',
        threshold: SNAP_THRESHOLD_PX / Math.max(camera.zoom, 0.28),
      } satisfies SmartSnapRequest);
    } catch {
      client.emit('canvas.snap.preview', { clear: true } satisfies CanvasSnapPreview);
      return positions;
    }
    client.emit('canvas.snap.preview', snap.guides.length > 0
      ? { guides: snap.guides } satisfies CanvasSnapPreview
      : { clear: true } satisfies CanvasSnapPreview);
    if (snap.offsetX === 0 && snap.offsetY === 0) return positions;
    return positions.map((position) => ({
      ...position,
      x: position.x + snap.offsetX,
      y: position.y + snap.offsetY,
    }));
  };

  const beginDrag = (
    event: ReactPointerEvent<HTMLElement>,
    group: GroupRecord,
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const duplicateOnCommit = event.altKey || duplicateModifierActive;
    const request: PendingGroupDrag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      latestX: event.clientX,
      latestY: event.clientY,
      released: false,
      cancelled: false,
      duplicateOnCommit,
    };
    pendingDrag.current = request;
    event.currentTarget.setPointerCapture(event.pointerId);
    const mode = duplicateOnCommit ? 'replace' : modifierMode(event);
    void client.dispatch('interaction.begin', { mode: 'dragging-node' }).then(() =>
      client.request<SelectionResolution>('selection.resolve@1', {
        items: [{ id: group.id, kind: 'group' }],
        mode,
        preserveIfSelected: true,
      })
    ).then((resolution) => {
      if (request.cancelled) return;
      void client.dispatch('selection.set', { items: resolution.items, mode: 'replace' });
      if (!resolution.expandedIds.includes(group.id)) {
        if (pendingDrag.current === request) pendingDrag.current = undefined;
        void client.dispatch('interaction.end', { mode: 'dragging-node' }).catch(() => undefined);
        return;
      }
      const expanded = new Set(resolution.expandedIds);
      const origins = nodes
        .filter((node) => expanded.has(node.id))
        .map((node) => ({ id: node.id, x: node.x, y: node.y }));
      if (pendingDrag.current === request) pendingDrag.current = undefined;
      if (origins.length === 0) {
        void client.dispatch('interaction.end', { mode: 'dragging-node' }).catch(() => undefined);
        return;
      }
      const dx = (request.latestX - request.startX) / camera.zoom;
      const dy = (request.latestY - request.startY) / camera.zoom;
      const rawLatest = origins.map((origin) => ({ ...origin, x: origin.x + dx, y: origin.y + dy }));
      const moved = Math.abs(dx) + Math.abs(dy) > 2;
      const latest = moved ? snapGroupPositions(rawLatest, group.id) : rawLatest;
      if (request.released) {
        client.emit('canvas.snap.preview', { clear: true } satisfies CanvasSnapPreview);
        if (moved) {
          const offset = { x: latest[0].x - origins[0].x, y: latest[0].y - origins[0].y };
          const command = request.duplicateOnCommit
            ? client.dispatch('clipboard.duplicateSelectionAt', { offset })
            : client.dispatch('node.moveMany', { positions: latest });
          void command
            .finally(() => client.dispatch('interaction.end', { mode: 'dragging-node' }).catch(() => undefined));
        } else {
          void client.dispatch('interaction.end', { mode: 'dragging-node' }).catch(() => undefined);
        }
        return;
      }
      drag.current = {
        groupId: group.id,
        pointerX: request.startX,
        pointerY: request.startY,
        origins,
        latest,
        moved,
        duplicateOnCommit: request.duplicateOnCommit,
      };
      if (moved) client.emit('canvas.drag.preview', {
        positions: latest,
        duplicateOrigins: request.duplicateOnCommit ? origins : [],
      } satisfies DragPreview);
    }).catch(() => {
      request.cancelled = true;
      if (pendingDrag.current === request) pendingDrag.current = undefined;
      client.emit('canvas.drag.preview', { clear: true });
      client.emit('canvas.snap.preview', { clear: true } satisfies CanvasSnapPreview);
      void client.dispatch('interaction.end', { mode: 'dragging-node' }).catch(() => undefined);
    });
  };

  const moveDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (pendingDrag.current?.pointerId === event.pointerId) {
      pendingDrag.current.latestX = event.clientX;
      pendingDrag.current.latestY = event.clientY;
    }
    if (!drag.current) return;
    const dx = (event.clientX - drag.current.pointerX) / camera.zoom;
    const dy = (event.clientY - drag.current.pointerY) / camera.zoom;
    drag.current.moved ||= Math.abs(dx) + Math.abs(dy) > 2;
    if (!drag.current.moved) return;
    const rawLatest = drag.current.origins.map((origin) => ({
      id: origin.id,
      x: origin.x + dx,
      y: origin.y + dy,
    }));
    drag.current.latest = snapGroupPositions(rawLatest, drag.current.groupId);
    drag.current.duplicateOnCommit = event.altKey || duplicateModifierActive;
    client.emit('canvas.drag.preview', {
      positions: drag.current.latest,
      duplicateOrigins: drag.current.duplicateOnCommit ? drag.current.origins : [],
    } satisfies DragPreview);
  };

  const finishDrag = () => {
    if (pendingDrag.current) {
      pendingDrag.current.duplicateOnCommit = duplicateModifierActive;
      pendingDrag.current.released = true;
      return;
    }
    const current = drag.current;
    if (!current) return;
    drag.current = undefined;
    client.emit('canvas.drag.preview', { clear: true });
    client.emit('canvas.snap.preview', { clear: true } satisfies CanvasSnapPreview);
    if (current.moved) {
      const offset = {
        x: current.latest[0].x - current.origins[0].x,
        y: current.latest[0].y - current.origins[0].y,
      };
      const command = current.duplicateOnCommit
        ? client.dispatch('clipboard.duplicateSelectionAt', { offset })
        : client.dispatch('node.moveMany', { positions: current.latest });
      void command
        .finally(() => client.dispatch('interaction.end', { mode: 'dragging-node' }).catch(() => undefined));
    } else {
      void client.dispatch('interaction.end', { mode: 'dragging-node' }).catch(() => undefined);
    }
  };

  const cancelDrag = () => {
    const hadInteraction = Boolean(pendingDrag.current || drag.current);
    if (pendingDrag.current) pendingDrag.current.cancelled = true;
    pendingDrag.current = undefined;
    drag.current = undefined;
    client.emit('canvas.drag.preview', { clear: true });
    client.emit('canvas.snap.preview', { clear: true } satisfies CanvasSnapPreview);
    if (hadInteraction) {
      void client.dispatch('interaction.end', { mode: 'dragging-node' }).catch(() => undefined);
    }
  };

  const publishPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const layer = layerRef.current;
    if (!layer) return;
    const rect = layer.getBoundingClientRect();
    client.emit('canvas.pointer.preview', {
      point: clientPointInWorld(camera, rect, { x: event.clientX, y: event.clientY }),
    } satisfies CanvasPointerSnapshot);
  };

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const forwardWheelZoom = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      client.emit('canvas.wheel.requested', {
        clientX: event.clientX,
        clientY: event.clientY,
        deltaY: event.deltaY,
      } satisfies CanvasWheelZoomRequest);
    };
    layer.addEventListener('wheel', forwardWheelZoom, { passive: false });
    return () => layer.removeEventListener('wheel', forwardWheelZoom);
  }, [client, layerRef]);

  return (
    <div
      ref={layerRef}
      className="group-layer"
      style={canvasContrastVariables(canvasColor) as CSSProperties}
      aria-label="群组图层"
      onPointerEnter={publishPointer}
      onPointerMove={publishPointer}
      onPointerLeave={() => client.emit('canvas.pointer.preview', { clear: true } satisfies CanvasPointerSnapshot)}
    >
      <div
        className="group-world"
        style={{ transform: `translate3d(${camera.x}px, ${camera.y}px, 0) scale(${camera.zoom})` }}
      >
        {visibleGroups.map((group) => {
          let previewMemberIds = group.memberIds;
          if (membershipTarget?.groupId === group.id && membershipPreview && !('clear' in membershipPreview)) {
            previewMemberIds = membershipTarget.action === 'remove'
              ? group.memberIds.filter((id) => id !== membershipPreview.nodeId)
              : [...new Set([...group.memberIds, membershipPreview.nodeId])];
          }
          const members = previewMemberIds.map((id) => nodeMap.get(id)).filter(Boolean) as ContentSummary[];
          if (members.length < 2) return null;
          const bounds = computeGroupBounds(members);
          if (!boundsIntersect(viewport, bounds)) return null;
          const isSelected = selected.has(group.id);
          return (
            <section
              key={group.id}
              className={`group-frame ${isSelected ? 'selected' : ''}`}
              style={{
                left: bounds.x,
                top: bounds.y,
                width: bounds.width,
                height: bounds.height,
              }}
              aria-label={`群组，包含 ${members.length} 个节点`}
              aria-pressed={isSelected}
              role="button"
              tabIndex={0}
              onPointerDown={(event) => beginDrag(event, group)}
              onPointerMove={moveDrag}
              onPointerUp={finishDrag}
              onPointerCancel={cancelDrag}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                void client.dispatch('selection.set', {
                  items: [{ id: group.id, kind: 'group' }],
                  mode: modifierMode(event),
                });
              }}
            >
            </section>
          );
        })}
      </div>
    </div>
  );
}

function modifierMode(event: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean }): SelectionMode {
  if (event.altKey) return 'remove';
  if (event.shiftKey) return 'add';
  if (event.ctrlKey || event.metaKey) return 'toggle';
  return 'replace';
}
