import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseProject, serializeProject, type ProjectParseLimits } from '../src/plugins/import-export/codec.ts';
import { AITextBookReader } from '../src/plugins/import-export/ai-text-book.ts';

const fixture = readFileSync(new URL('./fixtures/ai-text-book-v1.txt', import.meta.url), 'utf8');
const header = { type: 'manifest', kind: 'echo-8-ai-book', formatVersion: 1 };
const node = { type: 'node', id: 'one', category: '设定', name: '条目', text: '内容' };
const end = { type: 'end' };
const book = (records: unknown[], head: unknown = header) => new Blob([[head, ...records].map(r => JSON.stringify(r)).join('\n')]);
const limits: ProjectParseLimits = { maxCompressedBytes: 256 * 1024 * 1024, maxDecompressedBytes: 256 * 1024 * 1024,
  maxLogicalEntryBytes: 64 * 1024 * 1024, maxFragmentsPerEntry: 1024, maxEntries: 250_000 };
function body(ns: Record<string, Record<string, unknown>>, contentId: string): string {
  const c = ns.textContent[contentId] as { length: number; chunkIds: string[]; chunkLengths: number[] };
  const parts = c.chunkIds.map((id, index) => {
    const chunk = ns.textContentChunk[id] as { text: string; contentId: string };
    assert.equal(chunk.contentId, contentId); assert.equal(chunk.text.length, c.chunkLengths[index]);
    assert.ok(chunk.text.length <= 65536); return chunk.text;
  });
  assert.equal(parts.reduce((sum, s) => sum + s.length, 0), c.length); return parts.join('');
}

test('AI-authored text renamed to echo8 opens without scripts, checksums or generated native metadata', async () => {
  const input = new Blob([fixture]); Object.defineProperty(input, 'name', { value: '只改后缀.echo8' });
  const parsed = await parseProject(input), ns = parsed.document.namespaces;
  assert.equal(parsed.manifest.kind, 'echo-8-project'); assert.equal(parsed.manifest.formatVersion, 2);
  assert.deepEqual(parsed.history, { undo: [], redo: [] });
  const nodes = Object.values(ns.textNode) as { id: string; contentId: string; title: string; presentation: string; titleColor: string }[];
  assert.equal(nodes.length, 17); assert.equal(nodes.filter(n => n.presentation === 'card').length, 9);
  assert.equal(nodes.filter(n => n.presentation === 'text-box').length, 8);
  assert.equal(Object.keys(ns.groups).length, 7); assert.equal(Object.keys(ns.connections).length, 6);
  const prose = nodes.find(n => n.title === '正文｜第001卷·第001章·旧钟')!;
  assert.ok(body(ns, prose.contentId).endsWith('他在钟心摸到一张纸，落款竟是自己的名字。'));
  const hero = body(ns, nodes.find(n => n.title === '主角｜林渊')!.contentId);
  assert.ok(hero.includes('“明天见🧭”')); assert.ok(hero.includes('C:\\小说\\旧钟')); assert.ok(hero.includes('\n\n')); assert.ok(hero.includes('<b>普通文字</b>'));
  const colors = nodes.filter(n => n.title.startsWith('配角｜')).map(n => n.titleColor);
  assert.deepEqual(colors, ['#3568a8', '#3568a8']);
  const grouped = new Set<string>();
  for (const group of Object.values(ns.groups) as { title: string; memberIds: string[] }[]) {
    const kinds = new Set<string>(); let headers = 0;
    for (const id of group.memberIds) {
      assert.ok(!grouped.has(id)); grouped.add(id); const n = nodes.find(n => n.id === id)!; assert.ok(n);
      if (n.presentation === 'card') kinds.add(n.title.split('｜')[0]); else if (n.title === group.title) headers++;
    }
    assert.equal(kinds.size, 1); assert.equal([...kinds][0], group.title.split('｜')[0]); assert.equal(headers, 1);
  }
});

test('AI text migrates on normal save to native CRC32 v2 and preserves all staged document data', async () => {
  const parsed = await parseProject(new Blob([fixture]));
  const saved = await serializeProject({ document: parsed.document, plugins: parsed.manifest.plugins });
  const reopened = await parseProject(saved); assert.equal(reopened.document.revision, parsed.document.revision);
  for (const [namespace, values] of Object.entries(parsed.document.namespaces)) {
    assert.deepEqual(reopened.document.namespaces[namespace] ?? {}, JSON.parse(JSON.stringify(values)));
  }
  const bytes = new Uint8Array(await saved.arrayBuffer());
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const raw = await new Response(stream).text(); assert.ok(raw.includes('"algorithm":"crc32"'));
  await assert.rejects(parseProject(new Blob([raw.replace('"revision":1', '"revision":2')])), /校验失败/u);
  await assert.rejects(parseProject(new Blob([raw.slice(0, raw.lastIndexOf('{"type":"footer"'))])), /不完整/u);
});

