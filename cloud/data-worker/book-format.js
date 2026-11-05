import { BLOCK_BYTES, MAX_BOOK_BYTES, MAX_BOOK_BLOCKS, encodeBlock, decodeBlock, validHash, entryKey, hashBytes } from './book-block.js';
import { planPackedBook, PACKED_RECORD_BYTES, packedBucket, PACKED_BUCKETS } from './book-packing.js';
export { BLOCK_BYTES, MAX_BOOK_BYTES, MAX_BOOK_BLOCKS, encodeBlock, decodeBlock, validHash, entryKey, hashBytes } from './book-block.js';
export const BOOK_FORMAT = 3;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Older data services retain the existing format-2 writer until upgraded. */
export async function planBook(source, previous, patches, getBlock, formatVersion = BOOK_FORMAT) {
  if (formatVersion === 2) return planClassicBook(source, previous, patches);
  if (formatVersion !== BOOK_FORMAT) throw new Error('不支持的云端书籍格式');
  return planPackedBook(source, previous, patches, getBlock);
}

async function valueEntry(namespace, key, value, blocks) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('书籍包含不可保存的记录');
  const bytes = encoder.encode(serialized);
  if (bytes.length > MAX_BOOK_BYTES) throw new Error('单条书籍记录超过云端限制');
  const segments = [];
  for (let offset = 0; offset < bytes.length;) {
    let end = Math.min(bytes.length, offset + BLOCK_BYTES);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    const block = await encodeBlock(bytes.slice(offset, end));
    blocks.set(block.hash, block);
    segments.push(block.hash);
    offset = end;
  }
  return { namespace, key, bytes: bytes.length, segments };
}

/** Stable buckets confine structural changes; unchanged text is never re-encoded. */
async function planClassicBook(source, previous, patches) {
  const entries = previous ? new Map(previous.entries) : new Map();
  const blocks = new Map();
  if (previous && patches) {
    const latest = new Map();
    for (const patch of patches) if (patch.domain === 'document') latest.set(entryKey(patch.namespace, patch.key), patch);
    for (const [id, patch] of latest) {
      if (patch.op === 'delete') entries.delete(id);
      else entries.set(id, await valueEntry(patch.namespace, patch.key, patch.value, blocks));
    }
  } else {
    for (const [namespace, records] of Object.entries(source.document.namespaces)) {
      for (const [key, value] of Object.entries(records)) entries.set(entryKey(namespace, key), await valueEntry(namespace, key, value, blocks));
    }
  }
  let totalBytes = 0;
  const buckets = new Map();
  const hashes = new Set();
  for (const [id, entry] of entries) {
    totalBytes += entry.bytes;
    if (totalBytes > MAX_BOOK_BYTES) throw new Error('书籍超过当前云端大小限制，本地内容已保留');
    for (const hash of entry.segments) hashes.add(hash);
    // FNV bucket selection needs no async hashing or scans of record bodies.
    let bucket = 2166136261;
    for (let i = 0; i < id.length; i++) bucket = Math.imul(bucket ^ id.charCodeAt(i), 16777619);
    const key = bucket & 255;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(entry);
  }
  const pages = [];
  for (const [, values] of [...buckets].sort((a, b) => a[0] - b[0])) {
    values.sort((a, b) => entryKey(a.namespace, a.key).localeCompare(entryKey(b.namespace, b.key)));
    let page = [];
    let size = 32;
    const flush = async () => {
      if (!page.length) return;
      const block = await encodeBlock(encoder.encode(JSON.stringify({ entries: page })));
      blocks.set(block.hash, block); hashes.add(block.hash); pages.push(block.hash);
      page = []; size = 32;
    };
    for (const value of values) {
      const length = encoder.encode(JSON.stringify(value)).length + 1;
      if (length > BLOCK_BYTES - 64) throw new Error('书籍记录引用超过云端限制');
      if (size + length > BLOCK_BYTES - 32) await flush();
      page.push(value); size += length;
    }
    await flush();
  }
  const root = { formatVersion: 2, documentRevision: source.document.revision, plugins: source.plugins, pages, totalBytes, records: entries.size };
  const rootBlock = await encodeBlock(encoder.encode(JSON.stringify(root)));
  blocks.set(rootBlock.hash, rootBlock); hashes.add(rootBlock.hash);
  if (hashes.size > MAX_BOOK_BLOCKS) throw new Error('书籍分块数量超过当前云端限制');
  return { rootHash: rootBlock.hash, root, entries, blocks, hashes: [...hashes] };
}

