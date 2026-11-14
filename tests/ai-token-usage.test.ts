import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateTokenUsage, formatTokenUsage, normalizeTokenUsage, withTokenUsageEstimates } from '../src/services/ai-token-usage.ts';
import { buildProviderRequest, fetchWithInitialRetry, parseCompletion, parseGeminiCompletion, readCompletionEvents } from '../src/plugins/ai-provider/provider-transport.ts';

test('OpenAI-compatible wire turns serialize parallel tool calls and match their results by provider field names', () => {
  const profile = { ...applyAIProviderPreset('deepseek')!, id: 'test', model: 'deepseek-flash' };
  const messages = [
    { role: 'user' as const, content: '武器卡内设计武器内容' },
    { role: 'assistant' as const, content: '', toolCalls: [{ id: 'call-state', name: 'query_canvas', arguments: '{"mode":"state"}' },
      { id: 'call-body', name: 'read_canvas', arguments: '{"id":"node:fixture"}' }] },
    { role: 'tool' as const, content: '目录', toolCallId: 'call-state' }, { role: 'tool' as const, content: '原文', toolCallId: 'call-body' },
  ];
  const wire = buildProviderRequest(profile, 'fake', { messages, temperature: 0.2, maxOutputTokens: 1024, canvasAgentTransport: 'native' }, true);
  const body = JSON.parse(String(wire.init.body));
  assert.deepEqual(body.messages.slice(1), [
    { role: 'assistant', content: null, tool_calls: [{ id: 'call-state', type: 'function', function: { name: 'query_canvas', arguments: '{"mode":"state"}' } },
      { id: 'call-body', type: 'function', function: { name: 'read_canvas', arguments: '{"id":"node:fixture"}' } }] },
    { role: 'tool', content: '目录', tool_call_id: 'call-state' }, { role: 'tool', content: '原文', tool_call_id: 'call-body' },
  ]);
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.tool_choice, undefined);
  const ordinary = buildProviderRequest(profile, 'fake', { messages: [messages[0]!], temperature: 0.2, maxOutputTokens: 1024 }, false);
  assert.equal(JSON.parse(String(ordinary.init.body)).thinking, undefined);
});
import { applyAIProviderPreset } from '../src/plugins/ai-provider/presets.ts';
import { parseTranscriptMessages } from '../src/plugins/ai-assistant/transcript-presentation.ts';

test('every provider gets both counts, preserves actual zero and labels only missing counts as estimates', () => {
  assert.deepEqual(withTokenUsageEstimates({ inputTokens: 0, outputTokens: 12 }, 99, 88), { inputTokens: 0, outputTokens: 12 });
  assert.deepEqual(withTokenUsageEstimates({ inputTokens: 10 }, 99, 88), { inputTokens: 10, outputTokens: 88, outputEstimated: true });
  const estimated = withTokenUsageEstimates(undefined, 1234, 56);
  assert.equal(formatTokenUsage(estimated), '本轮 Token：输入 1,234（估算） · 输出 56（估算）');
  assert.equal(normalizeTokenUsage({ inputTokens: -1, outputTokens: NaN }), undefined);
});

test('round totals add requests exactly once and preserve mixed actual and estimated provenance', () => {
  const combined = aggregateTokenUsage([
    withTokenUsageEstimates({ inputTokens: 100, outputTokens: 20 }, 1, 1),
    withTokenUsageEstimates({ inputTokens: 200 }, 1, 30),
  ]);
  assert.deepEqual(combined, { inputTokens: 300, outputTokens: 50, outputEstimated: true });
  assert.equal(formatTokenUsage(combined), '本轮 Token：输入 300 · 输出 50（估算）');
});

test('provider parsing accepts compatible usage aliases and counts Gemini thinking and tool input separately once', () => {
  assert.deepEqual(parseCompletion({ choices: [{ message: { content: '回答' } }], usage: { input_tokens: 7, output_tokens: 3 } }).usage, { inputTokens: 7, outputTokens: 3 });
  assert.deepEqual(parseGeminiCompletion({ candidates: [{ content: { parts: [{ text: '回答' }] } }], usageMetadata: {
    promptTokenCount: 100, toolUsePromptTokenCount: 5, candidatesTokenCount: 40, thoughtsTokenCount: 10,
  } }).usage, { inputTokens: 105, outputTokens: 50, reasoningTokens: 10 });
});

test('OpenAI-style streams request final usage and retain the usage-only terminal chunk', async () => {
  const request = buildProviderRequest({ ...applyAIProviderPreset('openai')!, id: 'test' }, 'fake', { messages: [{ role: 'user', content: 'hello' }], temperature: 0.2, maxOutputTokens: 1024 }, true);
  assert.deepEqual((JSON.parse(request.init.body as string) as { stream_options: unknown }).stream_options, { include_usage: true });
  const response = new Response('data: {"choices":[{"delta":{"content":"回答"},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":1234,"completion_tokens":56}}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  const events = []; for await (const event of readCompletionEvents(response, () => undefined, 'openai')) events.push(event);
  assert.deepEqual(events.at(-1), { type: 'complete', usage: { inputTokens: 1234, outputTokens: 56 }, finishReason: 'stop' });
});

test('a provider rejecting only stream usage options gets one compatible retry without mutating the original request', async () => {
  const original = { model: 'custom-model', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'hello' }] };
  const bodies: Record<string, unknown>[] = [];
  const response = await fetchWithInitialRetry(async (_url, init) => {
    bodies.push(JSON.parse(init!.body as string) as Record<string, unknown>);
    return bodies.length === 1 ? new Response(JSON.stringify({ error: { message: 'Unsupported parameter: stream_options' } }), { status: 400 }) : new Response('ok');
  }, 'https://custom.test/chat/completions', { method: 'POST', body: JSON.stringify(original) }, new AbortController().signal);
  assert.equal(response.status, 200); assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0], original);
  assert.deepEqual(bodies[1], { model: original.model, stream: true, messages: original.messages });
});

test('usage belongs to its assistant turn while old replies receive visibly estimated fallback counts', () => {
  const text = '[用户]\n问题一\n\n[助手]\n回答一\n\n[用户]\n问题二\n\n[助手]\n回答二';
  const messages = parseTranscriptMessages(text, 4, new Map([[2, { usage: { inputTokens: 100, outputTokens: 20 } }]]));
  assert.equal(messages[0].usage, undefined);
  assert.deepEqual(messages[1].usage, { inputTokens: 100, outputTokens: 20 });
  assert.equal(messages[3].usage?.inputEstimated, true);
  assert.equal(messages[3].usage?.outputEstimated, true);
  assert.ok(messages[3].usage!.inputTokens! > 0);
});
