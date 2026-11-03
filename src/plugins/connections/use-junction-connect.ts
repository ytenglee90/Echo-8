'use client';
import type { ViewClient } from '../../core/contracts.ts';
import type { CameraState } from '../../protocols/canvas.ts';
import type { ConnectionJunction, ConnectionNodeGeometry } from '../../protocols/connections.ts';
import { useConnectionGesture } from '../../ui/use-connection-gesture.ts';
import type { PointerEvent } from 'react';

export function useJunctionConnect(client: ViewClient, camera: CameraState, nodes: ReadonlyMap<string, ConnectionNodeGeometry>) {
  const gesture = useConnectionGesture(client, camera, nodes);
  return { ...gesture, begin: (event: PointerEvent<SVGGElement>, point: ConnectionJunction, title: boolean) =>
    gesture.begin(event, { ...point, width: 0, height: 0, kind: 'junction' }, title) };
}
