import { isRecord } from '../../core/contracts.ts';
import {
  PROJECT_FORMAT_VERSION,
  PROJECT_KIND,
  PROJECT_MEDIA_TYPE,
  type ProjectFooterV1,
  type ProjectManifest,
  type ProjectHistorySnapshot,
  type ProjectOpenPayload,
  type ProjectPluginDescriptor,
  type ProjectSource,
  type FileWritableTarget,
} from '../../protocols/files.ts';

const FRAGMENT_SIZE = 64 * 1024;
const MAX_LINE_SIZE = 1024 * 1024;
const DEFAULT_PARSE_LIMITS: ProjectParseLimits = {
  maxCompressedBytes: 256 * 1024 * 1024,
  maxDecompressedBytes: 256 * 1024 * 1024,
  maxLogicalEntryBytes: 64 * 1024 * 1024,
  maxFragmentsPerEntry: 1024,
  maxEntries: 250_000,
};

export interface ProjectParseLimits {
  maxCompressedBytes: number;
  maxDecompressedBytes: number;
  maxLogicalEntryBytes: number;
  maxFragmentsPerEntry: number;
  maxEntries: number;
}

interface WireEntry {
  type: 'entry';
  section: 'document' | 'history';
  namespace?: string;
  key: string;
  value: unknown;
}

interface WireStart {
  type: 'start';
  section: WireEntry['section'];
  namespace?: string;
  key: string;
  fragments: number;
}

interface WireFragment {
  type: 'fragment';
  index: number;
  data: string;
}

export async function serializeProject(
  source: ProjectSource,
  signal?: AbortSignal,
  report: (progress: number) => void = () => undefined,
): Promise<Blob> {
  const compact = compactProjectStream(projectByteStream(source, signal, report));
  const blob = await new Response(compact).blob();
  return new Blob([blob], { type: PROJECT_MEDIA_TYPE });
}

export async function writeProjectToWritable(
  source: ProjectSource,
  writable: FileWritableTarget,
  signal?: AbortSignal,
  report: (progress: number) => void = () => undefined,
): Promise<number> {
  let bytes = 0;
  const reader = compactProjectStream(projectByteStream(source, signal, report)).getReader();
  try {
    while (true) {
      assertNotAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const copy = new Uint8Array(value.byteLength);
      copy.set(value);
      const part = new Blob([copy.buffer], { type: PROJECT_MEDIA_TYPE });
      await writable.write(part);
      bytes += part.size;
    }
  } finally {
    reader.releaseLock();
  }
  return bytes;
}

function projectByteStream(
  source: ProjectSource,
  signal: AbortSignal | undefined,
  report: (progress: number) => void,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = projectLines(source, signal, report);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await iterator.return?.(reason);
    },
  });
}

function compactProjectStream(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  return typeof CompressionStream === 'undefined'
    ? stream
    : stream.pipeThrough(new CompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>);
}

