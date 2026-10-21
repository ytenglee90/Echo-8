import assert from 'node:assert/strict';
import { openAsBlob } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import { parseProject } from '../src/plugins/import-export/codec.ts';

const NODE_COUNT = 2_000;
const ORDINARY_LENGTH = 100_000;
const HUGE_LENGTH = 20_000_000;
const CONNECTION_COUNT = 8_000;
const GROUP_COUNT = 200;
const CHUNK_COUNT = 4_304;
const TOTAL_CHARACTERS = 219_900_000;
const projectPath = resolve('artifacts', 'Echo-8-Brutal-2000.echo8');

const blob = await openAsBlob(projectPath, { type: 'application/x-echo-8-canvas+ndjson' });
let reportedBucket = -1;
const started = performance.now();
const parsed = await parseProject(blob, undefined, (progress) => {
  const bucket = Math.floor(progress * 10);
  if (bucket > reportedBucket && bucket < 10) {
    reportedBucket = bucket;
    process.stdout.write(`正式解析 ${bucket * 10}%\n`);
  }
});
const parseMs = performance.now() - started;

assert.equal(parsed.manifest.kind, 'echo-8-project');
assert.equal(parsed.manifest.formatVersion, 1);
assert.deepEqual(parsed.history, { undo: [], redo: [] });

const namespaces = parsed.document.namespaces;
const nodes = Object.values(namespaces.textNode ?? {});
const contents = Object.values(namespaces.textContent ?? {});
const chunks = Object.values(namespaces.textContentChunk ?? {});
const formats = Object.values(namespaces.textFormat ?? {});
const connections = Object.values(namespaces.connections ?? {});
const groups = Object.values(namespaces.groups ?? {});

assert.equal(nodes.length, NODE_COUNT);
assert.equal(contents.length, NODE_COUNT);
assert.equal(chunks.length, CHUNK_COUNT);
assert.equal(formats.length, NODE_COUNT);
assert.equal(connections.length, CONNECTION_COUNT);
assert.equal(groups.length, GROUP_COUNT);
assert.equal(Object.keys(namespaces.textFormatMark ?? {}).length, 0);

const nodeIds = new Set(nodes.map((node) => node.id));
const contentById = new Map(contents.map((content) => [content.id, content]));
const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
let ordinaryDocuments = 0;
let hugeDocuments = 0;
let totalCharacters = 0;

for (const node of nodes) {
  const content = contentById.get(node.contentId);
  assert.ok(content, `正文目录缺失：${node.id}`);
  assert.equal(content.storageVersion, 2);
  assert.equal(content.chunkIds.length, content.chunkLengths.length);
  assert.equal(content.chunkLengths.reduce((sum, length) => sum + length, 0), content.length);
  totalCharacters += content.length;
  if (content.length === ORDINARY_LENGTH) ordinaryDocuments += 1;
  else if (content.length === HUGE_LENGTH) hugeDocuments += 1;
  else assert.fail(`正文长度异常：${node.id}=${content.length}`);
  for (let index = 0; index < content.chunkIds.length; index += 1) {
    const chunk = chunksById.get(content.chunkIds[index]);
    assert.ok(chunk, `正文块缺失：${content.chunkIds[index]}`);
    assert.equal(chunk.contentId, content.id);
    assert.equal(chunk.text.length, content.chunkLengths[index]);
  }
}

assert.equal(ordinaryDocuments, NODE_COUNT - 1);
assert.equal(hugeDocuments, 1);
assert.equal(totalCharacters, TOTAL_CHARACTERS);

for (const connection of connections) {
  assert.ok(nodeIds.has(connection.from.nodeId), `连线起点不存在：${connection.id}`);
  assert.ok(nodeIds.has(connection.to.nodeId), `连线终点不存在：${connection.id}`);
  assert.equal(connection.from.side, 'right');
  assert.equal(connection.to.side, 'left');
}

const grouped = new Set();
for (const group of groups) {
  assert.equal(group.memberIds.length, 10);
  for (const memberId of group.memberIds) {
    assert.ok(nodeIds.has(memberId), `群组成员不存在：${memberId}`);
    assert.equal(grouped.has(memberId), false, `节点重复加入群组：${memberId}`);
    grouped.add(memberId);
  }
}
assert.equal(grouped.size, NODE_COUNT);

const memory = process.memoryUsage();
process.stdout.write(`${JSON.stringify({
  valid: true,
  path: projectPath,
  fileBytes: blob.size,
  parseMs: Math.round(parseMs),
  nodes: nodes.length,
  totalCharacters,
  ordinaryDocuments,
  hugeDocuments,
  contentChunks: chunks.length,
  connections: connections.length,
  groups: groups.length,
  groupedNodes: grouped.size,
  rssMiB: Math.round(memory.rss / 1024 / 1024),
  heapUsedMiB: Math.round(memory.heapUsed / 1024 / 1024),
}, null, 2)}\n`);
