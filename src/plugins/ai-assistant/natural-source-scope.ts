import type { PluginContext } from '../../core/contracts.ts';
import type { AIContextSource, AIOperation } from '../../protocols/ai.ts';
import type { GroupRecord } from '../../protocols/groups.ts';
import type { SelectionSnapshot } from '../../protocols/selection.ts';
import { operationLabel } from './operations.ts';
import { isCapabilityUnavailable } from './runtime-errors.ts';

const SCOPE_WORDS = /^(?:请\s*|帮我\s*|把|将|对比|比较|对照|总结|概括|归纳|提炼|提取|分析|检查|核对|根据|参考|基于|结合|从)+/u;
const QUOTED = /「([^」]+)」|『([^』]+)』|“([^”]+)”|《([^》]+)》|"([^"]+)"/gu;

function normalize(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
}

export function naturalResultDestination(prompt: string, operation: AIOperation): { input: string; title?: string } {
  if (operation === 'canvas-control') return { input: prompt };
  const suffix = /(?:[，,；;]\s*|并|然后\s*)(?:把(?:结果|对比结果|总结|冲突)\s*)?(?:保存|写入|输出|整理|另存)(?:为|成|到)(?:(?:一个|一张)?(?:名为|叫)\s*[「『“"]([^」』”"\r\n]+)[」』”"]\s*(?:的)?|(?:一个|一张)?(?:独立的)?)新节点[。！!]?\s*$/u.exec(prompt);
  if (!suffix) return { input: prompt };
  const title = suffix[1]?.trim() || `${operationLabel(operation)}结果`;
  if (title.length > 300) throw new Error('结果节点标题请控制在 300 字以内。');
  return { input: prompt.slice(0, suffix.index).trim(), title };
}

export async function bindNaturalSourceScope(
  context: PluginContext,
  prompt: string,
  operation: AIOperation,
  catalog: AIContextSource[],
  signal: AbortSignal,
): Promise<{ ids: string[]; group: boolean }> {
  const empty = { ids: [], group: false };
  if (operation === 'general' || operation === 'canvas-control') return empty;
  if (/^(?:请\s*|帮我\s*|把|将|对比|比较|总结|概括|归纳|分析|检查|提取|结合|根据)*(?:这两个|这两张|这几个|选中的?)(?:文字节点|文本框|节点|卡片|内容|的?正文)?(?:[，,。；：\s]|$)/u.test(prompt)) {
    const selection = await context.capabilities.request<SelectionSnapshot>('selection.read@1', undefined, signal)
      .catch(error => { if (isCapabilityUnavailable(error, 'selection.read@1')) return undefined; throw error; });
    const selected = new Set(selection?.ids ?? []);
    const ids = catalog.filter(source => source.kind === 'text' && selected.has(source.sourceId)).map(source => source.sourceId);
    const pair = /这两个|这两张/u.test(prompt);
    if (!ids.length || (pair && ids.length !== 2)) throw new Error(pair ? '请在画布选中两个正文节点。' : '请先在画布选中要处理的正文节点。');
    return { ids, group: false };
  }
  const groups = /组/u.test(prompt) ? await context.capabilities.request<GroupRecord[]>('groups.list@1', undefined, signal)
    .catch(error => { if (isCapabilityUnavailable(error, 'groups.list@1')) return []; throw error; }) : [];
  const sources = new Map<string, AIContextSource[]>();
  for (const source of catalog) {
    if (source.kind !== 'text' || source.automaticRetrieval === false) continue;
    const key = normalize(source.title);
    if (key) sources.set(key, [...(sources.get(key) ?? []), source]);
  }
  const ids = new Set<string>();
  let group = false;
  const add = (raw: string, groupOnly = false) => {
    const key = normalize(raw);
    if (!key) return;
    const matchedGroups = groupOnly ? groups.filter(item => normalize(item.title) === key || normalize(item.title) === `${key}组`) : [];
    const matchedSources = groupOnly ? [] : sources.get(key) ?? [];
    if (matchedGroups.length + matchedSources.length > 1) {
      throw new Error(`找到多个「${raw}」。请选择一个节点并拖到输入框，或使用唯一的完整标题。`);
    }
    if (matchedGroups[0]) {
      group = true;
      const members = new Set(matchedGroups[0].memberIds);
      const selected = catalog.filter(source => members.has(source.sourceId) && source.kind === 'text');
      if (selected.length !== members.size || selected.some(source => source.automaticRetrieval === false)) {
        throw new Error(`「${raw}」包含不可自动读取的成员，请明确引用要处理的节点。`);
      }
      selected.forEach(source => ids.add(source.sourceId));
    } else if (matchedSources[0]) ids.add(matchedSources[0].sourceId);
    else if (groupOnly) throw new Error(`找不到群组「${raw}」。请检查群组名称。`);
  };
  const literals: Array<{ title: string; group: boolean }> = [];
  const quoted = prompt.replace(QUOTED, (match, a: string, b: string, c: string, d: string, e: string, index: number) => {
    const left = prompt.slice(0, index);
    const right = prompt.slice(index + match.length);
    const inScope = !/[，。；;：:\r\n]/u.test(left) || /(?:结合|参考|对比|根据)\s*$/u.test(left);
    if (!inScope) return ' ';
    literals.push({ title: a ?? b ?? c ?? d ?? e, group: /(?:群组|组)\s*$/u.test(left) || /^\s*(?:群组|组)(?:里的?|中的?|内|全部|所有|[，。；]|$)/u.test(right) });
    return `\u0000${literals.length - 1}\u0000`;
  });
  const scope = quoted.trim().replace(SCOPE_WORDS, '').split(/[，。；;：:\r\n]/u, 1)[0] ?? '';
  const initialSize = ids.size;
  for (const part of scope.split(/\s*(?:、|和|与|以及|跟|对比|比较)\s*/u)) {
    const literal = /\u0000(\d+)\u0000/u.exec(part);
    if (literal) {
      const { title, group } = literals[Number(literal[1])]!;
      add(title, group);
      continue;
    }
    const name = part.trim().replace(/^节点\s*/u, '').replace(/\s*(?:的?(?:正文|内容|全文)|的差异|的异同|有什么不同|有什么差异|做个总结|总结一下|概括一下|归纳一下|里的全部节点|中的全部节点|节点)$/u, '').trim();
    const explicitGroup = /^(?:群组|组)\s*(.+)$/u.exec(name) ?? /^(.+?)(?:群组|组)(?:里的?|中的?|内)?(?:全部|所有)?(?:节点|内容|正文)?$/u.exec(name);
    if (explicitGroup && (groups.length || /^(?:群组|组)/u.test(name))) add(explicitGroup[1]!, true);
    else add(name);
  }
  if (group && !ids.size) throw new Error('这个群组还没有正文节点。');
  if (operation === 'compare' && ids.size - initialSize === 1 && /和|与|以及|对比|比较/u.test(scope)) {
    throw new Error('只定位到一个对比来源。请检查另一节点的完整标题，或把节点拖到输入框。');
  }
  return { ids: [...ids], group };
}
