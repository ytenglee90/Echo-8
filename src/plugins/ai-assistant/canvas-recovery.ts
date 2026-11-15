import type { PluginContext } from '../../core/contracts.ts';
import type { AISessionRecord } from '../../protocols/ai.ts';
import { readContextSource } from './context-source-reader.ts';
import { sessionTranscriptSourceId } from './transcript-storage.ts';
import { classifyAITurn } from './turn-route.ts';

export function isCanvasFailureFollowup(prompt: string): boolean {
  return /^(?:(?:为什么|怎么)(?:在)?画布上(?:还是)?(?:看不到|没有显示|没有出现)|(?:画布上)?(?:还是|仍然|依然)(?:没有|看不到|没显示|没出现|没创建|没生效))(?:呢|啊)?[。！？!?]*$/u.test(prompt.trim());
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
    return route.category !== 'chat' && !route.lookupOnly && !route.applyItems && previous.length <= 2000 ? previous : undefined;
  }
  return undefined;
}
