import type { PluginContext } from '../../core/contracts.ts';
import type { AISessionRecord } from '../../protocols/ai.ts';
import { readContextSource } from './context-source-reader.ts';
import { sessionTranscriptSourceId } from './transcript-storage.ts';
import { classifyAITurn } from './turn-route.ts';
import { isCapabilityUnavailable } from './runtime-errors.ts';
import type { CanvasControlTaskState } from '../../protocols/canvas-control.ts';

export function isCanvasFailureFollowup(prompt: string): boolean {
  return /^(?:(?:为什么|怎么)(?:在)?画布上(?:还是)?(?:看不到|没有显示|没有出现)|(?:画布上)?(?:还是|仍然|依然)(?:没有|看不到|没显示|没出现|没创建|没生效))(?:呢|啊)?[。！？!?]*$/u.test(prompt.trim());
}

export async function checkCanvasRecovery(context: PluginContext, sessionId: string, prompt: string, signal: AbortSignal): Promise<string | undefined> {
  const state = await context.capabilities.request<CanvasControlTaskState>('canvasControl.taskState@1', { sessionId }, signal)
    .catch(error => { if (!isCapabilityUnavailable(error, 'canvasControl.taskState@1')) throw error; });
  const plan = state?.plans.findLast(item => item.goal === prompt);
  if (plan?.status === 'applied') return `上次的 ${plan.actionCount} 项操作已经在画布上应用。可以在画布控制里核对对象。`;
  if (plan?.status === 'pending') return '上次的操作仍在预览中，请打开画布控制查看并应用。';
  if (plan?.status === 'undone') return '上次的操作已撤销。如需恢复，可以使用画布的重做。';
  return undefined;
}

/** Only the nearest complete user request in this session can resume authority. */
export async function recoverCanvasRequest(context: PluginContext, session: AISessionRecord, prompt: string, signal: AbortSignal): Promise<string | undefined> {
  if (!isCanvasFailureFollowup(prompt)) return undefined;
  const sourceId = sessionTranscriptSourceId(session);
  const metadata = await readContextSource(context, { sourceId, start: 0, length: 0 }, signal);
  const source = metadata.source;
  if (!source?.length) return undefined;
  const start = Math.max(0, source.length - 8192);
  const read = await readContextSource(context, { sourceId, start, length: source.length - start }, signal);
  if (read.source?.revision !== source.revision) throw new Error('对话已变化，请重新发送本次要求');
  const text = read.text ?? '';
  const headers = [...text.matchAll(/^\[(用户|助手)(?:[ \t]*·[^\]\r\n]+)?\][ \t]*\r?$/gmu)];
  for (let index = headers.length - 1; index >= 0; index--) {
    const header = headers[index]!;
    if (header[1] !== '用户') continue;
    const previous = text.slice(header.index! + header[0].length, headers[index + 1]?.index ?? text.length).trim();
    if (isCanvasFailureFollowup(previous)) continue;
    // Discussion, cancellation and unrelated turns are barriers; never search past them.
    const route = classifyAITurn(previous);
    const recordedCanvasOperation = /·\s*画布操作\]/u.test(header[0]);
    return (recordedCanvasOperation || route.category !== 'chat') && !route.lookupOnly && !route.applyItems &&
      previous.length <= 2000 ? previous : undefined;
  }
  return undefined;
}
