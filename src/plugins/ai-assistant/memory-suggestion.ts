export interface MemorySuggestion {
  id: string;
  kind: 'confirm' | 'modify' | 'deprecate' | 'branch';
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
  return ({ confirm: '确认', modify: '修改', deprecate: '废弃', branch: '分支' })[kind];
}

/** Only explicit memory-management wording can enter the formal review path. */
export function naturalMemoryDirective(prompt: string): string | undefined {
  const text = prompt.trim().replace(/^请\s*/u, '').replace(/[。！!]$/u, '');
  const field = (value: string) => value.trim();
  const clean = (value: string | undefined) => Boolean(value && !/[\r\n@：:｜|→]/u.test(value));
  let match: RegExpExecArray | null;
  if ((match = /^(?:记住|正式确认|记为正式设定)[：:\s]*(.{1,120}?)[：:]\s*(.{1,500})$/u.exec(text)) && clean(match[1])) {
    return `@确认 ${field(match[1]!)}：${field(match[2]!)}`;
  }
  if ((match = /^(?:把|将)已确认的(.{1,120}?)从(.{1,500}?)(?:改成|改为)(.{1,500})$/u.exec(text)) && clean(match[1]) && clean(match[2])) {
    return `@修改 ${field(match[1]!)}：${field(match[2]!)} -> ${field(match[3]!)}`;
  }
  if ((match = /^废弃(?:已确认的|正式记忆中的)(.{1,120}?)(?:[：:]\s*(.{1,500}))?$/u.exec(text)) && clean(match[1])) {
    return `@废弃 ${field(match[1]!)}${match[2] ? '：' + field(match[2]) : ''}`;
  }
  if ((match = /^(?:在|为)(.{1,80}?)(?:分支|方案)(?:中|里)?(?:记录|记住|保留)[：:\s]*(.{1,120}?)[：:]\s*(.{1,500})$/u.exec(text)) && clean(match[1]) && clean(match[2])) {
    return `@分支 ${field(match[1]!)}｜${field(match[2]!)}：${field(match[3]!)}`;
  }
  return undefined;
}

function cleanSuggestionField(value: string): string {
  return value.replace(/[：:|｜→]/gu, ' ').replace(/\s+/gu, ' ').trim();
}
