import assert from 'node:assert/strict';
import test from 'node:test';
import type { AIContextSource } from '../src/protocols/ai.ts';
import {
  buildMemoryIndexDraft,
  type MemorySourceReader,
} from '../src/plugins/ai-assistant/memory-indexing.ts';

function sourceReader(text: string, revision = 1): MemorySourceReader {
  const source: AIContextSource = {
    sourceId: 'memory:source',
    provider: 'test',
    kind: 'conversation',
    title: '测试记忆',
    revision,
    length: text.length,
  };
  return async (request) => ({
    handled: true,
    source,
    start: request.start,
    text: text.slice(request.start, request.start + request.length),
  });
}

test('memory indexing reads bounded ranges and records explicit user facts only', async () => {
  const body = [
    '[用户 · 通用]',
    '@确认 环境=生产｜超时时间：30 秒',
    '@修改 环境=生产｜发布窗口：九月 → 十月',
    '[助手 · 通用]',
    '@废弃 这不是用户确认的内容',
    'ProjectAurora 将在十月发布。',
  ].join('\n');
  const index = await buildMemoryIndexDraft(
    sourceReader(body, 7),
    'memory:source',
    '极光项目',
    new AbortController().signal,
    () => undefined,
    async () => undefined,
  );

  assert.equal(index.sourceRevision, 7);
  assert.equal(index.sourceLength, body.length);
  assert.equal(index.keywords.includes('projectaurora'), true);
  assert.equal(index.claims?.length, 2);
  assert.deepEqual(index.claims?.map((claim) => ({
    kind: claim.kind,
    subject: claim.subject,
    value: claim.value,
    previousValue: claim.previousValue,
    scope: claim.scope,
  })), [
    { kind: 'confirm', subject: '超时时间', value: '30 秒', previousValue: undefined, scope: '环境=生产' },
    { kind: 'modify', subject: '发布窗口', value: '十月', previousValue: '九月', scope: '环境=生产' },
  ]);
});

test('memory indexing preserves a directive split across its range boundary', async () => {
  const header = '[用户 · 通用]\n';
  const directiveStart = 32 * 1024 - 5;
  const body = `${header}${'填'.repeat(directiveStart - header.length - 1)}\n` +
    '@确认 项目状态：已经完成\n';
  const readLengths: number[] = [];
  const reader = sourceReader(body);
  const index = await buildMemoryIndexDraft(
    async (request, signal) => {
      readLengths.push(request.length);
      return reader(request, signal);
    },
    'memory:source',
    '跨块测试',
    new AbortController().signal,
    () => undefined,
    async () => undefined,
  );

  assert.equal(readLengths.some((length) => length === 32 * 1024), true);
  assert.equal(readLengths.length >= 3, true);
  assert.equal(index.claims?.some((claim) =>
    claim.kind === 'confirm' && claim.subject === '项目状态' && claim.value === '已经完成'), true);
});

test('memory indexing rejects a revision change during range scanning', async () => {
  const body = '记忆正文'.repeat(10_000);
  const stable = sourceReader(body, 1);
  let reads = 0;

  await assert.rejects(() => buildMemoryIndexDraft(
    async (request, signal) => {
      const result = await stable(request, signal);
      reads += 1;
      return reads > 1 && result.source ? { ...result, source: { ...result.source, revision: 2 } } : result;
    },
    'memory:source',
    '修订测试',
    new AbortController().signal,
    () => undefined,
    async () => undefined,
  ), /原文发生变化/u);
});
