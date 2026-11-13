import type { PluginContext } from '../../src/core/contracts.ts';
import type { AIPreparedContext, AIPreparedSource } from '../../src/protocols/ai.ts';

const source = (id: string, text: string, reason: AIPreparedSource['reason'] = 'explicit-reference'): AIPreparedSource => ({
  sourceId: id, provider: 'text-node', kind: 'text', title: id, revision: 1,
  start: 0, length: text.length, text, reason, complete: true, boundary: 'paragraph',
});
export const efficiencyContext = {
  capabilities: {
    requestAll: async () => [],
    request: async (key: string) => ['canvasControl.context@1', 'canvasControl.context@2'].includes(key)
      ? { instruction: '仅输出本轮必要的结构化操作；改动必须经过范围和修订校验。' }
      : key === 'canvasControl.taskState@1' ? undefined : { options: [] },
  }, diagnostics: { warn() {} },
} as unknown as PluginContext;

/** Fixed original evidence and prompts; never use model-generated fixtures as proof. */
export const efficiencyScenarios: Array<{ name: string; rounds: AIPreparedContext[] }> = [
  { name: '问候', prompts: ['你好'], intent: 'conversation' },
  { name: '连续追问', prompts: ['这个人物还缺什么？', '再补充一个弱点'], history: '[用户 · 2026/11/13 · 常规]\n主角林渊害怕钟声，但必须修复钟塔。\n\n[助手 · 2026/11/13 · 常规]\n可以让他在钟声中修表。', intent: 'conversation' },
  { name: '历史事实', prompts: ['我们确定的发布日期是什么？'], evidence: '用户已确认：发布日期为十一月二十日。', intent: 'memory-recall' },
  { name: '冲突记忆', prompts: ['发布日期到底是哪天？'], evidence: '记录 A：十一月二十日。记录 B：十一月二十一日。尚未确认。', intent: 'memory-recall' },
  { name: '人物设计', prompts: ['为主角补充人物设计'], evidence: '林渊，修表匠，害怕钟声。禁止赋予复活能力。', intent: 'analysis' },
  { name: '续写', prompts: ['接着续写，只给新增正文'], evidence: '钟声停了。林渊把断掉的指针放进衣袋，推开塔门。', operation: 'expand', intent: 'analysis' },
  { name: '改色', prompts: ['把选中节点设为 #336699'], operation: 'canvas-control', intent: 'analysis' },
  { name: '分组连线', prompts: ['把这些人物分别分组，并连接相关节点'], operation: 'canvas-control', intent: 'analysis' },
  { name: '生成中修改', prompts: ['修改主角设定，保留禁用复活的限制'], evidence: '修订 1：林渊害怕钟声。禁止复活。', operation: 'rewrite', intent: 'analysis' },
].map((item, index) => ({ name: item.name, rounds: item.prompts.map((prompt, round) => ({
  id: `fixed:${index}:${round}`, sessionId: `fixed:${index}`, operation: item.operation ?? 'general', prompt,
  contextIntent: item.intent, contextMode: item.operation === 'canvas-control' ? 'explicit-only' : 'automatic',
  sources: [
    ...(item.history ? [source('conversation', item.history, 'recent-conversation')] : []),
    ...(item.evidence ? [source('evidence', item.evidence, item.intent === 'memory-recall' ? 'conversation-memory' : 'explicit-reference')] : []),
  ],
  createdAt: 1, expiresAt: 2, totalCharacters: 0, estimatedTokens: 0,
} as AIPreparedContext)) }));