test('AI source tolerates UTF8 BOM and CRLF without making native CRC validation optional', async () => {
  const parsed = await parseProject(new Blob(['\uFEFF' + fixture.replace(/\n/gu, '\r\n')]));
  assert.equal(Object.keys(parsed.document.namespaces.textNode).length, 17);
  await assert.rejects(parseProject(book([node, end], { ...header, kind: 'echo-8-project' })), /可识别/u);
});

test('streamed text parts keep Unicode and chunk lengths intact without whole-body joining', async () => {
  const part = '甲'.repeat(65535) + '🧭' + '\n';
  const parsed = await parseProject(book([{ ...node, text: '' }, { type: 'text', id: 'one', text: part }, { type: 'text', id: 'one', text: part }, end]));
  const n = Object.values(parsed.document.namespaces.textNode).find(n => (n as { presentation: string }).presentation === 'card') as { contentId: string };
  assert.ok(body(parsed.document.namespaces, n.contentId) === part + part);
});

test('natural chapter order, explicit order and tall notes leave all groups and nodes separate', async () => {
  const parsed = await parseProject(book([
    ...[10, 2, 1].map(number => ({ ...node, id: String(number), name: `第${number}章`, section: '第一卷' })),
    { ...node, id: 'second', name: '另一卷', section: '第二卷' },
    { ...node, id: 'note', name: '说明'.repeat(100), presentation: 'text-box' }, end,
  ]));
  const nodes = Object.values(parsed.document.namespaces.textNode) as { title: string; presentation: string; x: number; y: number; width: number; height: number }[];
  const ordered = nodes.filter(n => n.presentation === 'card' && n.title.includes('章')).sort((a, b) => a.y - b.y || a.x - b.x);
  assert.deepEqual(ordered.map(n => n.title), ['设定｜第1章', '设定｜第2章', '设定｜第10章']);
  for (let a = 0; a < nodes.length; a++) for (let b = a + 1; b < nodes.length; b++) {
    const left = nodes[a], right = nodes[b]; assert.ok(!(left.x < right.x + right.width && right.x < left.x + left.width && left.y < right.y + right.height && right.y < left.y + left.height));
  }
});

test('unknown versions, truncation, invalid declarations, references and trailing records fail atomically', async () => {
  const invalid: unknown[][] = [[], [node], [end], [node, node, end], [node, { ...node, id: 'two' }, end],
    [{ ...node, text: 3 }, end], [{ ...node, group: '混组' }, end], [{ ...node, presentation: 'bad' }, end],
    [{ ...node, color: 'red' }, end], [{ ...node, order: -1 }, end], [{ ...node, id: '__proto__' }, end],
    [{ type: 'text', id: 'missing', text: 'x' }, node, end], [node, { type: 'link', from: 'one', to: 'missing', kind: 'sequence' }, end],
    [node, { type: 'link', from: 'one', to: 'one', kind: 'insert' }, end],
    [node, { type: 'unknown' }, end], [node, end, node],
    [node, { ...node, id: 'two', name: '其他', color: '#112233' }, { ...node, id: 'three', name: '再一个', color: '#445566' }, end],
    [node, { ...node, id: 'two', name: '其他' }, ...Array(2).fill({ type: 'link', from: 'one', to: 'two', kind: 'sequence' }), end],
  ];
  for (const records of invalid) await assert.rejects(parseProject(book(records)));
  await assert.rejects(parseProject(book([node, end], { ...header, formatVersion: 2 })), /版本/u);
  const controller = new AbortController(); controller.abort(); await assert.rejects(parseProject(new Blob([fixture]), controller.signal));
  await assert.rejects(parseProject(book([node, end]), undefined, undefined, { ...limits, maxEntries: 2 }), /记录过多/u);
  await assert.rejects(parseProject(book([{ ...node, text: '甲'.repeat(100) }, end]), undefined, undefined, { ...limits, maxLogicalEntryBytes: 100 }), /记录过大/u);
  await assert.rejects(parseProject(new Blob([fixture]), undefined, undefined, { ...limits, maxDecompressedBytes: 100 }), /上限/u);
});

test('2000 source cards use bounded chunks, one homogeneous group and cancellable staging', async () => {
  const started = performance.now();
  const parsed = await parseProject(book([...Array.from({ length: 2000 }, (_, i) => ({ ...node, id: `n${i}`, name: `第${i + 1}章`, text: '正文🧭'.repeat(20) })), end]));
  assert.equal(Object.keys(parsed.document.namespaces.textNode).length, 2001); assert.equal(Object.keys(parsed.document.namespaces.groups).length, 1);
  assert.equal(Object.keys(parsed.document.namespaces.textContentChunk).length, 2001);
  assert.ok(performance.now() - started < 15000);
});

test('cancelling the last materialization yield cannot return a replacement document', async () => {
  const reader = new AITextBookReader(header, limits);
  for (let index = 0; index < 24; index++) reader.accept({ ...node, id: `note${index}`, name: `说明${index}`, presentation: 'text-box' }, 100);
  reader.accept(end, 14);
  const controller = new AbortController();
  const pending = reader.finish(controller.signal);
  controller.abort();
  await assert.rejects(pending);
});
