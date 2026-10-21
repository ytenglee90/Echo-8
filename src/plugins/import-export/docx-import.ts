interface ZipDocumentEntry {
  compression: number;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;

export async function readDocxPlainText(
  file: Blob,
  signal: AbortSignal,
  maximumTextLength: number,
): Promise<string> {
  assertActive(signal);
  const archive = new Uint8Array(await file.arrayBuffer());
  assertActive(signal);
  const entry = findDocumentEntry(archive);
  const maximumXmlBytes = Math.min(136 * 1024 * 1024, maximumTextLength * 4 + 8 * 1024 * 1024);
  if (entry.uncompressedSize > maximumXmlBytes) throw new Error('Word 正文解压后过大，已停止导入');
  if ((entry.flags & 1) !== 0) throw new Error('不支持加密的 Word DOCX 文件');
  const compressed = readCompressedEntry(archive, entry);
  const xmlBytes = entry.compression === 0
    ? compressed
    : entry.compression === 8
      ? await inflateRaw(compressed, maximumXmlBytes, signal)
      : undefined;
  if (!xmlBytes) throw new Error(`不支持 Word 文件使用的 ZIP 压缩方式：${entry.compression}`);
  if (xmlBytes.byteLength > maximumXmlBytes) throw new Error('Word 正文解压后过大，已停止导入');
  assertActive(signal);
  const xml = new TextDecoder('utf-8').decode(xmlBytes);
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  if (document.getElementsByTagName('parsererror').length > 0) throw new Error('Word 正文 XML 已损坏');
  const paragraphs = Array.from(document.getElementsByTagNameNS('*', 'p'));
  const text = paragraphs.map(readParagraph).join('\n\n');
  if (text.length > maximumTextLength) throw new Error('导入正文不能超过 3200 万 UTF-16 字符');
  return text;
}

function findDocumentEntry(bytes: Uint8Array): ZipDocumentEntry {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimum = Math.max(0, bytes.byteLength - 65_557);
  let endOffset = -1;
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_END_SIGNATURE) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error('Word DOCX 文件不是有效的 ZIP 文档');
  const entryCount = view.getUint16(endOffset + 10, true);
  const centralOffset = view.getUint32(endOffset + 16, true);
  if (entryCount === 0xffff || centralOffset === 0xffffffff) throw new Error('暂不支持 ZIP64 Word 文档');
  let offset = centralOffset;
  const decoder = new TextDecoder('utf-8');
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== ZIP_CENTRAL_SIGNATURE) {
      throw new Error('Word DOCX 中央目录已损坏');
    }
    const flags = view.getUint16(offset + 8, true);
    const compression = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.byteLength) throw new Error('Word DOCX 文件名目录已损坏');
    const name = decoder.decode(bytes.subarray(nameStart, nameEnd)).replace(/\\/gu, '/');
    if (name === 'word/document.xml') {
      return { compression, flags, compressedSize, uncompressedSize, localHeaderOffset };
    }
    offset = nameEnd + extraLength + commentLength;
  }
  throw new Error('Word DOCX 中没有找到正文内容');
}

function readCompressedEntry(bytes: Uint8Array, entry: ZipDocumentEntry): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = entry.localHeaderOffset;
  if (offset + 30 > bytes.byteLength || view.getUint32(offset, true) !== ZIP_LOCAL_SIGNATURE) {
    throw new Error('Word DOCX 正文本地目录已损坏');
  }
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const start = offset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (start < 0 || end > bytes.byteLength) throw new Error('Word DOCX 正文数据不完整');
  return bytes.slice(start, end);
}

async function inflateRaw(
  compressed: Uint8Array,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前浏览器不支持解压 Word DOCX 文件');
  }
  const compressedCopy = new Uint8Array(compressed.byteLength);
  compressedCopy.set(compressed);
  const stream = new Blob([compressedCopy.buffer]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      assertActive(signal);
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximumBytes) throw new Error('Word 正文解压后过大，已停止导入');
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function readParagraph(paragraph: Element): string {
  const parts: string[] = [];
  const visit = (node: Node): void => {
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (element.localName === 't') {
      parts.push(element.textContent ?? '');
      return;
    }
    if (element.localName === 'tab') {
      parts.push('\t');
      return;
    }
    if (element.localName === 'br' || element.localName === 'cr') {
      parts.push('\n');
      return;
    }
    for (const child of Array.from(element.childNodes)) visit(child);
  };
  visit(paragraph);
  return parts.join('');
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Operation aborted', 'AbortError');
}
