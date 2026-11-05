/** Bounded UTF-8 content blocks shared by cloud book formats. */
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
