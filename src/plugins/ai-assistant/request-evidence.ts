import type { AIChatMessage, AIPreparedSource } from '../../protocols/ai.ts';
import { extractTerms } from './memory-terms.ts';

/** Bounded selection from already range-read originals; no summary replaces evidence. */
export function nativeConversation(text: string, prompt: string, omitCanvasStatus = false): Array<AIChatMessage & { role: 'user' | 'assistant' }> {
  const headers = [...text.matchAll(/^\[(用户|助手)(?:\s*·\s*[^\]]+)?\]\s*$/gmu)];
  const messages = headers.map((header, index) => ({
    role: header[1] === '用户' ? 'user' as const : 'assistant' as const,
    content: text.slice(header.index! + header[0].length, headers[index + 1]?.index ?? text.length).trim(),
  })).filter((item, index) => item.content && !(omitCanvasStatus && item.role === 'assistant' &&
    /·\s*画布操作\]/u.test(headers[index]![0]) && /^(?:已准备\s*\d+\s*项|已生成\s*\d+\s*项|本次没有需要应用的画布操作)/u.test(item.content)));
  const terms = extractTerms(prompt);
  return messages.filter((message, index) => index >= messages.length - 6 ||
    (message.role === 'user' && /必须|禁止|不能|不得|确认|决定|限制/u.test(message.content)) ||
    terms.some(term => message.content.toLocaleLowerCase().includes(term.toLocaleLowerCase())))
    .slice(-16);
}

/** Keep every citation/source identity, but send identical verified bodies once. */
export function evidenceBodies(sources: readonly AIPreparedSource[], historyIndex: number, prompt = '', omitCanvasStatus = false): string[] {
  const sentHistory = historyIndex >= 0 ? nativeConversation(sources[historyIndex]!.text, prompt, omitCanvasStatus) : [];
  return sources.map((source, index) => {
    if (index === historyIndex) return '本来源对话以原生角色消息附后。';
    const hasOtherRevision = sources.some((previous, previousIndex) => previousIndex < index && previous.sourceId === source.sourceId && previous.revision !== source.revision);
    const duplicate = hasOtherRevision ? -1 : sources.findIndex((previous, previousIndex) => previousIndex < index && previousIndex !== historyIndex &&
      (previous.kind === source.kind || (nativeConversation(previous.text, '').length > 0 && nativeConversation(source.text, '').length > 0)) &&
      (previous.revision === source.revision || previous.sourceId !== source.sourceId) &&
      previous.complete !== false && source.complete !== false && previous.text === source.text);
    if (duplicate >= 0) return `原文与 [来源 ${duplicate + 1}] 相同；保留本来源独立的修订和适用范围，不推断决定相同。`;
    const covering = sources.findIndex((previous, previousIndex) => previousIndex < index && previousIndex !== historyIndex &&
      previous.sourceId === source.sourceId && previous.revision === source.revision &&
      previous.start <= source.start && previous.start + previous.text.length >= source.start + source.text.length &&
      previous.text.slice(source.start - previous.start, source.start - previous.start + source.text.length) === source.text);
    if (covering >= 0) return `原文已包含在 [来源 ${covering + 1}] 的范围内。`;
    let text = source.text;
    if (sentHistory.length) {
      const headers = [...text.matchAll(/^\[(用户|助手)(?:\s*·\s*[^\]]+)?\]\s*$/gmu)];
      for (let position = headers.length - 1; position >= 0; position -= 1) {
        const header = headers[position]!;
        const start = header.index! + header[0].length;
        const end = headers[position + 1]?.index ?? source.text.length;
        const original = source.text.slice(start, end).trim();
        const same = sentHistory.findIndex(message => message.role === (header[1] === '用户' ? 'user' : 'assistant') && message.content === original);
        if (same >= 0 && original.length >= 48) text = text.slice(0, start) + `\n原文与附后当前对话第 ${same + 1} 条角色消息相同；此来源的修订及适用范围仍独立。\n` + text.slice(end);
      }
    }
    return `<untrusted-canvas-content>\n${text}\n</untrusted-canvas-content>`;
  });
}