async function* projectLines(
  source: ProjectSource,
  signal: AbortSignal | undefined,
  report: (progress: number) => void,
): AsyncGenerator<string> {
  const checksum = new Crc32();
  const manifest: ProjectManifest = {
    type: 'manifest',
    kind: PROJECT_KIND,
    formatVersion: PROJECT_FORMAT_VERSION,
    coreVersion: '0.1.0',
    savedAt: Date.now(),
    documentRevision: source.document.revision,
    historyMode: 'none',
    plugins: structuredClone(source.plugins),
  };
  yield checkedLine(checksum, manifest);
  const namespaces = Object.entries(source.document.namespaces)
    .sort(([left], [right]) => left.localeCompare(right));
  const totalEntries = namespaces.reduce((total, [, values]) => total + Object.keys(values).length, 0);
  let entryCount = 0;
  const entries = (function* (): Generator<{
    section: WireEntry['section'];
    namespace?: string;
    key: string;
    value: unknown;
  }> {
    for (const [namespace, values] of namespaces) {
      for (const [key, value] of Object.entries(values).sort(([left], [right]) => left.localeCompare(right))) {
        yield { section: 'document', namespace, key, value };
      }
    }
  })();
  for (const entry of entries) {
    assertNotAborted(signal);
    const valueJson = JSON.stringify(entry.value);
    if (valueJson.length <= FRAGMENT_SIZE) {
      yield checkedLine(checksum, { type: 'entry', ...entry } satisfies WireEntry);
    } else {
      const fragments = Math.ceil(valueJson.length / FRAGMENT_SIZE);
      yield checkedLine(checksum, {
        type: 'start',
        section: entry.section,
        namespace: 'namespace' in entry ? entry.namespace : undefined,
        key: entry.key,
        fragments,
      } satisfies WireStart);
      for (let index = 0; index < fragments; index += 1) {
        assertNotAborted(signal);
        yield checkedLine(checksum, {
          type: 'fragment',
          index,
          data: valueJson.slice(index * FRAGMENT_SIZE, (index + 1) * FRAGMENT_SIZE),
        } satisfies WireFragment);
        if (index % 24 === 23) await yieldToMainThread();
      }
    }
    entryCount += 1;
    report(totalEntries === 0 ? 1 : entryCount / totalEntries);
    if (entryCount % 24 === 0) await yieldToMainThread();
  }
  const footer: ProjectFooterV1 = {
    type: 'footer',
    algorithm: 'crc32',
    checksum: checksum.digest(),
    entryCount,
  };
  yield `${JSON.stringify(footer)}\n`;
  report(1);
}

export async function parseProject(
  blob: Blob,
  signal?: AbortSignal,
  report: (progress: number) => void = () => undefined,
  limits: ProjectParseLimits = DEFAULT_PARSE_LIMITS,
): Promise<ProjectOpenPayload> {
  validateParseLimits(limits);
  const stream = await projectReadStream(blob, limits);
  const checksum = new Crc32();
  const namespaces: Record<string, Record<string, unknown>> = {};
  const history: Partial<ProjectHistorySnapshot> = {};
  let manifest: ProjectManifest | undefined;
  let footer: ProjectFooterV1 | undefined;
  let current: { start: WireStart; fragments: string[]; bytes: number } | undefined;
  let entryCount = 0;
  let consumed = 0;

  for await (const line of readLines(stream, signal, limits.maxDecompressedBytes)) {
    assertNotAborted(signal);
    consumed += new TextEncoder().encode(`${line}\n`).byteLength;
    report(blob.size === 0 ? 0 : Math.min(0.99, consumed / blob.size));
    const parsed: unknown = parseLine(line);
    if (isFooter(parsed)) {
      if (footer || current) throw new Error('书籍文件结尾不完整');
      footer = parsed;
      continue;
    }
    if (footer) throw new Error('书籍文件校验信息之后存在多余数据');
    checksum.update(`${line}\n`);
    if (!manifest) {
      const normalized = normalizeManifest(parsed);
      if (!normalized) throw new Error('不是可识别的 Echo-8 书籍文件');
      manifest = normalized;
      continue;
    }
    if (isWireEntry(parsed)) {
      if (current) throw new Error('书籍文件分块记录没有结束');
      assignEntry(namespaces, history, parsed.section, parsed.namespace, parsed.key, parsed.value);
      entryCount += 1;
    } else if (isWireStart(parsed)) {
      if (current) throw new Error('书籍文件包含重叠分块');
      if (parsed.fragments < 1 || parsed.fragments > limits.maxFragmentsPerEntry) {
        throw new Error('书籍文件分块数量异常');
      }
      current = { start: parsed, fragments: [], bytes: 0 };
    } else if (isWireFragment(parsed)) {
      if (!current || parsed.index !== current.fragments.length || parsed.index >= current.start.fragments) {
        throw new Error('书籍文件分块顺序错误');
      }
      if (parsed.data.length > FRAGMENT_SIZE) throw new Error('书籍文件分块内容过大');
      current.bytes += new TextEncoder().encode(parsed.data).byteLength;
      if (current.bytes > limits.maxLogicalEntryBytes) throw new Error('书籍文件单条逻辑记录超出安全上限');
      current.fragments.push(parsed.data);
      if (current.fragments.length === current.start.fragments) {
        const value = JSON.parse(current.fragments.join('')) as unknown;
        assignEntry(
          namespaces,
          history,
          current.start.section,
          current.start.namespace,
          current.start.key,
          value,
        );
        current = undefined;
        entryCount += 1;
      }
    } else {
      throw new Error('书籍文件包含未知记录');
    }
    if (entryCount > limits.maxEntries) throw new Error('书籍文件记录数量超出安全上限');
  }

  if (!manifest || !footer || current) throw new Error('书籍文件不完整');
  if (footer.algorithm !== 'crc32' || footer.checksum !== checksum.digest()) {
    throw new Error('书籍文件校验失败，内容可能损坏或写入中断');
  }
  if (footer.entryCount !== entryCount) throw new Error('书籍文件记录数量校验失败');
  if (manifest.formatVersion === 1 && (!Array.isArray(history.undo) || !Array.isArray(history.redo))) {
    throw new Error('旧版书籍文件缺少撤销历史');
  }
  if (manifest.formatVersion === PROJECT_FORMAT_VERSION && (history.undo || history.redo)) {
    throw new Error('紧凑书籍文件不能包含撤销历史');
  }
  report(1);
  return {
    manifest,
    document: { revision: manifest.documentRevision, namespaces },
    history: manifest.formatVersion === 1 ? history as ProjectHistorySnapshot : { undo: [], redo: [] },
  };
}

