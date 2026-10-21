import { stripOperationCommands } from './command-parser.ts';

export const STOP_TERMS = new Set([
  '请你', '帮我', '这个', '这些', '那个', '一个', '进行', '内容', '根据', '需要', '然后', '以及',
  'the', 'and', 'for', 'with',
]);

export const MEMORY_STOP_TERMS = new Set([
  ...STOP_TERMS,
  '当前', '对话', '保存', '用户', '助手', '系统', '已经', '可以', '一下', '什么', '怎么',
  '我们', '你们', '他们', '这里', '那里', '因为', '所以', '如果', '还是', '没有', '不是',
]);

export function memoryTermOccurrences(text: string): Array<{ term: string; index: number }> {
  const occurrences: Array<{ term: string; index: number }> = [];
  for (const match of text.matchAll(/[\p{L}\p{N}]{2,32}/gu)) {
    if (match.index === undefined) continue;
    const raw = match[0];
    if (/^\p{Script=Han}+$/u.test(raw)) {
      if (raw.length <= 12) occurrences.push({ term: raw, index: match.index });
      for (let index = 0; index < raw.length - 1; index += 1) {
        occurrences.push({ term: raw.slice(index, index + 2), index: match.index + index });
      }
      continue;
    }
    occurrences.push({ term: raw.toLocaleLowerCase('zh-CN'), index: match.index });
  }
  return occurrences;
}

export function extractTerms(prompt: string): string[] {
  const clean = stripOperationCommands(prompt)
    .replace(/@\[[^\]]+\]\(node:[a-z0-9:-]+\)/giu, ' ')
    .replace(/@\[[^\]]+\]/gu, ' ')
    .replace(/@(node:[a-z0-9:-]+)/giu, ' ');
  return [...new Set(memoryTermOccurrences(clean).map((occurrence) => occurrence.term))]
    .filter((term) => !STOP_TERMS.has(term.toLocaleLowerCase('zh-CN')))
    .slice(0, 8);
}
