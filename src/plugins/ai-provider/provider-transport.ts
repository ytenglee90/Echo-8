import { isRecord } from '../../core/contracts.ts';
import type {
  AIGenerateRequest,
  AIGenerateResult,
  AIGenerateStreamEvent,
  AIFinishReason,
  AIChatToolCall,
} from '../../protocols/ai.ts';
import type { AIProviderPreferences, AIProviderProfile } from './types.ts';
import { EmbeddedReasoningStream } from './reasoning-stream.ts';

const MAX_AI_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_AI_STREAM_LINE_CHARACTERS = 1024 * 1024;
const MAX_AI_SSE_EVENT_CHARACTERS = 2 * 1024 * 1024;

export function validateGenerateRequest(input: AIGenerateRequest): void {
  if (!input || !Array.isArray(input.messages) || input.messages.length < 1 || input.messages.length > 64 ||
    input.messages.some((message) => !isValidChatMessage(message)) ||
    (input.providerId !== undefined && (typeof input.providerId !== 'string' || input.providerId.length > 200)) ||
    (input.webSearch !== undefined && typeof input.webSearch !== 'boolean') ||
    (input.tools !== undefined && (!Array.isArray(input.tools) || input.tools.length > 4 ||
      input.tools.some((tool) => !isValidToolDefinition(tool)))) ||
    !Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2 ||
    !Number.isInteger(input.maxOutputTokens) || input.maxOutputTokens < 64 || input.maxOutputTokens > 16_384) {
    throw new Error('AI 生成请求格式不正确');
  }
}

function isValidChatMessage(value: unknown): value is AIGenerateRequest['messages'][number] {
  if (!isRecord(value) || !['system', 'user', 'assistant', 'tool'].includes(String(value.role)) ||
    typeof value.content !== 'string' || value.content.length > 200_000) return false;
  const toolCallId = value.toolCallId;
  if (toolCallId !== undefined && (typeof toolCallId !== 'string' || toolCallId.length < 1 || toolCallId.length > 240)) {
    return false;
  }
  if (value.role === 'tool' && !toolCallId) return false;
  if (value.role !== 'tool' && toolCallId !== undefined) return false;
  if (value.toolCalls === undefined) return true;
  return value.role === 'assistant' && Array.isArray(value.toolCalls) && value.toolCalls.length > 0 &&
    value.toolCalls.length <= 4 && value.toolCalls.every(isValidToolCall);
}

function isValidToolCall(value: unknown): value is AIChatToolCall {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 240 &&
    typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 120 &&
    typeof value.arguments === 'string' && value.arguments.length <= 8_000;
}

function isValidToolDefinition(value: unknown): boolean {
  return isRecord(value) && value.type === 'function' && isRecord(value.function) &&
    typeof value.function.name === 'string' && value.function.name.length > 0 && value.function.name.length <= 120 &&
    typeof value.function.description === 'string' && value.function.description.length <= 2_000 &&
    isRecord(value.function.parameters);
}

function resolveEndpoint(endpoint: string): string {
  return new URL(endpoint, typeof location === 'undefined' ? 'http://localhost' : location.origin).toString();
}

export function buildProviderRequest(
  profile: AIProviderProfile,
  apiKey: string,
  input: AIGenerateRequest,
  stream: boolean,
): { endpoint: string; init: RequestInit } {
  const webSearchMode = resolveWebSearchMode(profile);
  if (input.webSearch && webSearchMode === 'unsupported') {
    throw new Error('当前模型连接没有 Echo-8 已验证的原生联网搜索；请关闭联网，或改用 Gemini、通义千问，或 OpenAI 联网搜索模型');
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: stream ? 'text/event-stream, application/x-ndjson, application/json' : 'application/json',
  };
  if (profile.authentication === 'bearer') headers.Authorization = `Bearer ${apiKey}`;
  if (profile.authentication === 'api-key') headers['x-goog-api-key'] = apiKey;
  if (profile.apiStyle === 'gemini') {
    if (input.tools?.length) {
      throw new Error('当前 Gemini 原生连接暂不支持 Echo-8 的本地记忆工具；已继续使用常规记忆检索');
    }
    const systemText = input.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');
    return {
      endpoint: resolveGeminiEndpoint(profile.endpoint, profile.model, stream),
      init: {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
          contents: input.messages
            .filter((message) => message.role !== 'system')
            .map((message) => ({
              role: message.role === 'assistant' ? 'model' : 'user',
              parts: [{ text: message.content }],
            })),
          generationConfig: {
            temperature: input.temperature,
            maxOutputTokens: input.maxOutputTokens,
          },
          ...(input.webSearch ? { tools: [{ google_search: {} }] } : {}),
        }),
      },
    };
  }
  return {
    endpoint: resolveEndpoint(profile.endpoint),
    init: {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: profile.model,
        messages: input.messages,
        temperature: input.temperature,
        max_tokens: input.maxOutputTokens,
        ...(input.webSearch && webSearchMode === 'qwen' ? { enable_search: true } : {}),
        ...(input.webSearch && webSearchMode === 'openai-web-search'
          ? { web_search_options: { search_context_size: 'medium' } }
          : {}),
        ...(input.tools?.length ? { tools: input.tools, tool_choice: 'auto' } : {}),
        ...(stream ? { stream: true } : {}),
      }),
    },
  };
}

