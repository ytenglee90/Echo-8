import test from 'node:test';
import assert from 'node:assert/strict';
import { planBook, inspectBook, restoreBook, encodeBlock, decodeBlock } from '../cloud/data-worker/book-format.js';
import { packedBucket } from '../cloud/data-worker/book-packing.js';
import { SQLiteD1 } from './helpers/d1.ts';
import type { ProjectSource } from '../src/protocols/files.ts';

function source(count = 600): ProjectSource {
  const nodes: Record<string, unknown> = {}, chunks: Record<string, unknown> = {};
  for (let i = 0; i < count; i++) {
    nodes[`n${i}`] = { id: `n${i}`, contentId: `c${i}`, title: `节点 ${i}`, x: i * 20, y: i % 20 * 180, width: 260, height: 146, color: '#303030', revision: 1 };
    chunks[`c${i}`] = { text: `第 ${i} 段：共享小块保留 Unicode 😀、换行\n和原有记录。`, revision: 1 };
  }
  chunks.large = { text: '大段内容单独分块😀'.repeat(15_000) };
  const opaque = JSON.parse('{"__proto__":{"keep":"原样"},"constructor":true}');
  return { document: { revision: 1, namespaces: { textNode: nodes, textContentChunk: chunks, unknownPlugin: { opaque } } }, plugins: [{ id: 'unknown', version: '1', dataVersion: 4, available: false, namespaces: ['unknownPlugin'] }] };
}
type Plan = Awaited<ReturnType<typeof planBook>>;
function footprint(plan: Plan) {
  const db = new SQLiteD1();
  db.sqlite.exec("INSERT INTO projects(id,name,created_at,updated_at) VALUES ('packing-project','fixture',1,1)");
  const block = db.sqlite.prepare('INSERT INTO book_blocks VALUES (?,?,?,?,?,?,?)'), ref = db.sqlite.prepare('INSERT INTO book_refs VALUES (?,?)');
  for (const value of plan.blocks.values()) block.run('packing-project', value.hash, value.encoding, value.data, value.rawBytes, Buffer.byteLength(value.data), 1);
  for (const hash of plan.hashes) ref.run('packing-project', hash);
  const bytes = Number(db.sqlite.prepare('PRAGMA page_count').get()!.page_count) * Number(db.sqlite.prepare('PRAGMA page_size').get()!.page_size);
  db.sqlite.close(); return bytes;
}

test('packed cloud books reduce block and SQLite overhead while restoring old and new formats exactly', async context => {
  const input = source(), classic = await planBook(input, undefined, undefined, undefined, 2), packed = await planBook(input);
  assert.equal(classic.root.formatVersion, 2); assert.equal(packed.root.formatVersion, 3);
  for (const plan of [classic, packed]) {
    const get = async (hash: string) => plan.blocks.get(hash)!;
    const restored = await restoreBook(await inspectBook(plan.rootHash, get, new Set(plan.hashes)), get);
    assert.deepEqual(JSON.parse(JSON.stringify(restored)), input);
  }
  const metrics = { oldBlocks: classic.hashes.length, packedBlocks: packed.hashes.length, oldPhysicalBytes: footprint(classic), packedPhysicalBytes: footprint(packed) };
  context.diagnostic(JSON.stringify(metrics));
  assert.ok(metrics.packedBlocks < metrics.oldBlocks * .25);
  assert.ok(metrics.packedPhysicalBytes < metrics.oldPhysicalBytes * .65);
  assert.ok([...packed.entries.values()].every(entry => !('pendingText' in entry)), 'retained plans contain references rather than duplicate body text');
});

