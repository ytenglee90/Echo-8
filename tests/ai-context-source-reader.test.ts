import assert from 'node:assert/strict';
import test from 'node:test';
import type { PluginContext } from '../src/core/contracts.ts';
import type {
  AIContextReadRequest,
  AIContextSource,
  AIPreparedSource,
} from '../src/protocols/ai.ts';
import {
  readCompleteContextSourceText,
  readContextCatalog,
  readContextSource,
  readNaturalEvidenceBlock,
  revalidatePreparedSources,
} from '../src/plugins/ai-assistant/context-source-reader.ts';

function sourceFor(text: string, revision = 1): AIContextSource {
  return {
    sourceId: 'node:1',
    provider: 'test',
    kind: 'text',
    title: '测试节点',
    revision,
    length: text.length,
  };
}

function readingContext(
  text: string,
  revisionAtCall: (call: number) => number = () => 1,
): { context: PluginContext; requests: AIContextReadRequest[] } {
  const requests: AIContextReadRequest[] = [];
  let calls = 0;
  const context = {
    capabilities: {
      requestAll: async (key: string, request: AIContextReadRequest) => {
        assert.equal(key, 'context.read@1');
        requests.push(request);
        calls += 1;
        const source = sourceFor(text, revisionAtCall(calls));
        return [{
          handled: true,
          source,
          start: request.start,
          text: text.slice(request.start, request.start + request.length),
        }];
      },
    },
  } as unknown as PluginContext;
  return { context, requests };
}

test('AI context catalog deduplicates source identities in provider order', async () => {
  const first = sourceFor('正文');
  const second = { ...sourceFor('另一段'), sourceId: 'node:2', title: '第二节点' };
  const context = {
    capabilities: {
      requestAll: async () => [
        { provider: 'first', sources: [first, second] },
        { provider: 'second', sources: [{ ...first, title: '重复节点' }] },
      ],
    },
  } as unknown as PluginContext;

  assert.deepEqual((await readContextCatalog(context)).map((source) => source.sourceId), ['node:1', 'node:2']);
});

test('complete AI source reads stay range-bounded and verify the final revision', async () => {
  const text = '范围读取'.repeat(90_000);
  const { context, requests } = readingContext(text);
  const progress: number[] = [];
  const result = await readCompleteContextSourceText(
    context,
    'node:1',
    undefined,
    1,
    (value) => progress.push(value),
  );

  assert.equal(result, text);
  assert.equal(requests.filter((request) => request.length > 0).every((request) => request.length <= 256 * 1024), true);
  assert.equal(requests.filter((request) => request.length > 0).length >= 2, true);
  assert.equal(progress.at(-1), 1);
});

test('AI source reads reject missing providers and revision changes before stale evidence is used', async () => {
  const missing = {
    capabilities: { requestAll: async () => [] },
  } as unknown as PluginContext;
  await assert.rejects(
    () => readContextSource(missing, { sourceId: 'missing', start: 0, length: 1 }),
    /当前不可读/u,
  );

  const text = '原文'.repeat(150_000);
  const drifting = readingContext(text, (call) => call >= 3 ? 2 : 1).context;
  await assert.rejects(
    () => readCompleteContextSourceText(drifting, 'node:1', undefined, 1),
    /内容版本已经变化/u,
  );

  const prepared: AIPreparedSource = {
    ...sourceFor('当前正文', 1),
    start: 0,
    length: 4,
    text: '当前正文',
    reason: 'explicit-reference',
  };
  await assert.rejects(
    () => revalidatePreparedSources(readingContext('当前正文', () => 2).context, [prepared]),
    /已修改/u,
  );
});

test('AI retry can advance an autosaved conversation-memory revision only when its prepared range is unchanged', async () => {
  const prepared: AIPreparedSource = {
    ...sourceFor('旧问答\n新增对话', 1),
    start: 0,
    length: 3,
    text: '旧问答',
    reason: 'conversation-memory',
  };
  const allowed = new Set([prepared.sourceId]);

  await revalidatePreparedSources(
    readingContext('旧问答\n新增对话', () => 2).context,
    [prepared],
    { allowUnchangedRangeRevisionAdvanceFor: allowed },
  );
  assert.equal(prepared.revision, 2);

  await assert.rejects(
    () => revalidatePreparedSources(
      readingContext('已改动\n新增对话', () => 3).context,
      [prepared],
      { allowUnchangedRangeRevisionAdvanceFor: allowed },
    ),
    /已修改/u,
  );
});

test('natural evidence reading returns a complete Markdown table instead of a broken slice', async () => {
  const text = [
    '前言。',
    '',
    '| 环境 | 超时 |',
    '| --- | --- |',
    '| 生产 | 30 秒 |',
    '| 测试 | 5 秒 |',
    '',
    '结尾。',
  ].join('\n');
  const source = sourceFor(text);
  const block = await readNaturalEvidenceBlock(
    readingContext(text).context,
    source,
    text.indexOf('30 秒'),
    200,
    200,
  );

  assert.equal(block.boundary, 'markdown-table');
  assert.equal(block.complete, true);
  assert.match(block.text, /^\| 环境 \| 超时 \|/u);
  assert.match(block.text, /\| 测试 \| 5 秒 \|$/u);
});

test('natural evidence reading keeps a matched conversation question and answer together', async () => {
  const text = '[用户]\n怎么保存？\n\n[助手]\n点击保存按钮。\n\n[用户]\n下一题';
  const source = sourceFor(text);
  const block = await readNaturalEvidenceBlock(
    readingContext(text).context,
    source,
    text.indexOf('保存按钮'),
    200,
    200,
  );
  assert.equal(block.boundary, 'conversation-turn');
  assert.equal(block.complete, true);
  assert.equal(block.text, '[用户]\n怎么保存？\n\n[助手]\n点击保存按钮。');
});
