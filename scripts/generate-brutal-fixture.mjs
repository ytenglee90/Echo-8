import { createWriteStream } from 'node:fs';
import { access, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const NODE_COUNT = 2_000;
const ORDINARY_LENGTH = 100_000;
const HUGE_LENGTH = 20_000_000;
const HUGE_NODE_INDEX = 0;
const CHUNK_SIZE = 64 * 1024;
const FRAGMENT_SIZE = 64 * 1024;
const GROUP_SIZE = 10;
const CONNECTION_STEPS = [1, 7, 37, 997];
const BASE_TIME = 1_760_000_000_000;
const BODY_PATTERN = '暴力测试 stress payload 0123456789 abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ\n';
const TITLE_COLORS = ['#202124', '#374151', '#3f3f46', '#1f2937', '#334155', '#44403c'];

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  CRC_TABLE[index] = value >>> 0;
}

class Crc32 {
  #value = 0xffffffff;

  update(text) {
    for (const byte of Buffer.from(text, 'utf8')) {
      this.#value = CRC_TABLE[(this.#value ^ byte) & 0xff] ^ (this.#value >>> 8);
    }
  }

  digest() {
    return ((this.#value ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
  }
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = resolve(projectRoot, 'artifacts', 'Echo-8-Brutal-2000.echo8');
const partialPath = `${outputPath}.partial`;

await assertAbsent(outputPath);
await rm(partialPath, { force: true });

const output = createWriteStream(partialPath, { encoding: 'utf8', flags: 'wx' });
const checksum = new Crc32();
let entryCount = 0;
let physicalLineCount = 0;

try {
  await writeChecked({
    type: 'manifest',
    kind: 'echo-8-project',
    formatVersion: 1,
    coreVersion: '0.1.0',
    savedAt: BASE_TIME,
    documentRevision: 1,
    plugins: [
      {
        id: 'text-node',
        version: '0.1.0',
        namespaces: ['textNode', 'textContent', 'textContentChunk', 'textFormat', 'textFormatMark'],
        available: true,
      },
      { id: 'connections', version: '0.1.0', namespaces: ['connections'], available: true },
      { id: 'groups', version: '0.1.0', namespaces: ['groups'], available: true },
    ],
  });

  await writeConnections();
  await writeGroups();
  await writeTextContentCatalog();
  await writeTextChunks();
  await writeTextFormats();
  await writeTextNodes();
  await writeLogicalEntry('history', undefined, 'undo', []);
  await writeLogicalEntry('history', undefined, 'redo', []);

  await writeRaw(`${JSON.stringify({
    type: 'footer',
    algorithm: 'crc32',
    checksum: checksum.digest(),
    entryCount,
  })}\n`);
  output.end();
  await once(output, 'finish');
  await rename(partialPath, outputPath);
} catch (error) {
  output.destroy();
  await rm(partialPath, { force: true });
  throw error;
}

const result = await stat(outputPath);
process.stdout.write(`${JSON.stringify({
  output: outputPath,
  bytes: result.size,
  nodes: NODE_COUNT,
  ordinaryNodeCharacters: ORDINARY_LENGTH,
  hugeNodeCharacters: HUGE_LENGTH,
  totalCharacters: (NODE_COUNT - 1) * ORDINARY_LENGTH + HUGE_LENGTH,
  connections: NODE_COUNT * CONNECTION_STEPS.length,
  groups: NODE_COUNT / GROUP_SIZE,
  contentChunks: (NODE_COUNT - 1) * Math.ceil(ORDINARY_LENGTH / CHUNK_SIZE) + Math.ceil(HUGE_LENGTH / CHUNK_SIZE),
  logicalEntries: entryCount,
  physicalLines: physicalLineCount,
  checksum: checksum.digest(),
}, null, 2)}\n`);

async function writeConnections() {
  let connectionIndex = 0;
  for (const step of CONNECTION_STEPS) {
    for (let fromIndex = 0; fromIndex < NODE_COUNT; fromIndex += 1) {
      const toIndex = (fromIndex + step) % NODE_COUNT;
      const id = `connection-brutal-${pad(connectionIndex, 5)}`;
      await writeLogicalEntry('document', 'connections', id, {
        id,
        from: { nodeId: nodeId(fromIndex), side: 'right' },
        to: { nodeId: nodeId(toIndex), side: 'left' },
        createdAt: BASE_TIME + connectionIndex,
      });
      connectionIndex += 1;
    }
  }
}

async function writeGroups() {
  const groupCount = NODE_COUNT / GROUP_SIZE;
  for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
    const id = `group-brutal-${pad(groupIndex, 4)}`;
    const firstMember = groupIndex * GROUP_SIZE;
    await writeLogicalEntry('document', 'groups', id, {
      id,
      title: `压力群组 ${pad(groupIndex + 1, 3)}\n节点 ${pad(firstMember, 4)}—${pad(firstMember + GROUP_SIZE - 1, 4)}`,
      memberIds: Array.from({ length: GROUP_SIZE }, (_, offset) => nodeId(firstMember + offset)),
      titleStyle: {
        fontSize: 12 + (groupIndex % 4),
        fontWeight: groupIndex % 3 === 0 ? 750 : 600,
      },
      revision: 1,
      createdAt: BASE_TIME + groupIndex,
      updatedAt: BASE_TIME + groupIndex,
    });
  }
}

async function writeTextContentCatalog() {
  for (let index = 0; index < NODE_COUNT; index += 1) {
    const length = bodyLength(index);
    const chunks = Math.ceil(length / CHUNK_SIZE);
    const chunkIds = Array.from({ length: chunks }, (_, chunkIndex) => contentChunkId(index, chunkIndex));
    const chunkLengths = Array.from({ length: chunks }, (_, chunkIndex) =>
      Math.min(CHUNK_SIZE, length - chunkIndex * CHUNK_SIZE));
    await writeLogicalEntry('document', 'textContent', contentId(index), {
      id: contentId(index),
      storageVersion: 2,
      chunkIds,
      chunkLengths,
      length,
      revision: 1,
    });
  }
}

async function writeTextChunks() {
  for (let index = 0; index < NODE_COUNT; index += 1) {
    const length = bodyLength(index);
    const chunks = Math.ceil(length / CHUNK_SIZE);
    for (let chunkIndex = 0; chunkIndex < chunks; chunkIndex += 1) {
      const start = chunkIndex * CHUNK_SIZE;
      const chunkLength = Math.min(CHUNK_SIZE, length - start);
      const id = contentChunkId(index, chunkIndex);
      await writeLogicalEntry('document', 'textContentChunk', id, {
        id,
        contentId: contentId(index),
        text: bodyRange(index, start, chunkLength),
      });
    }
    if (index % 50 === 0 || index === NODE_COUNT - 1) {
      process.stdout.write(`正文分块 ${index + 1}/${NODE_COUNT}\n`);
    }
  }
}

async function writeTextFormats() {
  for (let index = 0; index < NODE_COUNT; index += 1) {
    await writeLogicalEntry('document', 'textFormat', nodeId(index), {
      nodeId: nodeId(index),
      storageVersion: 2,
      markIds: [],
      revision: 1,
      format: {
        fontSize: 14 + (index % 3),
        fontWeight: index % 11 === 0 ? 500 : 400,
        lineHeight: 1.6 + (index % 3) * 0.1,
        letterSpacing: 0,
        color: '#2f3035',
        firstLineIndent: index % 4 === 0 ? 2 : 0,
        paragraphSpacing: 0.35,
      },
    });
  }
}

async function writeTextNodes() {
  for (let index = 0; index < NODE_COUNT; index += 1) {
    const column = index % 50;
    const row = Math.floor(index / 50);
    const id = nodeId(index);
    await writeLogicalEntry('document', 'textNode', id, {
      id,
      contentId: contentId(index),
      title: index === HUGE_NODE_INDEX
        ? `极限节点 ${pad(index, 4)} · 2000万字符`
        : `压力节点 ${pad(index, 4)} · 10万字符`,
      x: 160 + column * 360,
      y: 130 + row * 230,
      width: 280,
      titleColor: TITLE_COLORS[index % TITLE_COLORS.length],
      private: index % 50 === 49,
      revision: 1,
      createdAt: BASE_TIME + index,
      updatedAt: BASE_TIME + index,
    });
  }
}

async function writeLogicalEntry(section, namespace, key, value) {
  const valueJson = JSON.stringify(value);
  if (valueJson.length <= FRAGMENT_SIZE) {
    await writeChecked({ type: 'entry', section, ...(namespace ? { namespace } : {}), key, value });
  } else {
    const fragments = Math.ceil(valueJson.length / FRAGMENT_SIZE);
    await writeChecked({ type: 'start', section, ...(namespace ? { namespace } : {}), key, fragments });
    for (let index = 0; index < fragments; index += 1) {
      await writeChecked({
        type: 'fragment',
        index,
        data: valueJson.slice(index * FRAGMENT_SIZE, (index + 1) * FRAGMENT_SIZE),
      });
    }
  }
  entryCount += 1;
}

async function writeChecked(value) {
  const line = `${JSON.stringify(value)}\n`;
  checksum.update(line);
  await writeRaw(line);
}

async function writeRaw(text) {
  physicalLineCount += 1;
  if (!output.write(text)) await once(output, 'drain');
}

function bodyRange(index, start, length) {
  const prefix = `【${index === HUGE_NODE_INDEX ? '极限' : '普通'}压力节点 ${pad(index, 4)}】\n`;
  let cursor = start;
  let remaining = length;
  let result = '';
  if (cursor < prefix.length) {
    const prefixPart = prefix.slice(cursor, Math.min(prefix.length, cursor + remaining));
    result += prefixPart;
    cursor += prefixPart.length;
    remaining -= prefixPart.length;
  }
  if (remaining > 0) {
    const patternStart = Math.max(0, cursor - prefix.length);
    const offset = patternStart % BODY_PATTERN.length;
    const needed = offset + remaining;
    result += BODY_PATTERN.repeat(Math.ceil(needed / BODY_PATTERN.length)).slice(offset, offset + remaining);
  }
  if (result.length !== length) throw new Error(`正文分块长度错误：${index}/${start}`);
  return result;
}

function bodyLength(index) {
  return index === HUGE_NODE_INDEX ? HUGE_LENGTH : ORDINARY_LENGTH;
}

function nodeId(index) {
  return `node-brutal-${pad(index, 4)}`;
}

function contentId(index) {
  return `content-brutal-${pad(index, 4)}`;
}

function contentChunkId(index, chunkIndex) {
  return `content-chunk-brutal-${pad(index, 4)}-${pad(chunkIndex, 4)}`;
}

function pad(value, width) {
  return String(value).padStart(width, '0');
}

async function assertAbsent(path) {
  try {
    await access(path);
    throw new Error(`拒绝覆盖已经存在的压力文件：${path}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
