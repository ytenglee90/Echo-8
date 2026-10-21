import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  AIGenerateRequest,
  AIGenerateStream,
  AIGenerateStreamEvent,
} from '../src/protocols/ai.ts';
import {
  consumeAIGenerationStream,
  continuationRequest,
  inferLengthTermination,
  mergeContinuedGeneration,
} from '../src/plugins/ai-assistant/generation-runtime.ts';
import { defaultOutputTokenBudget } from '../src/plugins/ai-assistant/generation-request.ts';
import { operationCreatesWriteback } from '../src/plugins/ai-assistant/operations.ts';
import { EmbeddedReasoningStream } from '../src/plugins/ai-provider/reasoning-stream.ts';

function stream(events: AIGenerateStreamEvent[]): AIGenerateStream {
  return {
    provider: 'test-provider',
    model: 'test-model',
    events: (async function* () {
      for (const event of events) yield event;
    })(),
  };
}

test('AI generation runtime keeps reasoning separate and preserves ordered delta metadata', async () => {
  const deltas: Array<{ delta: string; channel: 'answer' | 'reasoning'; sequence: number }> = [];
  const progress: number[] = [];
  const result = await consumeAIGenerationStream(
    stream([
      { type: 'delta', delta: '分析', channel: 'reasoning' },
      { type: 'delta', delta: '结论', channel: 'answer' },
      { type: 'delta', delta: '完成' },
      { type: 'complete', usage: { inputTokens: 8, outputTokens: 4 } },
    ]),
    new AbortController().signal,
    {
      onDelta: (event) => deltas.push(event),
      report: (value) => progress.push(value),
    },
  );

  assert.equal(result.text, '结论完成');
  assert.equal(result.reasoning, '分析');
  assert.deepEqual(result.usage, { inputTokens: 8, outputTokens: 4 });
  assert.deepEqual(deltas.map((item) => [item.sequence, item.channel]), [
    [1, 'reasoning'],
    [2, 'answer'],
    [3, 'answer'],
  ]);
  assert.equal(progress.every((value) => value >= 0.1 && value <= 0.95), true);
});

test('AI generation runtime preserves the provider finish reason for completeness control', async () => {
  const result = await consumeAIGenerationStream(
    stream([
      { type: 'delta', delta: '未完答案', channel: 'answer' },
      { type: 'complete', finishReason: 'length' },
    ]),
    new AbortController().signal,
    { onDelta: () => undefined, report: () => undefined },
  );
  assert.equal(result.finishReason, 'length');
});

test('AI generation runtime assembles a streamed local-tool request without publishing it as an answer', async () => {
  const deltas: string[] = [];
  const result = await consumeAIGenerationStream(
    stream([
      { type: 'tool-call', index: 0, id: 'call:memory', name: 'search_memory', argumentsDelta: '{"query":"' },
      { type: 'tool-call', index: 0, argumentsDelta: '发布窗口"}' },
      { type: 'complete', finishReason: 'tool-calls' },
    ]),
    new AbortController().signal,
    { onDelta: (event) => deltas.push(event.delta), report: () => undefined },
  );
  assert.equal(result.text, '');
  assert.equal(result.finishReason, 'tool-calls');
  assert.deepEqual(result.toolCalls, [{
    id: 'call:memory', name: 'search_memory', arguments: '{"query":"发布窗口"}',
  }]);
  assert.deepEqual(deltas, []);
});

