import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WorkerService,
  type ManagedWorkerPort,
  type WorkerCancelMessage,
  type WorkerRequestMessage,
  type WorkerResponseMessage,
} from '../src/core/worker-service.ts';
import {
  analyzeSearchChunks,
  buildSearchBloom,
  buildCompressedSearchPostings,
  buildSearchSignature,
  findSearchPostingKeys,
  mightContainSearchTerm,
  rankSearchChunks,
} from '../src/plugins/search-index/worker-jobs.ts';

class FakeManagedWorker implements ManagedWorkerPort {
  readonly posted: Array<WorkerRequestMessage | WorkerCancelMessage> = [];
  terminated = false;
  private readonly messageListeners = new Set<(event: MessageEvent<WorkerResponseMessage>) => void>();
  private readonly failureListeners = new Map<'error' | 'messageerror', Set<(event: Event) => void>>([
    ['error', new Set()],
    ['messageerror', new Set()],
  ]);

  postMessage(message: WorkerRequestMessage | WorkerCancelMessage): void {
    this.posted.push(message);
    if (!('payload' in message) || message.payload === 'hold') return;
    queueMicrotask(() => {
      const event = new MessageEvent<WorkerResponseMessage>('message', {
        data: { id: message.id, ok: true, result: message.payload },
      });
      for (const listener of this.messageListeners) listener(event);
    });
  }

  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerResponseMessage>) => void): void;
  addEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
  addEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener: ((event: MessageEvent<WorkerResponseMessage>) => void) | ((event: Event) => void),
  ): void {
    if (type === 'message') this.messageListeners.add(listener as (event: MessageEvent<WorkerResponseMessage>) => void);
    else this.failureListeners.get(type)!.add(listener as (event: Event) => void);
  }

  removeEventListener(type: 'message', listener: (event: MessageEvent<WorkerResponseMessage>) => void): void;
  removeEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void;
  removeEventListener(
    type: 'message' | 'error' | 'messageerror',
    listener: ((event: MessageEvent<WorkerResponseMessage>) => void) | ((event: Event) => void),
  ): void {
    if (type === 'message') this.messageListeners.delete(listener as (event: MessageEvent<WorkerResponseMessage>) => void);
    else this.failureListeners.get(type)!.delete(listener as (event: Event) => void);
  }

  terminate(): void {
    this.terminated = true;
  }
}

test('managed worker service enforces ownership and cancels plugin jobs', async () => {
  const port = new FakeManagedWorker();
  const service = new WorkerService(() => port);
  assert.equal(service.isAvailable(), true);
  assert.deepEqual(await service.run('search-index', 'search-index.echo@1', { ok: true }), { ok: true });
  await assert.rejects(service.run('search-index', 'semantic.echo@1', null), /outside owner/u);

  const controller = new AbortController();
  const aborted = service.run('search-index', 'search-index.hold@1', 'hold', controller.signal);
  controller.abort(new DOMException('cancelled', 'AbortError'));
  await assert.rejects(aborted, /cancelled/u);
  assert.equal(port.posted.some((message) => message.type === 'core.worker.cancel'), true);

  const stopped = service.run('search-index', 'search-index.hold@1', 'hold');
  service.cancelOwner('search-index');
  await assert.rejects(stopped, /Plugin stopped/u);
  service.dispose();
  assert.equal(port.terminated, true);
});

test('search worker jobs preserve Bloom filtering, phrase analysis and BM25 ordering', () => {
  const exactText = '生产环境上游返回 502，随后确认服务器出现内存溢出。';
  const broadText = '服务发生故障，目前还在排查原因。';
  const bloom = buildSearchBloom(exactText);
  assert.equal(mightContainSearchTerm(bloom, '502'), true);
  assert.equal(mightContainSearchTerm(bloom, '完全无关的检索词'), false);

  const analyzed = analyzeSearchChunks({
    terms: ['故障', '502'],
    phrase: '服务器出现内存溢出',
    chunks: [
      { key: 1, title: '普通故障', text: broadText },
      { key: 2, title: '生产环境 502', text: exactText },
    ],
  });
  const ranked = rankSearchChunks({
    totalChunks: 2,
    terms: ['故障', '502'],
    candidates: analyzed.map((chunk) => ({
      key: chunk.key,
      title: chunk.key === 2 ? '生产环境 502' : '普通故障',
      textLength: chunk.textLength,
      termFrequency: chunk.termFrequency,
      phraseMatch: chunk.phraseMatch,
    })),
  }).sort((left, right) => right.score - left.score);
  assert.equal(ranked[0]?.key, 2);
  assert.equal(analyzed.find((chunk) => chunk.key === 2)?.phraseMatch, true);
  assert.match(analyzed.find((chunk) => chunk.key === 2)?.preview ?? '', /502/u);
});

test('search postings use delta-varint lists without changing exact candidate recall', () => {
  const first = buildSearchSignature('生产服务器返回 502，确认内存溢出。');
  const second = buildSearchSignature('测试服务器运行正常。');
  const third = buildSearchSignature('产品发布说明与宣传素材。');
  const postings = buildCompressedSearchPostings({
    chunks: [
      { key: 300, termHashes: first.termHashes },
      { key: 7, termHashes: second.termHashes },
      { key: 41, termHashes: third.termHashes },
    ],
  });

  assert.deepEqual([...findSearchPostingKeys(postings, '服务器') ?? []], [7, 300]);
  assert.deepEqual([...findSearchPostingKeys(postings, '内存溢出') ?? []], [300]);
  assert.deepEqual([...findSearchPostingKeys(postings, '宣传素材') ?? []], [41]);
  assert.deepEqual([...findSearchPostingKeys(postings, '完全不存在') ?? []], []);
  assert.equal(findSearchPostingKeys(postings, '服'), undefined);
  assert.equal(postings.postings.byteLength < 4 * (
    first.termHashes.length + second.termHashes.length + third.termHashes.length
  ), true);
});
