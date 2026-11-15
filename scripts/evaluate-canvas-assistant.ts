import assert from 'node:assert/strict';
import { ApplicationKernel } from '../src/core/kernel.ts';
import type { PluginContext } from '../src/core/contracts.ts';
import { createTextNodePlugin } from '../src/plugins/text-node/plugin.ts';
import { createSelectionPlugin } from '../src/plugins/selection/model.ts';
import { createGroupsPlugin } from '../src/plugins/groups/model.ts';
import { createConnectionsPlugin } from '../src/plugins/connections/model.ts';
import { createCanvasControlPlugin } from '../src/plugins/canvas-control/model.ts';
import { buildGenerateRequest } from '../src/plugins/ai-assistant/generation-request.ts';
import { runCanvasAgentLoop } from '../src/plugins/ai-assistant/canvas-agent-tools.ts';
import { inferAtOperation } from '../src/plugins/ai-assistant/command-parser.ts';
import { buildProviderRequest, parseCompletion, validateGenerateRequest } from '../src/plugins/ai-provider/provider-transport.ts';
import type { AIGenerateRequest, AIGenerateResult, AIPreparedContext } from '../src/protocols/ai.ts';
import type { CanvasControlState } from '../src/protocols/canvas-control.ts';
import type { ContentSummary } from '../src/protocols/content.ts';
import type { CanvasRelativePlacement } from '../src/protocols/canvas-agent.ts';

const live = process.argv.includes('--live');
const key = live ? process.env.ECHO8_TEST_DEEPSEEK_API_KEY?.trim() : undefined;
assert(!live || key, '--live requires ECHO8_TEST_DEEPSEEK_API_KEY');
const profile = {
  id: 'evaluation', label: 'Evaluation', platform: 'DeepSeek', endpoint: 'https://api.deepseek.com/chat/completions',
  model: process.env.ECHO8_TEST_DEEPSEEK_MODEL || 'deepseek-flash', authentication: 'bearer', apiStyle: 'openai',
} as const;

function fixtureResponse(call: number, placement: CanvasRelativePlacement): AIGenerateResult {
  const tool = call === 1
    ? { name: 'query_canvas', arguments: { mode: 'all' } }
    : { name: 'propose_canvas_plan', arguments: { plan: { version: 1, actions: [] }, placements: [placement] } };
  return { provider: 'fixture', model: 'fixture', text: '', finishReason: 'tool-calls',
    toolCalls: [{ id: 'fixture-' + call, name: tool.name, arguments: JSON.stringify(tool.arguments) }] };
}

