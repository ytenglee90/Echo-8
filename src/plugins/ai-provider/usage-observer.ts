import type { AIGenerateRequest, AIGenerateStreamEvent, AITokenUsage } from '../../protocols/ai.ts';
import type { AIUsageAttempt } from '../../protocols/ai-usage.ts';
import { providerTokenUsage } from './provider-transport.ts';
import { AIUsageLedger } from './usage-ledger.ts';

/** One record per actual HTTP attempt, including transport retries and aborted streams. */
export function observeProviderUsage(ledger: AIUsageLedger, request: AIGenerateRequest, provider: string, model: string,
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  let current: AIUsageAttempt | undefined;
  let attempts = 0;
  let receivedUsage: AITokenUsage | undefined;
  const finish = (status: 'complete' | 'failed' | 'cancelled', usage = receivedUsage, text?: string) => ledger.finish(current, status, usage, text);
  return {
    finish,
    receivedUsage: (usage: AITokenUsage | undefined) => { receivedUsage = usage; },
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      current = ledger.begin(request, provider, model, attempts++ > 0);
      receivedUsage = undefined;
      try {
        const response = await fetcher(input, init);
        if (!response.ok) {
          const failedAttempt = current;
          finish('failed');
          // Drain the error and inspection branches concurrently. Awaiting a
          // clone's cancellation before the transport drains its branch blocks tee().
          if (request.usageContext && Number(response.headers.get('content-length') ?? 0) <= 64 * 1024) {
            void readFailureUsage(response.clone()).then(usage => ledger.amendFailureUsage(failedAttempt, usage));
          }
        }
        return response;
      } catch (error) {
        finish(init?.signal?.aborted ? 'cancelled' : 'failed');
        throw error;
      }
    },
    events: async function* (source: AsyncIterable<AIGenerateStreamEvent>): AsyncIterable<AIGenerateStreamEvent> {
      let usage: AITokenUsage | undefined, output = '', complete = false, hasAnswer = false;
      try {
        for await (const event of source) {
          if (event.type === 'complete' && event.usage) usage = event.usage;
          if (event.type === 'delta') output += event.delta;
          if (event.type === 'delta' && event.channel !== 'reasoning' && event.delta.trim()) hasAnswer = true;
          if (event.type === 'tool-call') output += event.argumentsDelta ?? '';
          if (event.type === 'tool-call') hasAnswer = true;
          yield event;
        }
        complete = true;
        finish(hasAnswer ? 'complete' : 'failed', usage, output);
      } catch (error) {
        finish(error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'failed', usage);
        throw error;
      } finally {
        if (!complete) finish('cancelled', usage);
      }
    },
  };
}

async function readFailureUsage(response: Response): Promise<AITokenUsage | undefined> {
  if (!response.body) return undefined;
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let bytes = 0, text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 64 * 1024) return undefined;
      text += decoder.decode(chunk.value, { stream: true });
    }
    return providerTokenUsage(JSON.parse(text + decoder.decode()) as unknown);
  } catch { return undefined; }
  finally {
    // A tee sibling may still be draining in the transport; do not await it here.
    void reader.cancel().catch(() => undefined); reader.releaseLock();
  }
}
