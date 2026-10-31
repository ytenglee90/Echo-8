import type { ProjectPluginDescriptor, ProjectSource } from '../../src/protocols/files.ts';
import { createConnectionsPlugin } from '../../src/plugins/connections/model.ts';
import { serializeProject } from '../../src/plugins/import-export/codec.ts';
import { createContentStorage } from '../../src/plugins/text-node/content-storage.ts';
import { createTextNodePlugin } from '../../src/plugins/text-node/plugin.ts';

export interface CanvasSpecNode {
  id: string;
  title: string;
  body: string;
  x: number;
  y: number;
  color: string;
  width: number;
  height: number;
  presentation: 'card' | 'text-box';
}

export interface CanvasSpecConnection {
  id: string;
  from: string;
  to: string;
  label: string;
  color: string;
}

export function buildCanvasProject(input: {
  nodes: CanvasSpecNode[];
  connections: CanvasSpecConnection[];
  now?: number;
}): ProjectSource {
  const now = input.now ?? Date.now();
  const namespaces: Record<string, Record<string, unknown>> = {
    connections: {},
    textContent: {},
    textContentChunk: {},
    textNode: {},
  };
  for (const node of input.nodes) {
    const contentId = `${node.id}-content`;
    const storage = createContentStorage(contentId, node.body, 1);
    namespaces.textNode[node.id] = {
      id: node.id,
      contentId,
      title: node.title,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      presentation: node.presentation,
      cardSize: { width: node.width, height: node.height },
      textBoxSize: { width: 240, height: 64 },
      titleColor: node.color,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    namespaces.textContent[contentId] = storage.content;
    for (const patch of storage.chunkPatches) {
      if (patch.op === 'set') namespaces.textContentChunk[patch.key] = patch.value;
    }
  }
  for (const connection of input.connections) {
    namespaces.connections[connection.id] = {
      id: connection.id,
      from: { nodeId: connection.from, side: 'right' },
      to: { nodeId: connection.to, side: 'left' },
      label: connection.label,
      labelWidth: 180,
      labelHeight: 48,
      lineColor: connection.color,
      revision: 1,
      createdAt: now,
    };
  }
  return {
    document: { revision: 1, namespaces },
    history: { undo: [], redo: [] },
    plugins: [
      projectDescriptor(createConnectionsPlugin().manifest),
      projectDescriptor(createTextNodePlugin().manifest),
    ],
  };
}

export function serializeCanvasProject(input: {
  nodes: CanvasSpecNode[];
  connections: CanvasSpecConnection[];
  now?: number;
}): Promise<Blob> {
  return serializeProject(buildCanvasProject(input));
}

function projectDescriptor(manifest: {
  id: string;
  version: string;
  dataVersion: number;
  namespaces: string[];
  namespaceDomains: Partial<Record<string, 'document' | 'workspace'>>;
}): ProjectPluginDescriptor {
  return {
    id: manifest.id,
    version: manifest.version,
    dataVersion: manifest.dataVersion,
    namespaces: manifest.namespaces.filter(
      (namespace) => (manifest.namespaceDomains[namespace] ?? 'document') === 'document',
    ),
    available: true,
  };
}