/** Every manifest reference must be present, and every supplied reference reachable. */
export async function inspectBook(rootHash, getBlock, expectedHashes, prefetch) {
  const root = JSON.parse(decoder.decode(await decodeBlock(await getBlock(rootHash))));
  if (![2, BOOK_FORMAT].includes(root.formatVersion) || !Array.isArray(root.pages) || !Array.isArray(root.plugins) ||
    !Number.isSafeInteger(root.documentRevision) || root.documentRevision < 0 || root.pages.length > 2_000) throw new Error('书籍清单格式无效');
  if (root.formatVersion === 3 && (!Array.isArray(root.pageBuckets) || root.pageBuckets.length !== root.pages.length ||
    root.pageBuckets.some(bucket => !Number.isSafeInteger(bucket) || bucket < 0 || bucket >= PACKED_BUCKETS) ||
    !Array.isArray(root.pageSizes) || root.pageSizes.length !== root.pages.length)) throw new Error('共享块目录无效');
  const hashes = new Set([rootHash]);
  const entries = new Map();
  let totalBytes = 0;
  let pageBytes = 0, packedBytes = 0, lastPackedHash, lastPackedBytes;
  const packedEntries = [];
  const packedHashes = new Set();
  for (const [pageIndex, hash] of root.pages.entries()) {
    if (!validHash(hash) || hashes.has(hash)) throw new Error('书籍清单含有重复或无效分块');
    hashes.add(hash);
    const bytes = await decodeBlock(await getBlock(hash));
    pageBytes += bytes.length;
    if (pageBytes > 8 * 1024 * 1024 || root.formatVersion === 3 && root.pageSizes[pageIndex] !== bytes.length) throw new Error('书籍目录大小无效');
    const page = JSON.parse(decoder.decode(bytes));
    if (!Array.isArray(page.entries) || page.entries.length > 2_000) throw new Error('书籍目录页无效');
    for (const entry of page.entries) {
      if (typeof entry.namespace !== 'string' || !entry.namespace || entry.namespace.length > 240 ||
        typeof entry.key !== 'string' || !entry.key || entry.key.length > 512 ||
        !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !Array.isArray(entry.segments) || !entry.segments.length ||
        entry.segments.some(hash => !validHash(hash))) throw new Error('书籍记录引用无效');
      const id = entryKey(entry.namespace, entry.key);
      if (root.formatVersion === 3 && packedBucket(id) !== root.pageBuckets[pageIndex]) throw new Error('共享块目录分组无效');
      if (entry.offset !== undefined) {
        if (root.formatVersion !== 3 || !Number.isSafeInteger(entry.offset) || entry.offset < 0 || entry.bytes > PACKED_RECORD_BYTES || entry.segments.length !== 1) throw new Error('共享块记录范围无效');
        packedEntries.push(entry); packedHashes.add(entry.segments[0]);
      }
      if (entries.has(id)) throw new Error('书籍记录重复');
      entries.set(id, entry);
      totalBytes += entry.bytes;
      for (const hash of entry.segments) hashes.add(hash);
    }
  }
  if (packedEntries.length) {
    if (prefetch) await prefetch([...packedHashes]);
    const counted = new Set();
    for (const entry of packedEntries) {
      const hash = entry.segments[0];
      if (lastPackedHash !== hash) {
        lastPackedBytes = await decodeBlock(await getBlock(hash)); lastPackedHash = hash;
        if (!counted.has(hash)) { packedBytes += lastPackedBytes.length; counted.add(hash); }
        if (packedBytes > 8 * 1024 * 1024) throw new Error('共享小记录超过内存限制');
      }
      if (entry.offset + entry.bytes > lastPackedBytes.length) throw new Error('共享块记录越界');
      JSON.parse(decoder.decode(lastPackedBytes.subarray(entry.offset, entry.offset + entry.bytes)));
    }
  }
  if (entries.size !== root.records || totalBytes !== root.totalBytes || totalBytes > MAX_BOOK_BYTES || hashes.size > MAX_BOOK_BLOCKS) throw new Error('书籍清单大小校验失败');
  if (expectedHashes && (hashes.size !== expectedHashes.size || [...hashes].some(hash => !expectedHashes.has(hash)))) throw new Error('上传分块与书籍清单不一致');
  return { rootHash, root, entries, hashes: [...hashes] };
}

