import type { AIContextIntent, AIOperation } from '../../protocols/ai.ts';
import { stripOperationCommands } from './command-parser.ts';

const RECALL_CUES = /(?:之前|上次|历史|记得|回顾|回忆|曾经|原来|过去|那份|该项目|这个项目|资料里|文档里|设定|决策|why|previous|history|remember|recall)/iu;
const SMALL_TALK = /^(?:你好(?:呀|啊|！|。|[!,.])?|你好(?:呀|啊)?[，,]\s*(?:今天|最近)?怎么样[？?]?|嗨|在吗|谢谢(?:你)?(?:！|。|[!,.])?|好的?(?:呀|啊|！|。|[!,.])?|明白了?(?:！|。|[!,.])?|继续(?:吧|。|！|[!,.])?)$/iu;

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
  if (operation === 'general' && text.length <= 40 && SMALL_TALK.test(text)) return 'conversation';
  return 'analysis';
}
