import type { AIContextIntent, AIOperation } from '../../protocols/ai.ts';
import { stripOperationCommands } from './command-parser.ts';

const RECALL_CUES = /(?:之前|上次|历史|记得|回顾|回忆|曾经|原来|过去|那份|该项目|这个项目|资料里|文档里|设定|决策|why|previous|history|remember|recall)/iu;
const SMALL_TALK = /^(?:你好(?:呀|啊|！|。|[!,.])?|你好(?:呀|啊)?[，,]\s*(?:今天|最近)?怎么样[？?]?|嗨|在吗|谢谢(?:你)?(?:！|。|[!,.])?|好的?(?:呀|啊|！|。|[!,.])?|明白了?(?:！|。|[!,.])?|继续(?:吧|。|！|[!,.])?)$/iu;

export function isStandaloneConversation(prompt: string): boolean {
  const text = stripOperationCommands(prompt).trim().replace(/^(?:这次|本轮)?\s*(?:别|不要|不用)(?:再)?(?:用|使用|查|参考)?(?:长期记忆|历史(?:记忆|记录)?)[，,；;]\s*/u, '');
  if (text.length > 260 || /@\[|@node:|刚才|之前|上[次轮版]|前面|那[份段个版些]|这[份段个版些几]|它们?|上述|我们|我的|当前|本次|继续|接着|重新|这个项目|该项目|画布(?:上|里|中)|资料里|选中|选区/u.test(text)) return false;
  const definition = /^(?:请问[，,\s]*)?(?:(?:用)?一句话(?:解释|说明)\s*)?(?:什么(?:是|叫)|何谓)/u;
  return /^(?:你好[呀啊]?|嗨|在吗|谢谢你?)[。！!？?]?$/u.test(text) ||
    definition.test(text) || !RECALL_CUES.test(text) && /^(?:请问[，,\s]*)?(?:为什么|如何理解|怎样理解|解释一下|请解释)/u.test(text);
}

export function isNearConversationFollowup(prompt: string): boolean {
  return /^(?:(?:举|给)(?:我)?(?:一个|个|一两个)?(?:具体|简单)?例子(?:说明(?:一下)?|解释(?:一下)?|看看)?|(?:换个|换一种)(?:我能听懂的|简单的|通俗的)?(?:说法|讲法)|(?:再)?说(?:简单|清楚|具体|详细)(?:一?点|一些)|(?:继续|接着)(?:说|讲)?(?:吧)?|(?:再)?解释一下)[。！!？?]*$/u
    .test(prompt.trim());
}

/**
 * Cheap deterministic routing prevents ordinary chat from paying for broad
 * retrieval. Any selected memory or explicit source stays authoritative and
 * bypasses this fast path.
 */
export function classifyAIContextIntent(
  prompt: string,
  operation: AIOperation,
  options: { hasExplicitSource: boolean; hasSelectedMemory: boolean },
): AIContextIntent {
  if (options.hasExplicitSource || options.hasSelectedMemory) return 'memory-recall';
  const text = stripOperationCommands(prompt).replace(/@\[[^\]]+\](?:\([^)]*\))?/gu, ' ').trim();
  if (RECALL_CUES.test(text)) return 'memory-recall';
  if (operation === 'general' && (isStandaloneConversation(text) || text.length <= 40 && SMALL_TALK.test(text))) return 'conversation';
  return 'analysis';
}
