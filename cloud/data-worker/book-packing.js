import { BLOCK_BYTES, MAX_BOOK_BYTES, MAX_BOOK_BLOCKS, encodeBlock, decodeBlock, entryKey } from './book-block.js';

export const PACKED_RECORD_BYTES = 1024;
export const PACKED_BUCKETS = 32;
const PACK_BYTES = 16 * 1024;
const BUCKET_PACKED_BYTES = 256 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function packedBucket(id) {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return (hash >>> 0) % PACKED_BUCKETS;
}

async function separateEntry(namespace, key, bytes, blocks) {
  const segments = [];
  for (let offset = 0; offset < bytes.length;) {
    let end = Math.min(bytes.length, offset + BLOCK_BYTES);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    const block = await encodeBlock(bytes.slice(offset, end));
    blocks.set(block.hash, block); segments.push(block.hash); offset = end;
  }
  return { namespace, key, bytes: bytes.length, segments };
}

/** Packs only bounded small values. Cached plans retain byte ranges, never record bodies. */
export async function planPackedBook(source, previous, patches, getBlock) {
  const entries = previous ? new Map(previous.entries) : new Map();
  const blocks = new Map();
  const changed = new Set();
  const migrating = previous && previous.root.formatVersion !== 3;
  let lastHash, lastBytes;
  const read = async hash => {
    if (lastHash !== hash) {
      const block = blocks.get(hash) ?? previous?.blocks?.get(hash) ?? await getBlock?.(hash);
      if (!block) throw new Error('小块合并缺少原始分块，原书籍保持可用');
      lastBytes = await decodeBlock(block); lastHash = hash;
    }
    return lastBytes;
  };
  const recordBytes = async entry => {
    if (entry.pendingText !== undefined) return encoder.encode(entry.pendingText);
    if (entry.offset !== undefined) {
      const bytes = await read(entry.segments[0]);
      if (entry.offset + entry.bytes > bytes.length) throw new Error('共享块中的记录范围无效');
      return bytes.slice(entry.offset, entry.offset + entry.bytes);
    }
    const parts = [];
    let size = 0;
    for (const hash of entry.segments) { const bytes = await read(hash); size += bytes.length; parts.push(bytes); }
    if (size !== entry.bytes || size > PACKED_RECORD_BYTES) throw new Error('小记录分块长度无效');
    const bytes = new Uint8Array(size); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    return bytes;
  };
  const prepare = async (namespace, key, value) => {
    const text = JSON.stringify(value);
    if (text === undefined) throw new Error('书籍包含不可保存的记录');
    const bytes = encoder.encode(text);
    if (bytes.length > MAX_BOOK_BYTES) throw new Error('单条书籍记录超过云端限制');
    return bytes.length <= PACKED_RECORD_BYTES
      ? { namespace, key, bytes: bytes.length, segments: [], pendingText: text }
      : separateEntry(namespace, key, bytes, blocks);
  };
  if (previous && patches) {
    const latest = new Map();
    for (const patch of patches) if (patch.domain === 'document') latest.set(entryKey(patch.namespace, patch.key), patch);
    for (const [id, patch] of latest) {
      changed.add(packedBucket(id));
      if (patch.op === 'delete') entries.delete(id);
      else entries.set(id, await prepare(patch.namespace, patch.key, patch.value));
    }
  } else {
    for (const [namespace, records] of Object.entries(source.document.namespaces)) for (const [key, value] of Object.entries(records)) {
      entries.set(entryKey(namespace, key), await prepare(namespace, key, value));
    }
  }
  const buckets = new Map();
  let totalBytes = 0;
  for (const [id, entry] of entries) {
    totalBytes += entry.bytes;
    if (totalBytes > MAX_BOOK_BYTES) throw new Error('书籍超过当前云端大小限制，本地内容已保留');
    const bucket = packedBucket(id);
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push(entry);
    if (!previous || migrating) changed.add(bucket);
  }
  const pages = [], pageBuckets = [], pageSizes = [];
  let manifestBytes = 0;
  const needed = new Set();
  for (const [bucket, values] of buckets) if (changed.has(bucket)) {
    values.sort((a, b) => {
      const left = entryKey(a.namespace, a.key), right = entryKey(b.namespace, b.key);
      return left < right ? -1 : left > right ? 1 : 0;
    });
    let packedSize = 0;
    for (const entry of values) {
      const pack = entry.bytes <= PACKED_RECORD_BYTES && packedSize + entry.bytes <= BUCKET_PACKED_BYTES;
      if (pack) packedSize += entry.bytes;
      if (entry.pendingText === undefined && (pack || entry.offset !== undefined)) for (const hash of entry.segments) {
        if (!previous?.blocks?.has(hash)) needed.add(hash);
      }
    }
  }
  if (needed.size && getBlock?.prefetch) await getBlock.prefetch([...needed]);
  for (let bucket = 0; bucket < PACKED_BUCKETS; bucket++) {
    const values = buckets.get(bucket) ?? [];
    if (!values.length) continue;
    if (!changed.has(bucket)) {
      previous.root.pages.forEach((hash, index) => {
        if (previous.root.pageBuckets[index] === bucket) {
          pages.push(hash); pageBuckets.push(bucket); pageSizes.push(previous.root.pageSizes[index]);
          manifestBytes += previous.root.pageSizes[index];
        }
      });
      continue;
    }
    let packed = [], packSize = 0, packedSize = 0;
    const flushPack = async () => {
      if (!packed.length) return;
      const bytes = new Uint8Array(packSize);
      for (const part of packed) bytes.set(part.bytes, part.offset);
      const block = await encodeBlock(bytes); blocks.set(block.hash, block);
      for (const part of packed) entries.set(entryKey(part.entry.namespace, part.entry.key), {
        namespace: part.entry.namespace, key: part.entry.key, bytes: part.entry.bytes, segments: [block.hash], offset: part.offset,
      });
      packed = []; packSize = 0;
    };
    for (const entry of values) {
      if (entry.bytes <= PACKED_RECORD_BYTES && packedSize + entry.bytes <= BUCKET_PACKED_BYTES) {
        const bytes = await recordBytes(entry);
        JSON.parse(decoder.decode(bytes));
        if (packSize + bytes.length > PACK_BYTES) await flushPack();
        packed.push({ entry, bytes, offset: packSize }); packSize += bytes.length; packedSize += bytes.length;
      } else if (entry.offset !== undefined || entry.pendingText !== undefined) {
        entries.set(entryKey(entry.namespace, entry.key), await separateEntry(entry.namespace, entry.key, await recordBytes(entry), blocks));
      }
    }
    await flushPack();
    let page = [], pageSize = 32;
    const flushPage = async () => {
      if (!page.length) return;
      const bytes = encoder.encode(JSON.stringify({ entries: page }));
      manifestBytes += bytes.length;
      if (manifestBytes > 8 * 1024 * 1024) throw new Error('书籍目录超过云端限制');
      const block = await encodeBlock(bytes); blocks.set(block.hash, block); pages.push(block.hash); pageBuckets.push(bucket); pageSizes.push(bytes.length);
      page = []; pageSize = 32;
    };
    for (const value of values) {
      const entry = entries.get(entryKey(value.namespace, value.key));
      const length = encoder.encode(JSON.stringify(entry)).length + 1;
      if (length > BLOCK_BYTES - 64) throw new Error('书籍记录引用超过云端限制');
      if (page.length && pageSize + length > PACK_BYTES) await flushPage();
      page.push(entry); pageSize += length;
    }
    await flushPage();
  }
  const hashes = new Set(pages);
  for (const entry of entries.values()) for (const hash of entry.segments) hashes.add(hash);
  const root = { formatVersion: 3, documentRevision: source.document.revision, plugins: source.plugins, pages, pageBuckets, pageSizes, totalBytes, records: entries.size };
  if (pages.length > 2000 || manifestBytes > 8 * 1024 * 1024) throw new Error('书籍目录超过云端限制');
  const block = await encodeBlock(encoder.encode(JSON.stringify(root))); blocks.set(block.hash, block); hashes.add(block.hash);
  if (hashes.size > MAX_BOOK_BLOCKS) throw new Error('书籍分块数量超过当前云端限制');
  return { rootHash: block.hash, root, entries, blocks, hashes: [...hashes] };
}