test('AI continuation requests resume a truncated answer and merge without repeated overlap', () => {
  const request: AIGenerateRequest = {
    messages: [{ role: 'user', content: '请给出完整方案' }],
    temperature: 0.8,
    maxOutputTokens: 1_200,
    tools: [{
      type: 'function',
      function: { name: 'search_memory', description: '只读', parameters: { type: 'object' } },
    }],
  };
  const next = continuationRequest(request, '第一部分，这里是一段需要衔接的完整内容');
  assert.equal(next.temperature, 0.35);
  assert.equal(next.maxOutputTokens, 2_400);
  assert.equal(next.tools, undefined);
  assert.deepEqual(next.messages.at(-2), { role: 'assistant', content: '第一部分，这里是一段需要衔接的完整内容' });
  assert.match(next.messages.at(-1)?.content ?? '', /只从中断处继续/u);

  const merged = mergeContinuedGeneration(
    {
      text: '第一部分，这里是一段需要衔接的完整内容',
      reasoning: '第一次核对',
      provider: 'provider',
      model: 'model',
      finishReason: 'length',
      usage: { inputTokens: 8, outputTokens: 12 },
    },
    {
      text: '这里是一段需要衔接的完整内容，第二部分完成',
      provider: 'provider',
      model: 'model',
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 14 },
    },
  );
  assert.equal(merged.text, '第一部分，这里是一段需要衔接的完整内容，第二部分完成');
  assert.equal(merged.finishReason, 'stop');
  assert.deepEqual(merged.usage, { inputTokens: 18, outputTokens: 26 });
});

test('AI generation runtime refuses to publish reasoning-only output as the answer', async () => {
  await assert.rejects(
    () => consumeAIGenerationStream(
      stream([
        { type: 'delta', delta: '内部思考，不是最终答案', channel: 'reasoning' },
        { type: 'complete' },
      ]),
      new AbortController().signal,
      { onDelta: () => undefined, report: () => undefined },
    ),
    /只返回了思考过程/u,
  );
});

test('embedded streamed think tags are separated even when a tag crosses chunks', () => {
  const splitter = new EmbeddedReasoningStream();
  const events = [
    ...splitter.push('<thi'),
    ...splitter.push('nk>核对事实</think>结'),
    ...splitter.push('论'),
    ...splitter.flush(),
  ];
  assert.equal(events.filter((event) => event.channel === 'reasoning').map((event) => event.delta).join(''), '核对事实');
  assert.equal(events.filter((event) => event.channel === 'answer').map((event) => event.delta).join(''), '结论');
});

test('default AI output budgets keep simple answers short and preserve explicit long-form work', () => {
  assert.equal(defaultOutputTokenBudget({ operation: 'general', prompt: '这个功能是什么？', sources: [] }), 2_400);
  assert.equal(defaultOutputTokenBudget({ operation: 'analyze', prompt: '分析这项方案', sources: [] }), 4_096);
  assert.equal(defaultOutputTokenBudget({ operation: 'general', prompt: '请全面逐项分析并给出完整报告', sources: [] }), 8_192);
});

test('AI generation runtime infers length truncation for compatible providers that omit finish_reason', () => {
  const inferred = inferLengthTermination({
    text: '未完',
    provider: 'provider',
    model: 'model',
    usage: { outputTokens: 1_195 },
  }, { maxOutputTokens: 1_200 });
  assert.equal(inferred.finishReason, 'length');
  const complete = inferLengthTermination({
    text: '完整',
    provider: 'provider',
    model: 'model',
    usage: { outputTokens: 900 },
  }, { maxOutputTokens: 1_200 });
  assert.equal(complete.finishReason, undefined);
});

test('AI generation runtime rejects empty and cancelled streams without manufacturing content', async () => {
  await assert.rejects(
    () => consumeAIGenerationStream(
      stream([{ type: 'complete' }]),
      new AbortController().signal,
      { onDelta: () => undefined, report: () => undefined },
    ),
    /空内容/u,
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => consumeAIGenerationStream(
      stream([{ type: 'delta', delta: '不应提交' }]),
      controller.signal,
      { onDelta: () => undefined, report: () => undefined },
    ),
    (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
  );
});

test('only direct editing operations enter the revision-checked write-back proposal path', () => {
  assert.equal(operationCreatesWriteback('polish'), true);
  assert.equal(operationCreatesWriteback('translate'), true);
  assert.equal(operationCreatesWriteback('summarize'), false);
  assert.equal(operationCreatesWriteback('general'), false);
});
