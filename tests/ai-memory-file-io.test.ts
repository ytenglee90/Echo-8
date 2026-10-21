import assert from 'node:assert/strict';
import test from 'node:test';
import type { PluginContext } from '../src/core/contracts.ts';
import type { AIContextReadRequest, AIContextSource } from '../src/protocols/ai.ts';
import type { ContentCreatePlanRequest, ContentMutationPlan } from '../src/protocols/content.ts';
import type {
  FileDirectoryTarget,
  FileReadWriteTarget,
  FileWritableTarget,
} from '../src/protocols/files.ts';
import {
  AI_MEMORY_FILE_INDEX_SUFFIX,
  AI_MEMORY_FILE_ORIGINAL_SUFFIX,
  formatMemoryIndexText,
} from '../src/plugins/ai-assistant/memory-artifacts.ts';
import { AI_MEMORY_NAMESPACE } from '../src/plugins/ai-assistant/memory-commit.ts';
import {
  prepareMemoryFileImport,
  writeMemorySourceToDirectory,
} from '../src/plugins/ai-assistant/memory-file-io.ts';
import {
  AI_SESSION_NAMESPACE,
  AI_TRANSCRIPT_NAMESPACE,
} from '../src/plugins/ai-assistant/transcript-storage.ts';

function source(sourceId: string, text: string, revision: number): AIContextSource {
  return {
    sourceId,
    provider: 'test',
    kind: 'text',
    title: '测试来源',
    revision,
    length: text.length,
  };
}

function readingContext(
  text: string,
  revisionAtCall: (call: number) => number = () => 1,
): PluginContext {
  let calls = 0;
  return {
    capabilities: {
      requestAll: async (key: string, request: AIContextReadRequest) => {
        assert.equal(key, 'context.read@1');
        calls += 1;
        const metadata = source(request.sourceId, text, revisionAtCall(calls));
        return [{
          handled: true,
          source: metadata,
          start: request.start,
          text: text.slice(request.start, request.start + request.length),
        }];
      },
    },
  } as unknown as PluginContext;
}

test('AI memory TXT export streams bounded source ranges and closes one writable', async () => {
  const text = '长期记忆'.repeat(90_000);
  const writes: Blob[] = [];
  let closed = 0;
  let aborted = 0;
  const writable: FileWritableTarget = {
    write: async (data) => { writes.push(data); },
    close: async () => { closed += 1; },
    abort: async () => { aborted += 1; },
  };
  const directory: FileDirectoryTarget = {
    name: '记忆目录',
    getFileHandle: async () => ({ name: '记忆.txt', createWritable: async () => writable }),
  };
  const progress: number[] = [];

  await writeMemorySourceToDirectory(
    readingContext(text),
    directory,
    '记忆.txt',
    'node:memory',
    new AbortController().signal,
    (value) => progress.push(value),
    async () => undefined,
  );

  assert.equal(writes.length >= 2, true);
  assert.equal(writes.every((part) => part.size <= 256 * 1024 * 3), true);
  assert.equal((await Promise.all(writes.map((part) => part.text()))).join(''), text);
  assert.equal(closed, 1);
  assert.equal(aborted, 0);
  assert.equal(progress.at(-1), 1);
});

test('AI memory TXT export aborts the writable when the source revision changes', async () => {
  let aborted = 0;
  const directory: FileDirectoryTarget = {
    name: '记忆目录',
    getFileHandle: async () => ({
      name: '记忆.txt',
      createWritable: async () => ({
        write: async () => undefined,
        close: async () => undefined,
        abort: async () => { aborted += 1; },
      }),
    }),
  };

  await assert.rejects(
    () => writeMemorySourceToDirectory(
      readingContext('正文内容', (call) => call > 1 ? 2 : 1),
      directory,
      '记忆.txt',
      'node:memory',
      new AbortController().signal,
      () => undefined,
      async () => undefined,
    ),
    /原文发生变化/u,
  );
  assert.equal(aborted, 1);
});

function memoryFile(name: string, text: string): FileReadWriteTarget {
  return {
    name,
    createWritable: async () => ({
      write: async () => undefined,
      close: async () => undefined,
    }),
    getFile: async () => new File([text], name, { type: 'text/plain' }),
  };
}

test('AI memory TXT import prepares standard patches without mutating the store', async () => {
  const originalText = '[用户 · 通用]\n项目发布日期是什么？\n[助手 · 通用]\n发布日期是九月。';
  const indexText = formatMemoryIndexText({
    sourceRevision: 1,
    sourceLength: originalText.length,
    summary: '确认了项目发布日期。',
    keywords: ['项目', '发布日期'],
    anchors: [],
    createdAt: 1,
  }, { archiveNodeId: 'old:archive', archiveTitle: '项目讨论', savedAt: 1 });
  const requests: ContentCreatePlanRequest[] = [];
  let planNumber = 0;
  const context = {
    capabilities: {
      request: async (key: string, request: ContentCreatePlanRequest): Promise<ContentMutationPlan> => {
        assert.equal(key, 'content.createPlan@1');
        requests.push(request);
        planNumber += 1;
        return {
          nodeId: `node:${planNumber}`,
          revision: 1,
          length: (request.body ?? '').length,
          resolvedTitle: request.title,
          patches: [{
            op: 'set',
            domain: 'document',
            namespace: 'testPlans',
            key: `plan:${planNumber}`,
            value: request.body ?? '',
          }],
          events: [{ type: 'test.plan.prepared', payload: {} }],
        };
      },
    },
  } as unknown as PluginContext;
  const stem = '项目讨论-memory01';

  const prepared = await prepareMemoryFileImport(
    context,
    [
      memoryFile(`${stem}${AI_MEMORY_FILE_ORIGINAL_SUFFIX}`, originalText),
      memoryFile(`${stem}${AI_MEMORY_FILE_INDEX_SUFFIX}`, indexText),
    ],
    {},
    new AbortController().signal,
    () => undefined,
    async () => undefined,
  );

  assert.equal(prepared.count, 1);
  assert.equal(requests.length, 2);
  const namespaces = new Set(prepared.patches.map((patch) => patch.namespace));
  assert.equal(namespaces.has(AI_SESSION_NAMESPACE), true);
  assert.equal(namespaces.has(AI_TRANSCRIPT_NAMESPACE), true);
  assert.equal(namespaces.has(AI_MEMORY_NAMESPACE), true);
  assert.equal(prepared.events.some((event) => event.type === 'ai.memory.updated'), true);
});

test('AI memory TXT import rejects already-linked file stems', async () => {
  const stem = '已关联-memory01';
  const files = [
    memoryFile(`${stem}${AI_MEMORY_FILE_ORIGINAL_SUFFIX}`, '原文'),
    memoryFile(`${stem}${AI_MEMORY_FILE_INDEX_SUFFIX}`, '索引'),
  ];
  await assert.rejects(
    () => prepareMemoryFileImport(
      {} as PluginContext,
      files,
      {
        existing: {
          sessionId: 'session:1',
          sourceId: 'existing',
          title: '已关联',
          schemaVersion: 2,
          sourceRevision: 1,
          sourceLength: 2,
          summary: '',
          keywords: [],
          anchors: [],
          createdAt: 1,
          localFileStem: stem,
        },
      },
      new AbortController().signal,
      () => undefined,
      async () => undefined,
    ),
    /已经关联/u,
  );
});
