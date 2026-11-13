import type { PluginContext } from '../../core/contracts.ts';
import type { AIContextSource } from '../../protocols/ai.ts';
import { readContextSource } from './context-source-reader.ts';

/** Explicit paragraph addressing only; never guess a target from a summary. */
export async function readParagraphTarget(context: PluginContext, source: AIContextSource, paragraph: number, signal?: AbortSignal) {
  if (!Number.isSafeInteger(paragraph) || paragraph < 1 || paragraph > 1_000) throw new Error('段落编号无效');
  let text = '';
  for (let start = 0; start < Math.min(source.length, 64 * 1024); start += 4_096) {
    const read = await readContextSource(context, { sourceId: source.sourceId, start, length: Math.min(4_096, source.length - start) }, signal);
    if (read.source?.revision !== source.revision) throw new Error('读取目标段落期间正文已经变化');
    text += read.text ?? '';
    const paragraphs = [...text.matchAll(/\S[\s\S]*?(?=\r?\n[ \t]*\r?\n|$)/gu)];
    const target = paragraphs[paragraph - 1];
    if (target && (paragraphs.length > paragraph || start + (read.text?.length ?? 0) >= source.length)) {
      const targetStart = target.index!;
      const end = targetStart + target[0].trimEnd().length;
      const previous = paragraphs[paragraph - 2], next = paragraphs[paragraph];
      const contextStart = previous && previous[0].length <= 800 ? previous.index! : targetStart;
      const nextComplete = next && (paragraphs.length > paragraph + 1 || start + (read.text?.length ?? 0) >= source.length);
      const contextEnd = nextComplete && next[0].length <= 800 ? next.index! + next[0].trimEnd().length : end;
      return { start: targetStart, end, contextStart, text: text.slice(contextStart, contextEnd) };
    }
  }
  throw new Error('未在可读取范围内定位到指定完整段落，请缩小正文或明确引用目标段落');
}
