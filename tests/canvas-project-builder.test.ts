import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCanvasProject, serializeCanvasProject } from '../scripts/lib/canvas-project-builder.ts';
import { parseProject } from '../src/plugins/import-export/codec.ts';
import { CHUNK_SIZE } from '../src/plugins/text-node/content-storage.ts';

test('canvas spec builder delegates long text chunking and portable encoding to product codecs', async () => {
  const body = '长'.repeat(CHUNK_SIZE + 17);
  const spec = {
    now: 123,
    nodes: [{
      id: 'node-a', title: '节点 A', body, x: 0, y: 0,
      color: '#202124', width: 360, height: 220, presentation: 'card' as const,
    }],
    connections: [],
  };
  const source = buildCanvasProject(spec);
  const content = source.document.namespaces.textContent['node-a-content'] as {
    chunkIds: string[];
    chunkLengths: number[];
  };
  assert.deepEqual(content.chunkLengths, [CHUNK_SIZE, 17]);
  assert.equal(content.chunkIds.length, 2);

  const encoded = await serializeCanvasProject(spec);
  const parsed = await parseProject(encoded);
  const parsedContent = parsed.document.namespaces.textContent['node-a-content'] as {
    chunkIds: string[];
    chunkLengths: number[];
  };
  assert.deepEqual(parsedContent.chunkLengths, [CHUNK_SIZE, 17]);
  assert.equal(parsedContent.chunkIds.map((id) =>
    (parsed.document.namespaces.textContentChunk[id] as { text: string }).text).join(''), body);
  assert.equal((parsed.document.namespaces.textNode['node-a'] as { title: string }).title, '节点 A');
  assert.deepEqual(parsed.history, { undo: [], redo: [] });
  assert.deepEqual(parsed.manifest.plugins, source.plugins);
});
