/** Cloud book format 2. Pure codec shared by the browser, migration and data Worker. */
export const BOOK_FORMAT = 2;
export const BLOCK_BYTES = 64 * 1024;
export const MAX_BOOK_BYTES = 256 * 1024 * 1024;
export const MAX_BOOK_BLOCKS = 20_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
export const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export async function hashBytes(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
}

export async function encodeBlock(bytes) {
  if (bytes.length > BLOCK_BYTES) throw new Error('书籍分块超过大小限制');
  const hash = await hashBytes(bytes);
  const text = decoder.decode(bytes);
  if (bytes.length >= 512) {
    const compressed = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    if (compressed.length * 4 / 3 < bytes.length * .9) {
      let binary = '';
      for (const value of compressed) binary += String.fromCharCode(value);
      return { hash, encoding: 'gzip-base64', data: btoa(binary), rawBytes: bytes.length };
    }
  }
  return { hash, encoding: 'utf8', data: text, rawBytes: bytes.length };
}

export async function decodeBlock(block) {
  if (!block || !validHash(block.hash) || !Number.isSafeInteger(block.rawBytes) || block.rawBytes < 0 || block.rawBytes > BLOCK_BYTES ||
    typeof block.data !== 'string' || block.data.length > BLOCK_BYTES * 2) throw new Error('书籍分块格式无效');
  let bytes;
  if (block.encoding === 'utf8') bytes = encoder.encode(block.data);
  else if (block.encoding === 'gzip-base64') {
    const compressed = Uint8Array.from(atob(block.data), value => value.charCodeAt(0));
    const reader = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
    const parts = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > BLOCK_BYTES || size > block.rawBytes) throw new Error('书籍分块解压后超过大小限制');
        parts.push(next.value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  } else throw new Error('不支持的书籍分块编码');
  if (bytes.length !== block.rawBytes || await hashBytes(bytes) !== block.hash) throw new Error('书籍分块校验失败');
  return bytes;
}

export function entryKey(namespace, key) { return JSON.stringify([namespace, key]); }

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
export async function planBook(source, previous, patches) {
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
  const root = { formatVersion: BOOK_FORMAT, documentRevision: source.document.revision, plugins: source.plugins, pages, totalBytes, records: entries.size };
  const rootBlock = await encodeBlock(encoder.encode(JSON.stringify(root)));
  blocks.set(rootBlock.hash, rootBlock); hashes.add(rootBlock.hash);
  if (hashes.size > MAX_BOOK_BLOCKS) throw new Error('书籍分块数量超过当前云端限制');
  return { rootHash: rootBlock.hash, root, entries, blocks, hashes: [...hashes] };
}

/** Every manifest reference must be present, and every supplied reference reachable. */
export async function inspectBook(rootHash, getBlock, expectedHashes) {
  const root = JSON.parse(decoder.decode(await decodeBlock(await getBlock(rootHash))));
  if (root.formatVersion !== BOOK_FORMAT || !Array.isArray(root.pages) || !Array.isArray(root.plugins) ||
    !Number.isSafeInteger(root.documentRevision) || root.documentRevision < 0 || root.pages.length > 2_000) throw new Error('书籍清单格式无效');
  const hashes = new Set([rootHash]);
  const entries = new Map();
  let totalBytes = 0;
  for (const hash of root.pages) {
    if (!validHash(hash) || hashes.has(hash)) throw new Error('书籍清单含有重复或无效分块');
    hashes.add(hash);
    const page = JSON.parse(decoder.decode(await decodeBlock(await getBlock(hash))));
    if (!Array.isArray(page.entries) || page.entries.length > 2_000) throw new Error('书籍目录页无效');
    for (const entry of page.entries) {
      if (typeof entry.namespace !== 'string' || !entry.namespace || entry.namespace.length > 240 ||
        typeof entry.key !== 'string' || !entry.key || entry.key.length > 512 ||
        !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !Array.isArray(entry.segments) || !entry.segments.length ||
        entry.segments.some(hash => !validHash(hash))) throw new Error('书籍记录引用无效');
      const id = entryKey(entry.namespace, entry.key);
      if (entries.has(id)) throw new Error('书籍记录重复');
      entries.set(id, entry);
      totalBytes += entry.bytes;
      for (const hash of entry.segments) hashes.add(hash);
    }
  }
  if (entries.size !== root.records || totalBytes !== root.totalBytes || totalBytes > MAX_BOOK_BYTES || hashes.size > MAX_BOOK_BLOCKS) throw new Error('书籍清单大小校验失败');
  if (expectedHashes && (hashes.size !== expectedHashes.size || [...hashes].some(hash => !expectedHashes.has(hash)))) throw new Error('上传分块与书籍清单不一致');
  return { rootHash, root, entries, hashes: [...hashes] };
}

export async function restoreBook(plan, getBlock) {
  const namespaces = Object.create(null);
  for (const entry of plan.entries.values()) {
    const parts = [];
    let size = 0;
    for (const hash of entry.segments) {
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