type WebSearchMode = 'gemini' | 'qwen' | 'openai-web-search' | 'unsupported';

function resolveWebSearchMode(profile: AIProviderProfile): WebSearchMode {
  if (profile.apiStyle === 'gemini') return 'gemini';
  let hostname: string;
  try {
    hostname = new URL(resolveEndpoint(profile.endpoint)).hostname.toLocaleLowerCase();
  } catch {
    return 'unsupported';
  }
  const model = profile.model.toLocaleLowerCase();
  if (hostname === 'dashscope.aliyuncs.com' || hostname.endsWith('.maas.aliyuncs.com')) {
    return 'qwen';
  }
  if (hostname === 'api.openai.com' && model === 'gpt-5-search-api') {
    return 'openai-web-search';
  }
  return 'unsupported';
}

export function webSearchCatalogFields(profile: AIProviderProfile): {
  webSearchSupported: boolean;
  webSearchLabel?: string;
} {
  const mode = resolveWebSearchMode(profile);
  if (mode === 'gemini') return { webSearchSupported: true, webSearchLabel: 'Google Search' };
  if (mode === 'qwen') return { webSearchSupported: true, webSearchLabel: '百炼联网搜索' };
  if (mode === 'openai-web-search') return { webSearchSupported: true, webSearchLabel: 'OpenAI Web Search' };
  return { webSearchSupported: false };
}

function resolveGeminiEndpoint(endpoint: string, model: string, stream: boolean): string {
  const url = new URL(resolveEndpoint(endpoint));
  const method = stream ? ':streamGenerateContent' : ':generateContent';
  if (/:generateContent$|:streamGenerateContent$/u.test(url.pathname)) {
    url.pathname = url.pathname.replace(/:(?:stream)?generateContent$/u, method);
  } else if (/\/models\/[^/]+$/u.test(url.pathname)) {
    url.pathname = `${url.pathname}${method}`;
  } else {
    const prefix = url.pathname.replace(/\/$/u, '');
    const versioned = /\/v1(?:beta)?$/u.test(prefix) ? prefix : `${prefix}/v1beta`;
    url.pathname = `${versioned}/models/${encodeURIComponent(model)}${method}`;
  }
  if (stream) url.searchParams.set('alt', 'sse');
  return url.toString();
}

export async function fetchWithInitialRetry(
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  endpoint: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetcher(endpoint, init);
      if (response.ok) return response;
      if (attempt === 0 && [408, 425, 429, 500, 502, 503, 504].includes(response.status)) {
        await abortableDelay(450, signal);
        continue;
      }
      throw new Error(await describeProviderHttpError(response));
    } catch (error) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      lastError = error;
      if (attempt === 0 && error instanceof TypeError) {
        await abortableDelay(450, signal);
        continue;
      }
      break;
    }
  }
  if (lastError instanceof TypeError) {
    throw new Error('无法连接模型服务：请检查接口地址、网络，以及平台是否允许浏览器跨域访问');
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function describeProviderHttpError(response: Response): Promise<string> {
  const prefix = `模型服务返回 HTTP ${response.status}`;
  if (!response.body) return prefix;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 64 * 1024) return prefix;
      parts.push(decoder.decode(chunk.value, { stream: true }));
    }
    parts.push(decoder.decode());
  } catch {
    return prefix;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const body = parts.join('').trim();
  if (!body) return prefix;
  let detail: string | undefined;
  try {
    detail = providerErrorMessage(JSON.parse(body) as unknown);
  } catch {
    const compact = body.replace(/\s+/gu, ' ').trim();
    if (compact && !/[<>]/u.test(compact)) detail = compact;
  }
  return detail ? `${prefix}：${detail.slice(0, 500)}` : prefix;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}

