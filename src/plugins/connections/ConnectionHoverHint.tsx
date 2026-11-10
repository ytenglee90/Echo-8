import { useMemo } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import type { CameraState } from '../../protocols/canvas.ts';
import type { ConnectionEndpoint, ConnectionNodeGeometry, ConnectionRecord } from '../../protocols/connections.ts';
import type { ContentSummary } from '../../protocols/content.ts';

const MAX_ROWS = 4;
const MARGIN = 8;

export function ConnectionHoverHint({ client, node, camera, surfaceSize, ids, byId, titleRoutes }: {
  client: ViewClient;
  node: ConnectionNodeGeometry;
  camera: CameraState;
  surfaceSize: { width: number; height: number };
  ids: ReadonlySet<string>;
  byId: ReadonlyMap<string, ConnectionRecord>;
  titleRoutes: ReadonlySet<string>;
}) {
  const rows = useMemo(() => {
    const edges: Array<{ edge: ConnectionRecord; outgoing: boolean; other: ConnectionEndpoint }> = [];
    for (const id of ids) {
      const edge = byId.get(id);
      if (!edge) continue;
      const outgoing = edge.from.nodeId === node.id;
      edges.push({ edge, outgoing, other: outgoing ? edge.to : edge.from });
      if (edges.length === MAX_ROWS) break;
    }
    const nodeIds = edges.filter(({ other }) => !other.kind).map(({ other }) => other.nodeId);
    let summaries: ContentSummary[] = [];
    if (nodeIds.length) {
      try { summaries = client.requestSync<ContentSummary[]>('content.summariesById@1', { nodeIds }); }
      catch { /* A content provider can be stopped while the connection layer is mounted. */ }
    }
    const titles = new Map(summaries.map(({ id, title }) => [id, title]));
    return edges.map(({ edge, outgoing, other }) => {
      const title = titles.get(other.nodeId) ?? (other.kind === 'junction' ? '中转点' : other.kind === 'group' ? '群组' : '节点');
      const lineType = titleRoutes.has(edge.id) ? '虚线' : '实线';
      const direction = outgoing ? '指向' : '来自';
      return { id: edge.id, text: [lineType, edge.label, `${direction}${title}`].filter(Boolean).join(' · ') };
    });
  }, [byId, client, ids, node.id, titleRoutes]);
  const width = Math.min(280, surfaceSize.width - MARGIN * 2);
  const left = node.x * camera.zoom + camera.x;
  const top = node.y * camera.zoom + camera.y;
  const right = left + node.width * camera.zoom;
  const bottom = top + node.height * camera.zoom;
  if (width <= 0 || right < 0 || left > surfaceSize.width || bottom < 0 || top > surfaceSize.height) return null;

  const remaining = ids.size - rows.length;
  const height = 32 + 19 * (rows.length + Number(remaining > 0));
  const x = right + MARGIN + width <= surfaceSize.width - MARGIN ? right + MARGIN
    : left - MARGIN - width >= MARGIN ? left - MARGIN - width
    : left;
  const hasSideSpace = x !== left;
  const y = hasSideSpace ? top : top - height - MARGIN >= MARGIN ? top - height - MARGIN : bottom + MARGIN;

  return <div role="tooltip" className="connection-hover-hint" style={{
    width,
    left: Math.max(MARGIN, Math.min(x, surfaceSize.width - width - MARGIN)),
    top: Math.max(MARGIN, Math.min(y, surfaceSize.height - height - MARGIN)),
  }}>
    <strong>关联连线 · {ids.size} 条</strong>
    {rows.map(row => <span key={row.id}>{row.text}</span>)}
    {remaining > 0 && <span>另有 {remaining} 条</span>}
  </div>;
}