export async function restoreBook(plan, getBlock) {
  const namespaces = Object.create(null);
  let lastPackedHash, lastPackedBytes;
  for (const entry of plan.entries.values()) {
    const parts = [];
    let size = 0;
    for (const hash of entry.segments) {
      if (entry.offset !== undefined) {
        if (lastPackedHash !== hash) { lastPackedBytes = await decodeBlock(await getBlock(hash)); lastPackedHash = hash; }
        const end = entry.offset + entry.bytes;
        if (end > lastPackedBytes.length) throw new Error('共享块记录越界');
        const bytes = lastPackedBytes.subarray(entry.offset, end);
        size += bytes.length; parts.push(decoder.decode(bytes)); continue;
      }
      const bytes = await decodeBlock(await getBlock(hash));
      size += bytes.length;
      if (size > entry.bytes) throw new Error('书籍记录长度不一致');
      parts.push(decoder.decode(bytes));
    }
    if (size !== entry.bytes) throw new Error('书籍记录缺少分块');
    if (!Object.hasOwn(namespaces, entry.namespace)) namespaces[entry.namespace] = Object.create(null);
    namespaces[entry.namespace][entry.key] = JSON.parse(parts.join(''));
  }
  return { document: { revision: plan.root.documentRevision, namespaces }, plugins: plan.root.plugins };
}

/** Verify a representation-only migration without loading unchanged large records. */
export async function verifyBookRepack(before, after, getOld, getNew) {
  if (before.root.documentRevision !== after.root.documentRevision || before.entries.size !== after.entries.size ||
    JSON.stringify(before.root.plugins) !== JSON.stringify(after.root.plugins)) throw new Error('小块合并改变了书籍目录');
  const smallReader = get => {
    let lastHash, lastBytes;
    return async entry => {
      const parts = []; let size = 0;
      for (const hash of entry.segments) {
        if (lastHash !== hash) { lastBytes = await decodeBlock(await get(hash)); lastHash = hash; }
        const bytes = entry.offset === undefined ? lastBytes : lastBytes.subarray(entry.offset,entry.offset+entry.bytes);
        size += bytes.length; parts.push(bytes);
      }
      if (size !== entry.bytes || size > PACKED_RECORD_BYTES) throw new Error('小块合并长度不一致');
      const bytes = new Uint8Array(size); let offset=0;
      for(const part of parts){bytes.set(part,offset);offset+=part.length;}return bytes;
    };
  };
  const oldBytes=smallReader(getOld),newBytes=smallReader(getNew);
  for(const [id,entry] of before.entries){
    const current=after.entries.get(id);
    if(!current||current.bytes!==entry.bytes)throw new Error('小块合并遗漏或改变了记录');
    if(entry.bytes>PACKED_RECORD_BYTES){
      if(current.offset!==undefined||JSON.stringify(current.segments)!==JSON.stringify(entry.segments))throw new Error('小块合并改变了大记录');
    }else if(await hashBytes(await oldBytes(entry))!==await hashBytes(await newBytes(current)))throw new Error('小块合并内容校验失败');
  }
}