async function projectReadStream(
  blob: Blob,
  limits: ProjectParseLimits,
): Promise<ReadableStream<Uint8Array>> {
  if (blob.size > limits.maxCompressedBytes) throw new Error('书籍文件体积超出安全上限');
  const prefix = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  const gzip = prefix.length === 2 && prefix[0] === 0x1f && prefix[1] === 0x8b;
  if (!gzip) return blob.stream();
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前浏览器不支持读取压缩的 Echo-8 书籍文件');
  }
  return blob.stream().pipeThrough(new DecompressionStream('gzip'));
}

function checkedLine(checksum: Crc32, value: unknown): string {
  const line = `${JSON.stringify(value)}\n`;
  checksum.update(line);
  return line;
}

async function* readLines(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  maxBytes: number,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let decodedBytes = 0;
  let completed = false;
  try {
    while (true) {
      assertNotAborted(signal);
      const { done, value } = await reader.read();
      if (done) {
        completed = true;
        break;
      }
      decodedBytes += value?.byteLength ?? 0;
      if (decodedBytes > maxBytes) throw new Error('书籍文件解压后体积超出安全上限');
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.length > MAX_LINE_SIZE) throw new Error('书籍文件单条记录过大');
        if (line) yield line;
        newline = buffer.indexOf('\n');
      }
      if (buffer.length > MAX_LINE_SIZE) throw new Error('书籍文件单条记录过大');
    }
    buffer += decoder.decode();
    if (buffer) yield buffer;
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function validateParseLimits(limits: ProjectParseLimits): void {
  const values = Object.values(limits);
  if (!values.every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('书籍文件解析安全限制不正确');
  }
}

