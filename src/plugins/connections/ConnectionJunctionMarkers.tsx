'use client';

import type { ViewClient } from '../../core/contracts.ts';
import type { CameraState } from '../../protocols/canvas.ts';
import type { ConnectionJunction } from '../../protocols/connections.ts';
import { canvasDetailWorldScale } from '../../ui/canvas-screen-scale.ts';
import { useJunctionDrag } from './use-junction-drag.ts';

export function ConnectionJunctionMarkers({ client, camera, junctions, selected }: {
  client: ViewClient;
  camera: CameraState;
  junctions: ConnectionJunction[];
  selected: ReadonlySet<string>;
}) {
  const drag = useJunctionDrag(client, camera);
  const scale = canvasDetailWorldScale(camera.zoom);
  return <g className="connection-junction-layer">
    {junctions.map((point, index) => <g
      key={point.id}
      className={`connection-junction ${selected.has(point.id) ? 'selected' : ''}`}
      transform={`translate(${point.x} ${point.y})`}
      data-junction-id={point.id}
      role="button"
      tabIndex={0}
      aria-label={`连接中转点 ${index + 1}`}
      aria-pressed={selected.has(point.id)}
      onPointerDown={(event) => drag.begin(event, point)}
      onPointerMove={drag.move}
      onPointerUp={(event) => drag.finish(event)}
      onPointerCancel={(event) => drag.finish(event, true)}
      onLostPointerCapture={(event) => drag.finish(event, true)}
      onPointerEnter={() => client.emit('canvas.entity.hover.preview', { id: point.id })}
      onPointerLeave={() => client.emit('canvas.entity.hover.preview', { id: point.id, clear: true })}
      onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onKeyDown={(event) => {
        const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
        if (!direction) return;
        event.preventDefault();
        event.stopPropagation();
        const step = event.shiftKey ? 10 : 1;
        void client.dispatch('connection.nudgeJunction', {
          id: point.id, dx: direction[0] * step, dy: direction[1] * step,
        });
      }}
    >
      <title>拖动移动中转点；Delete 删除中转点并恢复节点连接</title>
      <circle className="connection-junction-hit" r={12 / camera.zoom} />
      <circle className="connection-junction-ring" r={9 * scale} strokeWidth={2 * scale} />
      <circle className="connection-junction-dot" r={5 * scale} strokeWidth={1.5 * scale} />
    </g>)}
  </g>;
}
