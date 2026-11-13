import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationKernel } from '../src/core/kernel.ts';
import { defineManifest } from '../src/plugins/manifest.ts';
import { buildProviderRequest, fetchWithInitialRetry } from '../src/plugins/ai-provider/provider-transport.ts';
import { applyAIProviderPreset } from '../src/plugins/ai-provider/presets.ts';

declare module '../src/protocols/commands.ts' {
  interface ApplicationCommandMap {
    'probe.timerHold': CommandContract<undefined, void>;
    'probe.timerFollowup': CommandContract<undefined, void>;
  }
}

test('owned timers queue non-awaited work both while idle and during an asynchronous formal command', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let fired!: () => void;
  const timerFired = new Promise<void>(resolve => { fired = resolve; });
  const seen: string[] = [];
  const kernel = new ApplicationKernel([{
    manifest: defineManifest('timer-queue-probe', '后台队列测试', {
      commands: ['probe.timerHold', 'probe.timerFollowup'], dispatches: ['probe.timerFollowup'],
    }),
    start(context) {
      context.commands.register({ type: 'probe.timerFollowup', handle: () => { seen.push('followup'); return {}; } });
      context.commands.register({ type: 'probe.timerHold', handle: async () => {
        seen.push('start');
        context.resources.timeout(() => { context.commands.defer('probe.timerFollowup'); fired(); }, 0);
        await gate;
        seen.push('finish');
        return {};
      } });
      context.resources.timeout(() => context.commands.defer('probe.timerFollowup'), 0);
    },
  }]);
  await kernel.start();
  try {
    // Let the idle callback run before the long command is admitted.
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(seen, ['followup']);
    const held = kernel.router.dispatch('probe.timerHold', undefined, 'core.test');
    await Promise.race([timerFired, new Promise((_, reject) => setTimeout(() => reject(new Error('timer stalled')), 500))]);
    assert.deepEqual(seen, ['followup', 'start']);
    release(); await held;
    await kernel.router.dispatch('probe.timerFollowup', undefined, 'core.test');
    assert.deepEqual(seen, ['followup', 'start', 'finish', 'followup', 'followup']);
  } finally { release(); await kernel.plugins.stop('timer-queue-probe'); }
});

test('Gemini requests follow the selected model for base, model and method URLs in both transport modes', () => {
  const profile = { ...applyAIProviderPreset('gemini')!, id: 'test', model: 'models/gemini-3.5-flash-lite' };
  const input = { messages: [{ role: 'user' as const, content: '测试' }], temperature: 0.2, maxOutputTokens: 1024 };
  for (const endpoint of [
    'https://generativelanguage.googleapis.com',
    'https://generativelanguage.googleapis.com/v1beta/models',
    'https://generativelanguage.googleapis.com/v1beta/models/old-model',
    'https://generativelanguage.googleapis.com/v1beta/models/old-model:generateContent',
    'https://generativelanguage.googleapis.com/v1beta/models/old-model:streamGenerateContent?alt=sse',
  ]) for (const stream of [false, true]) {
    const request = buildProviderRequest({ ...profile, endpoint }, 'fake-test-key', input, stream);
    const url = new URL(request.endpoint);
    assert.equal(url.pathname, `/v1beta/models/gemini-3.5-flash-lite:${stream ? 'streamGenerateContent' : 'generateContent'}`);
    assert.equal(url.searchParams.get('alt'), stream ? 'sse' : null);
    assert.equal(new Headers(request.init.headers).get('x-goog-api-key'), 'fake-test-key');
  }
});

test('a Gemini model 404 is actionable and never automatically retried as a transient network error', async () => {
  let calls = 0;
  await assert.rejects(() => fetchWithInitialRetry(async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: 'models/test is not found', status: 'NOT_FOUND' } }), { status: 404 });
  }, 'https://generativelanguage.googleapis.com/v1beta/models/test:streamGenerateContent?alt=sse', {}, new AbortController().signal), /HTTP 404.*模型设置/u);
  assert.equal(calls, 1);
});