test('a one-record edit loads only its old small group, reuses large text, and matches a fresh full encoding', async context => {
  const input = source(); const original = await planBook(input);
  const available = new Map(original.blocks);
  const previous = await inspectBook(original.rootHash, async (hash: string) => available.get(hash)!);
  const large = new Set(previous.entries.get(JSON.stringify(['textContentChunk', 'large']))!.segments);
  const reads = new Set<string>();
  const get = async (hash: string) => { reads.add(hash); assert.ok(!large.has(hash), 'unchanged large text must not be fetched'); return available.get(hash)!; };
  const value = { ...(input.document.namespaces.textNode.n12 as object), x: 999 };
  const next = await planBook({ document: { revision: 2, namespaces: {} }, plugins: input.plugins }, previous,
    [{ op: 'set', domain: 'document', namespace: 'textNode', key: 'n12', value }], get);
  const expected = structuredClone(input); expected.document.revision = 2; expected.document.namespaces.textNode.n12 = value;
  const full = await planBook(expected);
  assert.equal(next.rootHash, full.rootHash);
  assert.ok(reads.size <= 4); assert.ok([...next.blocks.keys()].every(hash => !large.has(hash)));
  const uploaded = [...next.blocks.values()].reduce((sum, block) => sum + Buffer.byteLength(block.data), 0);
  context.diagnostic(JSON.stringify({ fetchedBlocks: reads.size, changedBlocks: next.blocks.size, uploadedBytes: uploaded }));
  assert.ok(uploaded < 32 * 1024);
  for (const [hash, block] of next.blocks) available.set(hash, block);
  const restored = await restoreBook(await inspectBook(next.rootHash, async (hash: string) => available.get(hash)!), async (hash: string) => available.get(hash)!);
  assert.deepEqual(JSON.parse(JSON.stringify(restored)), expected);
});

test('format-2 compaction reads only eligible small records and preserves large content hashes', async () => {
  const input = source(), classic = await planBook(input, undefined, undefined, undefined, 2);
  const previous = await inspectBook(classic.rootHash, async (hash: string) => classic.blocks.get(hash)!);
  const large = new Set(previous.entries.get(JSON.stringify(['textContentChunk', 'large']))!.segments);
  const next = await planBook({ document: { revision: 1, namespaces: {} }, plugins: input.plugins }, previous, [], async (hash: string) => {
    assert.ok(!large.has(hash)); return classic.blocks.get(hash)!;
  });
  assert.equal(next.rootHash, (await planBook(input)).rootHash);
  assert.deepEqual(next.entries.get(JSON.stringify(['textContentChunk', 'large']))!.segments, [...large]);
});

test('packed byte ranges reject out-of-bounds, oversized, wrong-version and broken UTF-8 record slices', async () => {
  const plan = await planBook(source(8));
  const index = 0;
  const page = JSON.parse(new TextDecoder().decode(await decodeBlock(plan.blocks.get(plan.root.pages[index])!)));
  for (const mutate of [(e:Record<string,unknown>) => { e.offset = -1; }, (e:Record<string,unknown>) => { e.offset = 999999; },
    (e:Record<string,unknown>) => { e.bytes = 1025; }, (e:Record<string,unknown>) => { e.offset = Number(e.offset) + 1; }]) {
    const broken = structuredClone(page); mutate(broken.entries.find((e:Record<string,unknown>) => e.offset !== undefined));
    const pageBlock = await encodeBlock(new TextEncoder().encode(JSON.stringify(broken)));
    const root = structuredClone(plan.root) as typeof plan.root & {pageSizes:number[]}; root.pages[index] = pageBlock.hash; root.pageSizes[index] = pageBlock.rawBytes;
    const rootBlock = await encodeBlock(new TextEncoder().encode(JSON.stringify(root)));
    const blocks = new Map([...plan.blocks, [pageBlock.hash, pageBlock], [rootBlock.hash, rootBlock]]);
    await assert.rejects(inspectBook(rootBlock.hash, async (hash: string) => blocks.get(hash)!));
  }
});

test('a collision-heavy bucket has a bounded packing budget and deterministic overflow records', async () => {
  const records: Record<string, unknown> = {};
  for (let i = 0; Object.keys(records).length < 700; i++) if (packedBucket(JSON.stringify(['dense', `k${i}`])) === 0) records[`k${i}`] = { text: 'x'.repeat(500), i };
  const input: ProjectSource = { document: { revision: 1, namespaces: { dense: records } }, plugins: [] };
  const plan = await planBook(input);
  assert.ok([...plan.entries.values()].some(entry => entry.offset === undefined));
  const packedHashes = new Set([...plan.entries.values()].filter(entry => entry.offset !== undefined).flatMap(entry => entry.segments));
  assert.ok([...packedHashes].reduce((sum, hash) => sum + plan.blocks.get(hash)!.rawBytes, 0) <= 256 * 1024);
  const get = async (hash:string) => plan.blocks.get(hash)!;
  assert.deepEqual(JSON.parse(JSON.stringify(await restoreBook(await inspectBook(plan.rootHash,get),get))), input);
});
