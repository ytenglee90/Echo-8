import { isRecord } from '../../core/contracts.ts';
import type { AIPreparedContext } from '../../protocols/ai.ts';
import type { CanvasAgentQueryResult } from '../../protocols/canvas-agent.ts';
import type { CanvasControlPlan } from '../../protocols/canvas-control.ts';
import { canvasCommandText } from '../../services/ai-task-route.ts';
import { naturalCanvasOperation } from '../../services/ai-task-route.ts';
import { compileLocalInstructions } from './local-turn-routing.ts';
import { classifyAITurn } from './turn-route.ts';
import type { FieldTarget } from './structured-fields.ts';
import type { TurnAssembly } from './turn-route.ts';

export type BoundCanvasWrite =
  | { kind: 'create'; plan: CanvasControlPlan; titles: string[] }
  | { kind: 'write'; target: FieldTarget; instruction: string }
  | { kind: 'fields'; targets: FieldTarget[]; field: string; sourceNumbers: number[] };

export function resolveBoundCanvasWrite(
  prepared: AIPreparedContext, assembly: TurnAssembly, state: CanvasAgentQueryResult | undefined,
): BoundCanvasWrite | undefined {
  const { route, fields, field, destinationId, readIds, contentTargetId } = assembly;
  if (!state || route.category === 'chat' || assembly.recoveryPrompt) return undefined;

  if (route.creationText) {
    const instruction = route.creationText.instruction;
    const compiled = compileLocalInstructions(instruction, classifyAITurn(instruction));
    const steps = (compiled?.instructions ?? [instruction]).map(naturalCanvasOperation);
    if (!steps.length || steps.length > 80 || steps.some(step => step?.kind !== 'create' || step.names.length)) return undefined;
    const actions = steps.map((step, index) => {
      if (step?.kind !== 'create') throw new Error('新建目标尚未明确');
      return { type: 'create-node' as const, ref: `local-text-${index}`, title: step.title, presentation: step.presentation };
    });
    return { kind: 'create', plan: { version: 2, actions }, titles: actions.map(action => action.title) };
  }

  const explicit = prepared.sources.filter(source => source.reason === 'explicit-reference');
  const resolve = (id: string) => {
    const node = state.nodes.find(item => item.id === id);
    const source = explicit.find(item => item.sourceId === id && item.provider === 'text-node' &&
      item.kind === 'text' && item.complete === true && item.revision === node?.revision);
    return node && source ? { node, source, whole: source.start === 0 && source.length === node.length } : undefined;
  };
  if (assembly.restructure) {
    const binding = assembly.restructure;
    if (!binding.ids.every(id => resolve(id)?.whole)) return undefined;
    // Multiple destinations cannot silently guess how each existing edge should be reconnected.
    if (binding.reconnect && binding.titles.length !== 1) return undefined;
    const actions: CanvasControlPlan['actions'] = binding.titles.map((title, index) => ({
      type: 'create-node', ref: `local-text-${index}`, title,
    }));
    if (binding.reconnect) for (const edge of assembly.relations ?? []) {
      const from = binding.ids.includes(edge.from), to = binding.ids.includes(edge.to);
      if (from !== to) actions.push({ type: 'update-connection', id: edge.id,
        ...(from ? { from: 'local-text-0' } : { to: 'local-text-0' }) });
    }
    return { kind: 'create', plan: { version: 2, actions }, titles: binding.titles };
  }
  if (fields?.length && field && fields.every(target => {
    const resolved = resolve(target.id);
    return resolved?.whole && target.expectedRevision === resolved.node.revision &&
      target.start + target.deleteCount <= resolved.node.length;
  })) {
    return { kind: 'fields', targets: fields, field,
      sourceNumbers: fields.map(target => prepared.sources.indexOf(resolve(target.id)!.source) + 1) };
  }
  if (destinationId && readIds?.length && readIds.every(id => resolve(id)?.whole)) {
    const target = resolve(destinationId);
    if (target) return appendTo(target.node, '按用户要求综合已提供的来源，生成要追加到目标卡片的结果。');
  }

  const command = canvasCommandText(prepared.prompt);
  const writeGeneratedText = route.local?.kind === 'content' && route.local.writeGeneratedText;
  if (route.category !== 'operation' || route.history ||
    !writeGeneratedText && /同时|顺便|并且|然后|之后|再把|再将/u.test(command) ||
    /分组|连线|连接|重连|群组|改色|换色|主题|移动|移到|删掉|删除|新建|改名|插入|合并|重排|拆分/u.test(command) ||
    (route.draft && !assembly.canvasDraftBound)) return undefined;
  const range = prepared.writebackTarget;
  const id = range?.nodeId ?? contentTargetId;
  const target = id && resolve(id);
  if (!target || (assembly.explicitCanvasIds ?? explicit.map(source => source.sourceId)).some(sourceId =>
    sourceId !== id && !resolve(sourceId)?.whole)) return undefined;
  if (range) {
    const { source, node } = target;
    if (range.expectedRevision !== node.revision || range.end > node.length || source.start > range.start ||
      source.start + source.length < range.end) return undefined;
    return range.mode === 'append' ? appendTo(node, '接着已提供的正文续写，只给新增段落。') : {
      kind: 'write', target: { id: node.id, expectedRevision: node.revision, start: range.start,
        deleteCount: range.end - range.start, prefix: '' },
      instruction: `只重写目标正文所附片段内 UTF-16 偏移 ${range.start - source.start} 到 ${range.end - source.start}，只给替换文字。`,
    };
  }
  if (route.local?.kind !== 'content' || !target.whole) return undefined;
  if (route.local.replaceBody) return {
    kind: 'write', target: { id: target.node.id, start: 0, deleteCount: target.node.length, expectedRevision: target.node.revision, prefix: '' },
    instruction: '按本轮要求重写目标卡片的完整正文，只给替换后的正文。',
  };
  return appendTo(target.node, route.draft ? '按本轮要求使用已附的草稿，给出写入目标卡片的正文。' :
    '按本轮要求生成新增正文，应用会保留目标卡片已有内容。');
}

