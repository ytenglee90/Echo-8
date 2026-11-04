'use client';

import type { ViewClient } from '../../core/contracts.ts';
import type { CameraState } from '../../protocols/canvas.ts';
import type { ConnectionJunction, ConnectionNodeGeometry } from '../../protocols/connections.ts';
import { canvasDetailWorldScale } from '../../ui/canvas-screen-scale.ts';
import { useJunctionDrag } from './use-junction-drag.ts';
import { useJunctionConnect } from './use-junction-connect.ts';

export function ConnectionJunctionMarkers({ client, camera, junctions, allJunctions, selected, nodes, titleJunctionIds, targetId }: {
  client: ViewClient;
  camera: CameraState;
  junctions: ConnectionJunction[];
  allJunctions: ConnectionJunction[];
  selected: ReadonlySet<string>;
  nodes: ReadonlyMap<string, ConnectionNodeGeometry>;
  titleJunctionIds: ReadonlySet<string>;
  targetId?: string;
}) {
  const drag = useJunctionDrag(client, camera, allJunctions, selected);
  const connect = useJunctionConnect(client, camera, nodes);
  const scale = canvasDetailWorldScale(camera.zoom);
  return <g className="connection-junction-layer" tabIndex={-1}
    onKeyDown={event => {
      if (event.key === 'Escape') { connect.cancel(); drag.cancel(); event.preventDefault(); event.stopPropagation(); return; }
      const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      const id = allJunctions.find(point => selected.has(point.id))?.id;
      if (!direction || !id) return;
      event.preventDefault(); event.stopPropagation();
      const step = event.shiftKey ? 10 : 1;
      void client.dispatch('connection.nudgeJunction', { id, dx: direction[0] * step, dy: direction[1] * step });
    }}
    onPointerMove={drag.move} onPointerUp={event => drag.finish(event)}
    onPointerCancel={event => drag.finish(event, true)} onLostPointerCapture={event => drag.finish(event, true)}>
    {junctions.map((point, index) => <g
      key={point.id}
      className={`connection-junction ${selected.has(point.id) ? 'selected' : ''} ${targetId === point.id ? 'connection-target' : ''}`}
      transform={`translate(${point.x} ${point.y})`}
      data-junction-id={point.id}
      role="button"
      tabIndex={0}
      aria-label={`连接中转点 ${index + 1}`}
      aria-pressed={selected.has(point.id)}
      onPointerDown={(event) => drag.begin(event, point)}
      onPointerEnter={() => client.emit('canvas.entity.hover.preview', { id: point.id })}
      onPointerLeave={() => client.emit('canvas.entity.hover.preview', { id: point.id, clear: true })}
      onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { connect.cancel(); drag.cancel(); event.stopPropagation(); return; }
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
      <title>拖动圆点移动；拖动上方的加号拉出连接线；Delete 删除并恢复节点连接</title>
      <circle className="connection-junction-hit" r={12 / camera.zoom} />
      <rect className="connection-junction-port-bridge" x={-10 / camera.zoom} y={-28 / camera.zoom} width={20 / camera.zoom} height={20 / camera.zoom} />
      <circle className="connection-junction-ring" r={9 * scale} strokeWidth={2 * scale} />
      <circle className="connection-junction-dot" r={5 * scale} strokeWidth={1.5 * scale} />
      <g className="connection-junction-port" role="button" tabIndex={0} aria-label="从中转点拉出连接线"
        transform={`translate(0 ${-22 / camera.zoom})`}
        onPointerDown={(event) => connect.begin(event, point, titleJunctionIds.has(point.id))}
        onPointerMove={connect.move} onPointerUp={(event) => connect.finish(event)}
        onPointerCancel={(event) => connect.finish(event, true)}
        onLostPointerCapture={(event) => connect.finish(event, true)}>
        <circle r={6 / camera.zoom} />
        <path d={`M ${-3 / camera.zoom} 0 H ${3 / camera.zoom} M 0 ${-3 / camera.zoom} V ${3 / camera.zoom}`} />
      </g>
    </g>)}
  </g>;
}
