export interface MemorySuggestion {
  id: string;
  kind: 'confirm' | 'modify' | 'deprecate';
  directive: string;
  explanation: string;
}

/**
 * Conservative, local-only detection. It proposes an explicit directive but
 * never records one until the user presses the confirmation button.
 */
export function inferMemorySuggestion(prompt: string): MemorySuggestion | undefined {
  if (!prompt.trim() || /@(确认|修改|废弃|分支)\s/u.test(prompt)) return undefined;
  const lines = prompt.split(/[。！？\n]/u).map((line) => line.trim()).filter(Boolean).reverse();
  for (const line of lines) {
    const modify = line.match(/^(?:请)?(?:把|将)?(.{1,60}?)从(.{1,100}?)\s*(?:改为|调整为|变更为)\s*(.{1,120})$/u);
    if (modify) {
      const directive = `@修改 ${cleanSuggestionField(modify[1])}：${cleanSuggestionField(modify[2])} -> ${cleanSuggestionField(modify[3])}`;
      return { id: directive, kind: 'modify', directive, explanation: `检测到“${modify[1]}”可能发生了正式变更。` };
    }
    const confirm = line.match(/^(?:请)?(?:确认|确定|决定)(?:将|把)?(.{1,60}?)(?:为|是|：)\s*(.{1,120})$/u);
    if (confirm) {
      const directive = `@确认 ${cleanSuggestionField(confirm[1])}：${cleanSuggestionField(confirm[2])}`;
      return { id: directive, kind: 'confirm', directive, explanation: `检测到“${confirm[1]}”可能是一项正式信息。` };
    }
    const deprecate = line.match(/^(?:请)?(?:废弃|取消|不再使用)\s*(.{1,120})$/u);
    if (deprecate) {
      const directive = `@废弃 ${cleanSuggestionField(deprecate[1])}`;
      return { id: directive, kind: 'deprecate', directive, explanation: '检测到一项内容可能已经不再使用。' };
    }
  }
  return undefined;
}

export function memoryDirectiveLabel(kind: MemorySuggestion['kind']): string {
  return ({ confirm: '确认', modify: '修改', deprecate: '废弃' })[kind];
}

function cleanSuggestionField(value: string): string {
  return value.replace(/[：:|｜→]/gu, ' ').replace(/\s+/gu, ' ').trim();
}
