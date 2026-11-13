import { createId } from '../../core/contracts.ts';
import type { AIRequestIdentity, AIRequestSnapshot } from '../../protocols/ai-request-inspection.ts';

/** Bounded current-open-session cache. Never enters document or preference storage. */
export class AIRequestTraceBuffer {
  private snapshots: AIRequestSnapshot[] = [];
  private characters = 0;
  clear(): void { this.snapshots = []; this.characters = 0; }
  read(identity: AIRequestIdentity): AIRequestSnapshot[] {
    return this.snapshots.filter(item => item.sessionId === identity.sessionId && item.userTurn === identity.userTurn)
      .map(item => ({ ...item, headers: { ...item.headers } }));
  }
  capture(identity: AIRequestIdentity | undefined, endpoint: string, init: RequestInit, apiKey: string): void {
    if (!identity) return;
    const hide = (value: string) => apiKey ? value.replaceAll(apiKey, '[密钥已隐藏]') : value;
    const url = new URL(endpoint);
    url.hash = '';
    if (url.username) url.username = 'REDACTED';
    if (url.password) url.password = 'REDACTED';
    for (const key of [...url.searchParams.keys()]) if (/key|token|secret|auth|signature|credential|password/iu.test(key)) url.searchParams.set(key, 'REDACTED');
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => { headers[key] = /authorization|key|cookie|token|secret/iu.test(key) ? '[密钥已隐藏]' : hide(value); });
    const rawBody = typeof init.body === 'string' ? init.body : '';
    const body = rawBody.length <= 1_000_000 ? hide(rawBody) : undefined;
    this.snapshots.push({ ...identity, id: createId('ai-request'), timestamp: Date.now(), endpoint: hide(url.toString()), method: init.method ?? 'GET', headers,
      ...(body !== undefined ? { body } : { omitted: true }), bodyLength: rawBody.length });
    this.characters += body?.length ?? 0;
    while (this.snapshots.length > 128 || this.characters > 20_000_000) this.characters -= this.snapshots.shift()?.body?.length ?? 0;
  }
}