function appendTo(node: CanvasAgentQueryResult['nodes'][number], instruction: string): BoundCanvasWrite {
  return { kind: 'write', instruction,
    target: { id: node.id, start: node.length, deleteCount: 0, expectedRevision: node.revision, prefix: node.length ? '\n\n' : '' } };
}

export function boundCanvasWriteInstructions(write: BoundCanvasWrite): string {
  const rules = '应用已核对本轮写入目标和范围，并将本地提交。只输出 JSON，不要调用画布工具或输出操作计划。';
  if (write.kind === 'create') return `${rules} 按以下标题的顺序生成正文：${JSON.stringify(write.titles)}。只输出 {"texts":["正文", "..."]}，不要返回标题、对象 ID、坐标或其他操作字段。`;
  return write.kind === 'fields'
    ? `${rules} 按来源编号 ${write.sourceNumbers.join('、')} 的顺序，为每张卡填写一行「${write.field}」的值。输出 {"texts":["字段值", "..."]}，每个元素只含值。`
    : `${rules} ${write.instruction} 输出 {"text":"可直接写入的正文"}，正文从内容本身开始。`;
}

export function buildBoundCanvasWritePlan(write: BoundCanvasWrite, output: string): CanvasControlPlan {
  const invalid = () => new Error('模型没有返回符合本轮写入范围的正文，请重试');
  let value: unknown;
  try { value = JSON.parse(output.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu, '$1')); }
  catch (error) { throw new Error('模型没有返回符合本轮写入范围的正文，请重试', { cause: error }); }
  if (!isRecord(value) || Object.keys(value).length !== 1) throw invalid();
  if (write.kind === 'create') {
    const texts = value.texts;
    if (!Array.isArray(texts) || texts.length !== write.titles.length || texts.some(text => typeof text !== 'string' || !text.trim())) throw invalid();
    let index = 0;
    return { ...write.plan, actions: write.plan.actions.map(action => action.type === 'create-node'
      ? { ...action, text: (texts[index++] as string).trim() } : { ...action }) };
  }
  const targets = write.kind === 'fields' ? write.targets : [write.target];
  const texts: unknown = write.kind === 'fields' ? value.texts : [value.text];
  if (!Array.isArray(texts) || texts.length !== targets.length) throw invalid();
  const actions = targets.map(({ id, start, deleteCount, expectedRevision, prefix }, index) => {
    const text: unknown = texts[index];
    if (typeof text !== 'string' || !text.trim() || (write.kind === 'fields' && /[\r\n]/u.test(text.trim()))) throw invalid();
    return { type: 'update-node' as const, id, edit: { start, deleteCount, expectedRevision, insert: prefix + text.trim() } };
  });
  return { version: 2, actions };
}