async function evaluate(turns: number) {
  const kernel = new ApplicationKernel([createTextNodePlugin(), createSelectionPlugin(), createGroupsPlugin(), createConnectionsPlugin(), createCanvasControlPlugin()]);
  await kernel.start();
  try {
    const context = {
      capabilities: {
        requestAll: async () => [],
        request: (name: string, input: unknown, signal?: AbortSignal) => name === 'ai.provider.catalog@1'
          ? Promise.resolve({ activeId: profile.id, options: [{ id: profile.id, canvasToolCallingSupported: true }] })
          : kernel.capabilities.request(name, input, signal),
      },
      signals: { emit() {} }, diagnostics: { warn() {} },
    } as unknown as PluginContext;
    const create = (title: string, body: string, x: number) => kernel.router.dispatch<{ id: string }>('node.create', { title, body, x, y: 0 }, 'core.test');
    const weapon = await create('武器卡', '保管的长弓上挂着一块裂开的铜片。', 0);
    const person = await create('人物卡', '守钟人黎南，每晚换一次号牌。', 800);
    const distractor = await create('展品记录', '展厅里的武器复制品。', 1600);
    await kernel.router.dispatch('selection.set', { ids: [distractor.id], mode: 'replace' }, 'core.test');
    const placement: CanvasRelativePlacement = { nodeId: weapon.id, anchorId: person.id, side: 'below', gap: 35 };
    const prompt = '把那张写着裂开铜片的卡挪到守钟人那张卡下头，两张之间腾出35像素。';
    assert.equal(inferAtOperation(prompt), 'canvas-control');
    const transcript = Array.from({ length: turns }, (_, i) =>
      `[用户]\n继续讨论展厅的第${i + 1}场活动。\n[助手]\n${'记录展品、场地和展出背景。'.repeat(15)}`).join('\n');
    const prepared: AIPreparedContext = {
      id: 'eval:layout', sessionId: 'eval:session', operation: 'canvas-control', prompt,
      sources: [{ sourceId: 'eval:transcript', provider: 'ai-assistant', kind: 'conversation', title: '测量用对话', revision: turns,
        start: 0, length: transcript.length, text: transcript, reason: 'recent-conversation', boundary: 'conversation-turn' }],
      totalCharacters: transcript.length + prompt.length, estimatedTokens: 0, createdAt: Date.now(), expiresAt: Date.now() + 300_000,
    };
    const signal = AbortSignal.timeout(150_000);
    const request = await buildGenerateRequest(context, prepared, { templates: [] }, signal);
    const calls: unknown[] = [];
    const generate = async (input: AIGenerateRequest): Promise<AIGenerateResult> => {
      if (calls.length >= 4) throw new Error('Evaluation limit reached after four requests');
      validateGenerateRequest(input);
      const wire = buildProviderRequest(profile, key ?? '', { ...input, maxOutputTokens: 1200 }, false);
      const start = performance.now();
      const metric = { requestBytes: Buffer.byteLength(String(wire.init.body)), messageCount: input.messages.length,
        durationMs: undefined as number | undefined, status: undefined as number | undefined, usage: undefined as AIGenerateResult['usage'] };
      calls.push(metric);
      if (!key) return fixtureResponse(calls.length, placement);
      try {
        const response = await fetch(wire.endpoint, { ...wire.init, signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)]) });
        metric.status = response.status;
        if (!response.ok) throw new Error('Provider HTTP ' + response.status);
        const result = parseCompletion(await response.json());
        metric.usage = result.usage;
        return { ...result, provider: profile.platform, model: profile.model };
      } finally {
        metric.durationMs = Math.round(performance.now() - start);
      }
    };
    let outcome: object;
    try {
      const result = await runCanvasAgentLoop(context, prepared, request, await generate(request), generate,
        async () => ({ messages: [], executed: 0 }), signal);
      if (!result.canvasPlan) throw new Error('No canvas plan');
      const admission = { preparationId: prepared.id, sessionId: prepared.sessionId, prompt };
      await kernel.router.dispatch('canvasControl.offer@1', { ...admission, text: result.result.text, complete: true }, 'core.test');
      const readState = () => kernel.router.ask<CanvasControlState>('canvasControl.state@1', undefined, 'core.test');
      const plan = (await readState()).reviews.at(-1);
      const targetMatch = plan?.actions.length === 1 && plan.actions[0]?.type === 'update-node' && plan.actions[0].id === weapon.id;
      if (!targetMatch) return { turns, calls, outcome: { targetMatch, applied: false } };
      await kernel.router.dispatch('canvasControl.apply@1', { id: plan!.id }, 'core.test');
      const current = await kernel.capabilities.request<ContentSummary[]>('content.summariesById@1', { nodeIds: [weapon.id, person.id] });
      const a = current.find(node => node.id === weapon.id)!;
      const b = current.find(node => node.id === person.id)!;
      const gap = a.y - b.y - b.height;
      outcome = { targetMatch, gap, centered: a.x + a.width / 2 === b.x + b.width / 2,
        applied: (await readState()).reviews.at(-1)?.verification?.status === 'verified' };
    } catch (error) {
      outcome = { applied: false, error: error instanceof Error ? error.message : 'Unknown failure' };
    }
    return { turns, calls, outcome };
  } finally {
    await kernel.plugins.stop('canvas-control');
  }
}

const scenarios = [await evaluate(2), await evaluate(48)];
console.log(JSON.stringify({ mode: live ? 'live DeepSeek' : 'fixture, no model calls', ...(live ? { model: profile.model } : {}), scenarios }, null, 2));
if (scenarios.some(({ outcome }) => !('applied' in outcome && outcome.applied && 'gap' in outcome && outcome.gap === 35 && 'centered' in outcome && outcome.centered))) process.exitCode = 1;
