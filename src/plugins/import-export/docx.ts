import type { TextDocumentFormat } from '../../protocols/formatting.ts';

interface ZipEntry {
  name: string;
  data: Uint8Array<ArrayBuffer>;
}

const encoder = new TextEncoder();

export async function createDocx(
  title: string,
  textParts: BlobPart[],
  format: TextDocumentFormat,
): Promise<Blob> {
  const text = await new Blob(textParts, { type: 'text/plain;charset=utf-8' }).text();
  const created = new Date().toISOString();
  const entries: ZipEntry[] = [
    xmlEntry('[Content_Types].xml', contentTypesXml()),
    xmlEntry('_rels/.rels', rootRelationshipsXml()),
    xmlEntry('docProps/app.xml', appPropertiesXml()),
    xmlEntry('docProps/core.xml', corePropertiesXml(title, created)),
    xmlEntry('word/document.xml', documentXml(title, text, format)),
    xmlEntry('word/_rels/document.xml.rels', documentRelationshipsXml()),
    xmlEntry('word/styles.xml', stylesXml(format)),
  ];
  return createStoredZip(entries, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
}

function documentXml(title: string, text: string, format: TextDocumentFormat): string {
  const size = Math.round(format.fontSize * 2);
  const color = normalizeHex(format.color);
  const line = Math.round(format.lineHeight * 240);
  const after = Math.round(format.paragraphSpacing * format.fontSize * 20);
  const firstLine = Math.round(format.firstLineIndent * format.fontSize * 20);
  const spacing = Math.round(format.letterSpacing * 20);
  const titleContent = escapeXml(title);
  const content = escapeXml(text).replace(/\n/gu, '</w:t><w:br/><w:t xml:space="preserve">');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:r>
        <w:rPr><w:b/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/><w:color w:val="${color}"/></w:rPr>
        <w:t xml:space="preserve">${titleContent}</w:t>
      </w:r>
    </w:p>
    <w:p>
      <w:pPr><w:spacing w:line="${line}" w:lineRule="auto" w:after="${after}"/><w:ind w:firstLine="${firstLine}"/></w:pPr>
      <w:r>
        <w:rPr>${format.fontWeight >= 600 ? '<w:b/>' : ''}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/><w:color w:val="${color}"/><w:spacing w:val="${spacing}"/></w:rPr>
        <w:t xml:space="preserve">${content}</w:t>
      </w:r>
    </w:p>
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
  </w:body>
</w:document>`;
}

function stylesXml(format: TextDocumentFormat): string {
  const size = Math.round(format.fontSize * 2);
  const color = normalizeHex(format.color);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:eastAsia="等线" w:hAnsi="Aptos"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/><w:color w:val="${color}"/></w:rPr></w:rPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
</w:styles>`;
}

function contentTypesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;
}

function rootRelationshipsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
}

function documentRelationshipsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}

function corePropertiesXml(title: string, created: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${escapeXml(title)}</dc:title><dc:creator>Echo-8</dc:creator><cp:lastModifiedBy>Echo-8</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${created}</dcterms:modified>
</cp:coreProperties>`;
}

function appPropertiesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Echo-8</Application></Properties>`;
}

function xmlEntry(name: string, value: string): ZipEntry {
  return { name, data: encoder.encode(value) };
}

function createStoredZip(entries: ZipEntry[], mimeType: string): Blob {
  const localParts: BlobPart[] = [];
  const centralParts: BlobPart[] = [];
  let offset = 0;
  const { time, date } = dosDateTime(new Date());
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, time, true);
    localView.setUint16(12, date, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, entry.data.length, true);
    localView.setUint32(22, entry.data.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    localParts.push(local, entry.data);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, time, true);
    centralView.setUint16(14, date, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, entry.data.length, true);
    centralView.setUint32(24, entry.data.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    centralParts.push(central);
    offset += local.length + entry.data.length;
  }
  const centralSize = centralParts.reduce((size, part) => size + (part as Uint8Array).byteLength, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  return new Blob([...localParts, ...centralParts, end], { type: mimeType });
}

function crc32(bytes: Uint8Array<ArrayBuffer>): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function dosDateTime(value: Date): { time: number; date: number } {
  const year = Math.max(1980, value.getFullYear());
  return {
    time: (value.getHours() << 11) | (value.getMinutes() << 5) | Math.floor(value.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate(),
  };
}

function normalizeHex(value: string): string {
  return /^#[0-9a-f]{6}$/iu.test(value) ? value.slice(1).toUpperCase() : '2F3035';
}

function escapeXml(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  CRC_TABLE[index] = value >>> 0;
}