function assignEntry(
  namespaces: Record<string, Record<string, unknown>>,
  history: Partial<ProjectHistorySnapshot>,
  section: WireEntry['section'],
  namespace: string | undefined,
  key: string,
  value: unknown,
): void {
  if (section === 'history') {
    if (key !== 'undo' && key !== 'redo') throw new Error(`未知历史区域：${key}`);
    if (history[key]) throw new Error(`重复历史区域：${key}`);
    if (!Array.isArray(value)) throw new Error(`历史区域格式错误：${key}`);
    history[key] = value;
    return;
  }
  if (!namespace || !key) throw new Error('画布记录缺少命名空间或键');
  namespaces[namespace] ??= {};
  if (Object.prototype.hasOwnProperty.call(namespaces[namespace], key)) {
    throw new Error(`画布记录重复：${namespace}.${key}`);
  }
  namespaces[namespace][key] = value;
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    throw new Error('书籍文件包含无法解析的数据');
  }
}

function normalizeManifest(value: unknown): ProjectManifest | undefined {
  if (!(isRecord(value) &&
    value.type === 'manifest' &&
    value.kind === PROJECT_KIND &&
    value.coreVersion === '0.1.0' &&
    Number.isFinite(value.savedAt) &&
    Number.isInteger(value.documentRevision) &&
    Array.isArray(value.plugins) &&
    value.plugins.every(isPluginDescriptor))) return undefined;
  if (value.formatVersion === 1) {
    return {
      type: 'manifest',
      kind: PROJECT_KIND,
      formatVersion: 1,
      coreVersion: '0.1.0',
      savedAt: value.savedAt as number,
      documentRevision: value.documentRevision as number,
      plugins: structuredClone(value.plugins as ProjectPluginDescriptor[]),
    };
  }
  if (value.formatVersion !== PROJECT_FORMAT_VERSION || value.historyMode !== 'none') return undefined;
  return {
    type: 'manifest',
    kind: PROJECT_KIND,
    formatVersion: PROJECT_FORMAT_VERSION,
    coreVersion: '0.1.0',
    savedAt: value.savedAt as number,
    documentRevision: value.documentRevision as number,
    historyMode: 'none',
    plugins: structuredClone(value.plugins as ProjectPluginDescriptor[]),
  };
}

function isPluginDescriptor(value: unknown): value is ProjectPluginDescriptor {
  return isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.version === 'string' &&
    (value.dataVersion === undefined || (Number.isInteger(value.dataVersion) && (value.dataVersion as number) >= 1)) &&
    typeof value.available === 'boolean' &&
    Array.isArray(value.namespaces) &&
    value.namespaces.every((namespace) => typeof namespace === 'string');
}

function isFooter(value: unknown): value is ProjectFooterV1 {
  return isRecord(value) && value.type === 'footer' && value.algorithm === 'crc32' &&
    typeof value.checksum === 'string' && Number.isInteger(value.entryCount);
}

function isWireEntry(value: unknown): value is WireEntry {
  return isRecord(value) && value.type === 'entry' && isSection(value.section) &&
    typeof value.key === 'string' && (value.namespace === undefined || typeof value.namespace === 'string') &&
    Object.prototype.hasOwnProperty.call(value, 'value');
}

function isWireStart(value: unknown): value is WireStart {
  return isRecord(value) && value.type === 'start' && isSection(value.section) &&
    typeof value.key === 'string' && (value.namespace === undefined || typeof value.namespace === 'string') &&
    Number.isInteger(value.fragments);
}

function isWireFragment(value: unknown): value is WireFragment {
  return isRecord(value) && value.type === 'fragment' && Number.isInteger(value.index) && typeof value.data === 'string';
}

function isSection(value: unknown): value is WireEntry['section'] {
  return value === 'document' || value === 'history';
}

class Crc32 {
  private value = 0xffffffff;
  private readonly encoder = new TextEncoder();

  update(text: string): void {
    for (const byte of this.encoder.encode(text)) {
      this.value = CRC_TABLE[(this.value ^ byte) & 0xff] ^ (this.value >>> 8);
    }
  }

  digest(): string {
    return ((this.value ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
  }
}

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  CRC_TABLE[index] = value >>> 0;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Task cancelled', 'AbortError');
}

function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
