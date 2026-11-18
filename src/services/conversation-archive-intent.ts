import { canvasIntentText } from './ai-task-route.ts';
import { NATURAL_QUOTED_NAME } from './natural-canvas-rules.ts';

export function isCurrentConversationArchiveRequest(prompt: string): boolean {
  const text = canvasIntentText(prompt).replace(new RegExp(NATURAL_QUOTED_NAME, 'gu'), ' □ ').trim();
  return text.length <= 240 && /^(?:保存|更新|把|将)/u.test(text) &&
    /当前|这个|这次|本轮/u.test(text) && /对话|会话|聊天/u.test(text) &&
    /存档|存到(?:本地)?记忆/u.test(text) &&
    !/不要|别|暂不|不想|如何|怎么|为何|如果|稍后|以后|下次|然后|并且|同时|节点|卡片|文本框|[，,；;\r\n]/u.test(text);
}
