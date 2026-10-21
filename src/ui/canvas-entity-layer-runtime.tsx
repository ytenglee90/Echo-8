'use client';

import { createContext, useContext, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { AppearancePreview } from '../protocols/appearance.ts';
import type { CameraState } from '../protocols/canvas.ts';
import type { ConnectionSide } from '../protocols/connections.ts';
import type { ContentSummary, NodePosition } from '../protocols/content.ts';

export interface CanvasEntityCharacterCount {
  revision: number;
  characters: number;
}

export interface CanvasEntityResizePreview {
  id: string;
  width: number;
  height: number;
}

/** Read-only render/gesture environment supplied by the canvas host to entity renderers. */
export interface CanvasEntityLayerRuntime {
  camera: CameraState;
  nodeById: ReadonlyMap<string, ContentSummary>;
  duplicateOrigins: NodePosition[];
  visibleNodes: ContentSummary[];
  offscreenSelectedNodes: ContentSummary[];
  previews: Record<string, NodePosition>;
  resizePreviews: Record<string, CanvasEntityResizePreview>;
  appearancePreview?: AppearancePreview;
  previewEntities: ReadonlySet<string>;
  nodeCharacterCounts: ReadonlyMap<string, CanvasEntityCharacterCount>;
  selected: ReadonlySet<string>;
  selectedIds: string[];
  connectionTargetId?: string;
  beginNodeDrag(event: ReactPointerEvent<HTMLElement>, node: ContentSummary): void;
  handleConnectionPort(
    event: ReactPointerEvent<HTMLButtonElement>,
    node: ContentSummary,
    side: ConnectionSide,
  ): void;
  beginNodeResize(event: ReactPointerEvent<HTMLButtonElement>, node: ContentSummary): void;
}

const CanvasEntityLayerContext = createContext<CanvasEntityLayerRuntime | undefined>(undefined);

export function CanvasEntityLayerProvider({
  value,
  children,
}: {
  value: CanvasEntityLayerRuntime;
  children?: ReactNode;
}) {
  return <CanvasEntityLayerContext.Provider value={value}>{children}</CanvasEntityLayerContext.Provider>;
}

export function useCanvasEntityLayerRuntime(): CanvasEntityLayerRuntime {
  const value = useContext(CanvasEntityLayerContext);
  if (!value) throw new Error('Canvas entity layer rendered outside the governed canvas host');
  return value;
}