export function parseCompletion(payload: unknown): Omit<AIGenerateResult, 'provider' | 'model'> {
  const providerError = providerErrorMessage(payload);
  if (providerError) throw new Error(providerError);
  if (!isRecord(payload) || !Array.isArray(payload.choices) || !isRecord(payload.choices[0]) ||
    !isRecord(payload.choices[0].message)) {
    throw new Error('模型响应格式不是兼容的 Chat Completions 结构');
  }
  const message = payload.choices[0].message;
  const content = readMessageText(message.content);
  const separated = separateReasoning(
    content,
    readReasoningText(message),
  );
  const finalized = finalizeReasonedContent(separated);
  const text = finalized.text;
  const toolCalls = readToolCalls(message.tool_calls);
  if (!text && toolCalls.length === 0) {
    if (finalized.reasoning) throw new Error('模型只返回了思考过程，没有返回最终答案；请重试或降低模型思考强度');
    throw new Error('模型返回了空内容');
  }
  if (text.length > 100_000) throw new Error('模型返回内容超过当前提案上限');
  const usage = isRecord(payload.usage)
    ? {
        inputTokens: typeof payload.usage.prompt_tokens === 'number' ? payload.usage.prompt_tokens : undefined,
        outputTokens: typeof payload.usage.completion_tokens === 'number' ? payload.usage.completion_tokens : undefined,
      }
    : undefined;
  const finishReason = normalizeFinishReason(payload.choices[0].finish_reason);
  return {
    text,
    ...(finalized.reasoning ? { reasoning: finalized.reasoning } : {}),
    usage,
    ...(finishReason ? { finishReason } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

export function parseGeminiCompletion(payload: unknown): Omit<AIGenerateResult, 'provider' | 'model'> {
  const finalized = finalizeReasonedContent(geminiContent(payload));
  const text = finalized.text;
  if (!text) {
    if (finalized.reasoning) throw new Error('Gemini 只返回了思考过程，没有返回最终答案；请重试');
    throw new Error('Gemini 返回了空内容或响应格式不正确');
  }
  if (text.length > 100_000) throw new Error('模型返回内容超过当前提案上限');
  const usageRecord = isRecord(payload) && isRecord(payload.usageMetadata) ? payload.usageMetadata : undefined;
  const candidate = isRecord(payload) && Array.isArray(payload.candidates)
    ? payload.candidates.find(isRecord)
    : undefined;
  const finishReason = normalizeFinishReason(candidate?.finishReason);
  return {
    text,
    ...(finalized.reasoning ? { reasoning: finalized.reasoning } : {}),
    usage: usageRecord ? {
      inputTokens: typeof usageRecord.promptTokenCount === 'number' ? usageRecord.promptTokenCount : undefined,
      outputTokens: typeof usageRecord.candidatesTokenCount === 'number' ? usageRecord.candidatesTokenCount : undefined,
    } : undefined,
    ...(finishReason ? { finishReason } : {}),
  };
}

export async function* readCompletionEvents(
  response: Response,
  release: () => void,
  apiStyle: AIProviderPreferences['apiStyle'],
): AsyncGenerator<AIGenerateStreamEvent> {
  try {
    const contentType = response.headers.get('content-type')?.toLocaleLowerCase() ?? '';
    await assertResponseSize(response);
    if (contentType.includes('application/json') && !contentType.includes('ndjson')) {
      const parsed = apiStyle === 'gemini'
        ? parseGeminiCompletion(await readLimitedJson(response))
        : parseCompletion(await readLimitedJson(response));
      if (parsed.reasoning) yield { type: 'delta', channel: 'reasoning', delta: parsed.reasoning };
      if (parsed.text) yield { type: 'delta', channel: 'answer', delta: parsed.text };
      for (const [index, call] of (parsed.toolCalls ?? []).entries()) {
        yield {
          type: 'tool-call', index, id: call.id, name: call.name, argumentsDelta: call.arguments,
        };
      }
      yield { type: 'complete', usage: parsed.usage, finishReason: parsed.finishReason };
      return;
    }
    if (!response.body) throw new Error('模型流式响应没有可读取的正文');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const sse = contentType.includes('text/event-stream');
    let buffer = '';
    let eventData: string[] = [];
    let eventDataCharacters = 0;
    let emittedCharacters = 0;
    let emittedToolFragments = 0;
    let usage: AIGenerateResult['usage'];
    let finishReason: AIFinishReason | undefined;
    let completed = false;
    let responseBytes = 0;
    const embeddedReasoning = new EmbeddedReasoningStream();

    const parseData = (raw: string): AIGenerateStreamEvent[] => {
      const data = raw.trim();
      if (!data) return [];
      if (data === '[DONE]') {
        completed = true;
        return [];
      }
      let payload: unknown;
      try {
        payload = JSON.parse(data);
      } catch {
        throw new Error('模型流式响应包含无法解析的数据');
      }
      const parsed = parseStreamPayload(payload, apiStyle);
      if (parsed.usage) usage = parsed.usage;
      if (parsed.finishReason) finishReason = parsed.finishReason;
      const rawDeltas: AIGenerateStreamEvent[] = [
        ...(parsed.reasoningDelta ? [{ type: 'delta' as const, channel: 'reasoning' as const, delta: parsed.reasoningDelta }] : []),
        ...(parsed.answerDelta ? [{ type: 'delta' as const, channel: 'answer' as const, delta: parsed.answerDelta }] : []),
        ...(parsed.toolCallDeltas ?? []).map((toolCall) => ({ type: 'tool-call' as const, ...toolCall })),
      ];
      const deltas: AIGenerateStreamEvent[] = rawDeltas.flatMap((event): AIGenerateStreamEvent[] => {
        if (event.type !== 'delta' || event.channel !== 'answer') return [event];
        return embeddedReasoning.push(event.delta).map((item): AIGenerateStreamEvent => ({
          type: 'delta', channel: item.channel, delta: item.delta,
        }));
      });
      if (deltas.length === 0) return [];
      emittedCharacters += deltas.reduce((total, item) => total +
        (item.type === 'delta' ? item.delta.length : 0), 0);
      emittedToolFragments += deltas.filter((item) => item.type === 'tool-call').length;
      if (emittedCharacters > 100_000) throw new Error('模型返回内容超过当前提案上限');
      return deltas;
    };

    const flushLine = (line: string): AIGenerateStreamEvent[] => {
      if (!sse) return parseData(line);
      if (line === '') {
        const events = parseData(eventData.join('\n'));
        eventData = [];
        eventDataCharacters = 0;
        return events;
      }
      if (line.startsWith('data:')) {
        const data = line.slice(5).trimStart();
        eventData.push(data);
        eventDataCharacters += data.length;
        if (eventDataCharacters > MAX_AI_SSE_EVENT_CHARACTERS) {
          throw new Error('模型流式响应的单个事件超过安全上限');
        }
      }
      return [];
    };

    try {
      while (!completed) {
        const chunk = await reader.read();
        if (chunk.done) break;
        responseBytes += chunk.value.byteLength;
        if (responseBytes > MAX_AI_RESPONSE_BYTES) throw new Error('模型响应体超过 8 MB 安全上限');
        buffer += decoder.decode(chunk.value, { stream: true });
        if (buffer.length > MAX_AI_STREAM_LINE_CHARACTERS && !buffer.includes('\n')) {
          throw new Error('模型流式响应的单行数据超过安全上限');
        }
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/u, '');
          if (line.length > MAX_AI_STREAM_LINE_CHARACTERS) {
            throw new Error('模型流式响应的单行数据超过安全上限');
          }
          buffer = buffer.slice(newline + 1);
          for (const event of flushLine(line)) yield event;
          if (completed) break;
          newline = buffer.indexOf('\n');
        }
      }
      buffer += decoder.decode();
      if (buffer.length > MAX_AI_STREAM_LINE_CHARACTERS) {
        throw new Error('模型流式响应的单行数据超过安全上限');
      }
      if (!completed && buffer) {
        for (const event of flushLine(buffer.replace(/\r$/u, ''))) yield event;
      }
      if (!completed && sse && eventData.length > 0) {
        for (const event of parseData(eventData.join('\n'))) yield event;
      }
      const finalDeltas = embeddedReasoning.flush();
      emittedCharacters += finalDeltas.reduce((total, item) => total + item.delta.length, 0);
      if (emittedCharacters > 100_000) throw new Error('模型返回内容超过当前提案上限');
      for (const event of finalDeltas) yield event;
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    if (emittedCharacters === 0 && emittedToolFragments === 0) throw new Error('模型返回了空内容');
    yield { type: 'complete', usage, finishReason };
  } finally {
    release();
  }
}

async function assertResponseSize(response: Response): Promise<void> {
  const raw = response.headers.get('content-length');
  if (!raw) return;
  const length = Number(raw);
  if (Number.isFinite(length) && length > MAX_AI_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('模型响应体超过 8 MB 安全上限');
  }
}

export async function readLimitedJson(response: Response): Promise<unknown> {
  await assertResponseSize(response);
  if (!response.body) throw new Error('模型响应没有可读取的正文');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_AI_RESPONSE_BYTES) throw new Error('模型响应体超过 8 MB 安全上限');
      parts.push(decoder.decode(chunk.value, { stream: true }));
    }
    parts.push(decoder.decode());
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  try {
    return JSON.parse(parts.join('')) as unknown;
  } catch {
    throw new Error('模型响应不是有效的 JSON');
  }
}

