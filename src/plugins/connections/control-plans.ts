import { createId, type PluginContext } from '../../core/contracts.ts';
import { DEFAULT_CONNECTION_LABEL_HEIGHT, DEFAULT_CONNECTION_LABEL_WIDTH, isTitleConnection, resolveConnectionEndpoints, type ConnectionRecord } from '../../protocols/connections.ts';
import type { CanvasControlConnectionRequest, CanvasControlPatchPlan } from '../../protocols/canvas-control.ts';
import { validateCanvasControlActions } from '../../services/canvas-control-validation.ts';
import { assertJunctionChanges } from './junctions.ts';

export function registerConnectionControlPlans(context: PluginContext, readConnections: () => Record<string, ConnectionRecord>): void {
  context.capabilities.provide<CanvasControlConnectionRequest, CanvasControlPatchPlan>({
    key: 'canvasControl.connectionsPlan@1',
    invoke: input => {
      validateCanvasControlActions(input?.actions);
      if (input.actions.some(action => action.type !== 'create-connection' && action.type !== 'update-connection') || !Array.isArray(input.expected) || !Array.isArray(input.nodes)) throw new Error('连线操作计划无效');
      const originals = Object.values(readConnections());
      const connections = new Map(originals.map(edge => [edge.id, edge]));
      const nodes = new Map(input.nodes.map(node => [node.id, node]));
      const created: Record<string, string> = Object.create(null) as Record<string, string>;
      const changed: ConnectionRecord[] = [];
      for (const action of input.actions) {
        const current = action.type === 'update-connection' ? connections.get(action.id) : undefined;
        if (action.type === 'update-connection' && (!current || current.revision !== input.expected.find(edge => edge.id === action.id)?.revision)) throw new Error('连线已经变化，请重新生成操作计划');
        const fromId = action.from ?? current?.from.nodeId, toId = action.to ?? current?.to.nodeId;
        const from = fromId && nodes.get(fromId), to = toId && nodes.get(toId);
        if (!from || !to || from.id === to.id || from.kind === 'junction' || to.kind === 'junction') throw new Error('连线端点须为不同的文字对象或群组');
        const dashed = action.line ? action.line === 'dashed' : Boolean(current && isTitleConnection(current));
        const automatic = resolveConnectionEndpoints(from, to);
        const edge: ConnectionRecord = {
          ...(current ?? { labelWidth: DEFAULT_CONNECTION_LABEL_WIDTH, labelHeight: DEFAULT_CONNECTION_LABEL_HEIGHT, createdAt: Date.now() }),
          id: current?.id ?? createId('connection'),
          from: { nodeId: from.id, ...(from.kind ? { kind: from.kind } : {}), side: dashed && !from.kind ? 'title' : automatic.from.side },
          to: { nodeId: to.id, ...(to.kind ? { kind: to.kind } : {}), side: dashed && !to.kind ? 'title' : automatic.to.side },
          titleRoute: dashed,
          revision: (current?.revision ?? 0) + 1,
          ...(action.label !== undefined ? { label: action.label } : {}),
          ...(action.color ? { lineColor: action.color.toLowerCase() } : {}),
        };
        if (action.from !== undefined || action.to !== undefined || !dashed) delete edge.titleOrigin;
        const duplicate = [...connections.values()].some(other => other.id !== edge.id && isTitleConnection(other) === dashed &&
          ((other.from.nodeId === from.id && other.to.nodeId === to.id) || (other.from.nodeId === to.id && other.to.nodeId === from.id)));
        if (duplicate) throw new Error('计划中存在重复连线');
        connections.set(edge.id, edge); changed.push(edge);
        if (action.type === 'create-connection') created[action.ref] = edge.id;
      }
      assertJunctionChanges(originals, changed);
      return {
        created,
        patches: changed.map(edge => ({ op: 'set', domain: 'document', namespace: 'connections', key: edge.id, value: edge, schemaOwner: 'connections' })),
        events: changed.map(edge => ({ type: Object.values(created).includes(edge.id) ? 'connection.created' : 'connection.changed', payload: { id: edge.id } })),
      };
    },
  });
}
