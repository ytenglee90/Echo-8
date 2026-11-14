export function deniesCanvasCapability(text: string): boolean {
  // A character's quoted dialogue inside a valid operation is data, not a capability claim.
  if (/^\s*\{/u.test(text)) {
    try {
      const value: unknown = JSON.parse(text);
      if (value && typeof value === 'object' && 'actions' in value && Array.isArray(value.actions)) {
        if (value.actions.length) return false;
        text = 'answer' in value && typeof value.answer === 'string' ? value.answer : '';
      }
    } catch { /* Malformed plans are handled by the plan validator. */ }
  }
  if (/(?:之前|此前|旧版|原来).{0,30}(?:没有|无法|不能)/u.test(text) &&
    !/(?:我(?:当前|现在|这轮)|当前(?:会话|环境|助手)).{0,24}(?:没有|无法|不能)/u.test(text)) return false;
  return /(?:没有|不具备|无法|不能|无权|不支持).{0,20}(?:画布.{0,10}(?:权限|能力|工具|读写|写入)|操(?:作|控)画布|写入(?:权限|能力|工具))|(?:只有|仅有).{0,12}记忆.{0,6}工具/u.test(text);
}