function parseStreamPayload(
  payload: unknown,
  apiStyle: AIProviderPreferences['apiStyle'],
): {
  answerDelta?: string;
  reasoningDelta?: string;
  toolCallDeltas?: Array<{
    index: number;
    id?: string;
    name?: string;
    argumentsDelta?: string;
  }>;
  usage?: AIGenerateResult['usage'];
  finishReason?: AIFinishReason;
} {
  if (!isRecord(payload)) throw new Error('模型流式响应格式不正确');
  const providerError = providerErrorMessage(payload);
  if (providerError) throw new Error(providerError);
  if (apiStyle === 'gemini') return parseGeminiStreamPayload(payload);
  const choice = Array.isArray(payload.choices) && isRecord(payload.choices[0])
    ? payload.choices[0]
    : undefined;
  const deltaRecord = choice && isRecord(choice.delta) ? choice.delta : undefined;
  const answerDelta = typeof deltaRecord?.content === 'string'
    ? deltaRecord.content
    : typeof choice?.text === 'string'
      ? choice.text
      : undefined;
  const reasoningDelta = typeof deltaRecord?.reasoning_content === 'string'
    ? deltaRecord.reasoning_content
    : typeof deltaRecord?.reasoning === 'string'
      ? deltaRecord.reasoning
      : undefined;
  const toolCallDeltas = readToolCallDeltas(deltaRecord?.tool_calls);
  const usage = isRecord(payload.usage)
    ? {
        inputTokens: typeof payload.usage.prompt_tokens === 'number' ? payload.usage.prompt_tokens : undefined,
        outputTokens: typeof payload.usage.completion_tokens === 'number' ? payload.usage.completion_tokens : undefined,
      }
    : undefined;
  return {
    answerDelta,
    reasoningDelta,
    ...(toolCallDeltas.length > 0 ? { toolCallDeltas } : {}),
    usage,
    finishReason: normalizeFinishReason(choice?.finish_reason),
  };
}

