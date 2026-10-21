import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationKernel } from '../src/core/kernel.ts';
import type { PluginDefinition } from '../src/core/contracts.ts';
import type { AIGenerateRequest, AIGenerateResult } from '../src/protocols/ai.ts';
import {
  NOVELFORGE_LOCAL_CONNECTOR_CAPABILITY,
  type NovelForgeConnectorFetchRequest,
} from '../src/protocols/novelforge.ts';
import { createAIProviderPlugin } from '../src/plugins/ai-provider/model.ts';
import { applyAIProviderPreset } from '../src/plugins/ai-provider/presets.ts';
import { defineManifest } from '../src/plugins/manifest.ts';

test('AI provider delegates NovelForge Codex transport without receiving the pairing token', async () => {
  const requests: NovelForgeConnectorFetchRequest[] = [];
  const connector: PluginDefinition = {
    manifest: defineManifest('test-novelforge-connector', '测试 NovelForge 连接器', {
      providesCapabilities: [NOVELFORGE_LOCAL_CONNECTOR_CAPABILITY],
    }),
    start(context) {
      context.capabilities.provide<NovelForgeConnectorFetchRequest, Response>({
        key: NOVELFORGE_LOCAL_CONNECTOR_CAPABILITY,
        invoke: (request) => {
          requests.push(request);
          return new Response(JSON.stringify({
            id: 'chatcmpl-real-shape',
            object: 'chat.completion',
            model: 'novelforge-codex',
            choices: [{
              index: 0,
              message: { role: 'assistant', content: '连接器回答' },
              finish_reason: 'stop',
            }],
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        },
      });
    },
  };
  const kernel = new ApplicationKernel([
    connector,
    createAIProviderPlugin(),
  ], { persistenceLaunchPolicy: 'fresh-session' });
  await kernel.start();
  await kernel.router.dispatch('aiProvider.profile.save', {
    ...applyAIProviderPreset('novelforge-codex')!,
  }, 'core.test');
  const result = await kernel.capabilities.request<AIGenerateResult>('ai.generate@1', {
    messages: [{ role: 'user', content: '请回答' }],
    temperature: 0.2,
    maxOutputTokens: 256,
  } satisfies AIGenerateRequest);
  assert.equal(result.text, '连接器回答');
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.path, '/v1/chat/completions');
  assert.equal(requests[0]?.body.model, 'novelforge-codex');
  assert.equal(JSON.stringify(requests[0]).includes('pairing'), false);
  assert.equal(JSON.stringify(requests[0]).includes('Authorization'), false);
});
