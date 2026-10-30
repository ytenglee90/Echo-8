'use client';

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react';
import type { ViewClient } from '../core/contracts.ts';
import type { AppearancePreview } from '../protocols/appearance.ts';
import type {
  CameraState,
  CanvasAppearanceSnapshot,
  CanvasEntityHoverPreview,
  DragPreview,
  LassoSignal,
} from '../protocols/canvas.ts';
import type { ContentSummary, NodePosition } from '../protocols/content.ts';
import type { SelectionSnapshot } from '../protocols/selection.ts';
import { useContentCatalog } from './runtime-hooks.ts';

interface CanvasLayerEnvironment<TElement extends Element> {
  capabilityVersion: number;
  nodes: ContentSummary[];
  nodeById: ReadonlyMap<string, ContentSummary>;
  camera: CameraState;
  previews: Record<string, NodePosition>;
  duplicateOriginIds: ReadonlySet<string>;
  sizePreviews: Record<string, { width: number; height: number }>;
  selectedIds: string[];
  hoveredEntityId?: string;
  editingEntityIds: ReadonlySet<string>;
  lassoActive: boolean;
  canvasColor: string;
  surfaceSize: { width: number; height: number };
  layerRef: RefObject<TElement | null>;
}

/** Shared, read-only environment used by governed canvas overlay layers. */
export function useCanvasLayerEnvironment<TElement extends Element>(
  client: ViewClient,
  options: { trackInteractionFocus?: boolean } = {},
): CanvasLayerEnvironment<TElement> {
  const workspaceVersion = useSyncExternalStore(client.subscribeState, client.getWorkspaceVersion, () => 0);
  const capabilityVersion = useSyncExternalStore(
    client.subscribeCapabilities,
    client.getCapabilityVersion,
    () => 0,
  );
  const { summaries: nodes, byId: nodeById } = useContentCatalog(client, { geometryOnly: true });
  const [camera, setCamera] = useState<CameraState>({ x: 0, y: 0, zoom: 1 });
  const [previews, setPreviews] = useState<Record<string, NodePosition>>({});
  const [duplicateOriginIds, setDuplicateOriginIds] = useState<ReadonlySet<string>>(() => new Set());
  const [sizePreviews, setSizePreviews] = useState<Record<string, { width: number; height: number }>>({});
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [hoveredEntityId, setHoveredEntityId] = useState<string>();
  const [editingEntityIds, setEditingEntityIds] = useState<ReadonlySet<string>>(() => new Set());
  const [lassoActive, setLassoActive] = useState(false);
  const [committedCanvasColor, setCommittedCanvasColor] = useState('#efefec');
  const [previewCanvasColor, setPreviewCanvasColor] = useState<string>();
  const [surfaceSize, setSurfaceSize] = useState({ width: 0, height: 0 });
  const layerRef = useRef<TElement>(null);

  useEffect(() => {
    const element = layerRef.current;
    if (!element) return;
    const updateSize = () => setSurfaceSize({
      width: element.clientWidth,
      height: element.clientHeight,
    });
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let current = true;
    void client.request<CameraState>('canvas.camera@1').then((next) => {
      if (current) setCamera(next);
    }).catch(() => undefined);
    return () => {
      current = false;
    };
  }, [capabilityVersion, client]);

  useEffect(() => {
    let current = true;
    void client.request<CanvasAppearanceSnapshot>('canvas.appearance@1')
      .then((appearance) => current && setCommittedCanvasColor(appearance.color))
      .catch(() => current && setCommittedCanvasColor('#efefec'));
    return () => {
      current = false;
    };
  }, [capabilityVersion, client]);

  useEffect(
    () => client.subscribeSignal('canvas.appearance.invalidated', () => {
      void client.request<CanvasAppearanceSnapshot>('canvas.appearance@1')
        .then((appearance) => setCommittedCanvasColor(appearance.color))
        .catch(() => undefined);
    }),
    [client],
  );

  useEffect(
    () => client.subscribeSignal<AppearancePreview>('appearance.color.preview', (message) => {
      const preview = message.payload;
      setPreviewCanvasColor(!preview.clear && preview.kind === 'canvas-background'
        ? preview.color
        : undefined);
    }),
    [client],
  );

  useEffect(() => {
    let current = true;
    void client.request<SelectionSnapshot>('selection.read@1').then((selection) => {
      if (current) setSelectedIds(selection.ids);
    }).catch(() => undefined);
    return () => {
      current = false;
    };
  }, [capabilityVersion, client, workspaceVersion]);

  useEffect(
    () => client.subscribeSignal<CameraState>('canvas.camera.preview', (message) => setCamera(message.payload)),
    [client],
  );

  useEffect(
    () => client.subscribeSignal<{ id?: string; width?: number; height?: number; clear?: boolean }>(
      'canvas.node.resize.preview',
      (message) => {
        const payload = message.payload;
        if (payload.clear || !payload.id || payload.width === undefined || payload.height === undefined) {
          setSizePreviews({});
          return;
        }
        setSizePreviews({ [payload.id]: { width: payload.width, height: payload.height } });
      },
    ),
    [client],
  );

  useEffect(
    () => client.subscribeSignal<DragPreview>('canvas.drag.preview', (message) => {
      if (message.payload.clear) {
        setPreviews({});
        setDuplicateOriginIds(new Set());
        return;
      }
      setPreviews(Object.fromEntries(
        (message.payload.positions ?? []).map((position) => [position.id, position]),
      ));
      setDuplicateOriginIds(new Set(
        (message.payload.duplicateOrigins ?? []).map((position) => position.id),
      ));
    }),
    [client],
  );

  useEffect(() => {
    if (!options.trackInteractionFocus) return;
    let current = true;
    void client.ask<string[]>('editor.openPanes').then((ids) => {
      if (current) setEditingEntityIds(new Set(ids));
    }).catch(() => {
      if (current) setEditingEntityIds(new Set());
    });
    return () => {
      current = false;
    };
  }, [capabilityVersion, client, options.trackInteractionFocus, workspaceVersion]);

  useEffect(() => {
    if (!options.trackInteractionFocus) return;
    return client.subscribeSignal<CanvasEntityHoverPreview>('canvas.entity.hover.preview', (message) => {
      const payload = message.payload;
      setHoveredEntityId((current) => payload.clear
        ? payload.id && current !== payload.id ? current : undefined
        : payload.id);
    });
  }, [client, options.trackInteractionFocus]);

  useEffect(() => {
    if (!options.trackInteractionFocus) return;
    return client.subscribeSignal<LassoSignal>('canvas.lasso.preview', (message) => {
      setLassoActive(!('clear' in message.payload && message.payload.clear === true));
    });
  }, [client, options.trackInteractionFocus]);

  return {
    capabilityVersion,
    nodes,
    nodeById,
    camera,
    previews,
    duplicateOriginIds,
    sizePreviews,
    selectedIds,
    hoveredEntityId,
    editingEntityIds,
    lassoActive,
    canvasColor: previewCanvasColor ?? committedCanvasColor,
    surfaceSize,
    layerRef,
  };
}