function providerErrorMessage(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const error = payload.error;
  if (typeof error === 'string' && error.trim()) return error.trim().slice(0, 500);
  if (!isRecord(error)) return undefined;
  const message = [error.message, error.detail, error.code]
    .find((value) => typeof value === 'string' && value.trim());
  return typeof message === 'string' ? message.trim().slice(0, 500) : undefined;
}

function readToolCalls(value: unknown): AIChatToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: AIChatToolCall[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== 'string' || !isRecord(item.function) ||
      typeof item.function.name !== 'string' || typeof item.function.arguments !== 'string') continue;
    const call = { id: item.id, name: item.function.name, arguments: item.function.arguments };
    if (isValidToolCall(call)) calls.push(call);
  }
  return calls.slice(0, 4);
}

function readToolCallDeltas(value: unknown): Array<{
  index: number;
  id?: string;
  name?: string;
  argumentsDelta?: string;
}> {
  if (!Array.isArray(value)) return [];
  const deltas: Array<{ index: number; id?: string; name?: string; argumentsDelta?: string }> = [];
  for (const item of value) {
    if (!isRecord(item) || !Number.isInteger(item.index) || Number(item.index) < 0 || Number(item.index) >= 4) continue;
    const fn = isRecord(item.function) ? item.function : undefined;
    const id = typeof item.id === 'string' && item.id.length <= 240 ? item.id : undefined;
    const name = typeof fn?.name === 'string' && fn.name.length <= 120 ? fn.name : undefined;
    const argumentsDelta = typeof fn?.arguments === 'string' && fn.arguments.length <= 8_000
      ? fn.arguments
      : undefined;
    if (id || name || argumentsDelta) deltas.push({ index: Number(item.index), id, name, argumentsDelta });
  }
  return deltas;
}

function parseGeminiStreamPayload(payload: Record<string, unknown>): {
  answerDelta?: string;
  reasoningDelta?: string;
  usage?: AIGenerateResult['usage'];
  finishReason?: AIFinishReason;
} {
  const usageRecord = isRecord(payload.usageMetadata) ? payload.usageMetadata : undefined;
  const candidate = Array.isArray(payload.candidates)
    ? payload.candidates.find(isRecord)
    : undefined;
  const content = geminiContent(payload);
  return {
    answerDelta: content.text || undefined,
    reasoningDelta: content.reasoning || undefined,
    usage: usageRecord ? {
      inputTokens: typeof usageRecord.promptTokenCount === 'number' ? usageRecord.promptTokenCount : undefined,
      outputTokens: typeof usageRecord.candidatesTokenCount === 'number' ? usageRecord.candidatesTokenCount : undefined,
    } : undefined,
    finishReason: normalizeFinishReason(candidate?.finishReason),
  };
}

function normalizeFinishReason(value: unknown): AIFinishReason | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const normalized = value.trim().toLocaleLowerCase();
  if (normalized === 'stop' || normalized === 'end_turn') return 'stop';
  if (normalized === 'length' || normalized === 'max_tokens' || normalized === 'max_output_tokens') {
    return 'length';
  }
  if (normalized.includes('safety') || normalized.includes('content_filter') || normalized === 'recitation') {
    return 'content-filter';
  }
  if (normalized.includes('tool')) return 'tool-calls';
  return 'other';
}

function geminiContent(payload: unknown): { text: string; reasoning: string } {
  if (!isRecord(payload) || !Array.isArray(payload.candidates)) return { text: '', reasoning: '' };
  const candidate = payload.candidates.find(isRecord);
  if (!candidate || !isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) {
    return { text: '', reasoning: '' };
  }
  const parts = candidate.content.parts.filter(isRecord);
  return {
    text: parts.filter((part) => part.thought !== true).map((part) => typeof part.text === 'string' ? part.text : '').join(''),
    reasoning: parts.filter((part) => part.thought === true).map((part) => typeof part.text === 'string' ? part.text : '').join(''),
  };
}

function separateReasoning(text: string, explicitReasoning?: string): { text: string; reasoning: string } {
  let answer = text;
  const embedded: string[] = [];
  answer = answer.replace(/<(?:think|analysis)>([\s\S]*?)<\/(?:think|analysis)>/giu, (_match, body: string) => {
    if (body.trim()) embedded.push(body.trim());
    return '';
  });
  return {
    text: answer.trim(),
    reasoning: [explicitReasoning?.trim() ?? '', ...embedded].filter(Boolean).join('\n\n'),
  };
}

function readMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(isRecord).map((part) => {
    if (typeof part.text === 'string') return part.text;
    if (isRecord(part.text) && typeof part.text.value === 'string') return part.text.value;
    return '';
  }).join('');
}

function readReasoningText(message: Record<string, unknown>): string | undefined {
  const direct = [message.reasoning_content, message.reasoning]
    .find((value) => typeof value === 'string');
  if (typeof direct === 'string' && direct.trim()) return direct;
  if (!Array.isArray(message.reasoning_details)) return undefined;
  const text = message.reasoning_details.filter(isRecord).map((part) =>
    typeof part.text === 'string' ? part.text : typeof part.summary === 'string' ? part.summary : '').join('');
  return text || undefined;
}

function finalizeReasonedContent(content: { text: string; reasoning: string }): {
  text: string;
  reasoning: string;
} {
  const text = content.text.trim();
  const reasoning = content.reasoning.trim();
  return { text, reasoning };
}
