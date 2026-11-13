import type { CanvasControlAction, CanvasControlPlan } from '../protocols/canvas-control.ts';

export const CANVAS_CONTROL_MAX_ACTIONS = 100;
export const CANVAS_CONTROL_MAX_TEXT = 100_000;
export const CANVAS_CONTROL_MAX_OBJECTS = 80;
const FIELDS: Record<CanvasControlAction['type'], readonly string[]> = {
  'create-node': ['type', 'ref', 'title', 'text', 'x', 'y', 'width', 'height', 'color', 'presentation'],
  'update-node': ['type', 'id', 'title', 'text', 'append', 'x', 'y', 'width', 'height', 'color', 'presentation'],
  'create-group': ['type', 'ref', 'title', 'members', 'color'],
  'update-group': ['type', 'id', 'title', 'members', 'color'],
  'create-connection': ['type', 'ref', 'from', 'to', 'line', 'label', 'color'],
  'update-connection': ['type', 'id', 'from', 'to', 'line', 'label', 'color'],
  delete: ['type', 'ids'],
};
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function requireInput(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function id(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/u.test(value);
}
export function validateCanvasControlActions(value: unknown, allowEmpty = false, version: 1 | 2 = 1): asserts value is CanvasControlAction[] {
  requireInput(Array.isArray(value) && (allowEmpty || value.length > 0) && value.length <= CANVAS_CONTROL_MAX_ACTIONS, '画布计划须包含最多 100 项操作');
  const refs = new Set<string>();
  const changed = new Set<string>();
  let textLength = 0;
  for (const action of value) {
    requireInput(record(action) && typeof action.type === 'string' && Object.hasOwn(FIELDS, action.type), '画布计划包含未知操作');
    const type = action.type as CanvasControlAction['type'];
    requireInput(Object.keys(action).every(key => FIELDS[type].includes(key) || (version === 2 && type === 'update-node' && key === 'edit')), '画布计划包含不支持的字段');
    if (type.startsWith('create-')) {
      requireInput(id(action.ref) && !refs.has(action.ref), '新对象代号无效或重复');
      refs.add(action.ref);
    } else if (type !== 'delete') {
      requireInput(id(action.id) && !changed.has(action.id), '同一对象只能有一项修改，请合并字段');
      changed.add(action.id);
      requireInput(Object.keys(action).length > 2, '修改操作没有实际内容');
    }
    if (type === 'create-node' || type === 'create-group') requireInput(typeof action.title === 'string', '新对象缺少标题');
    if (action.title !== undefined) requireInput(typeof action.title === 'string' && action.title.trim().length > 0 && action.title.length <= 300, '对象标题须为 1 到 300 字符');
    for (const key of ['text', 'append'] as const) if (action[key] !== undefined) {
      requireInput(typeof action[key] === 'string', '节点正文必须是文字');
      textLength += action[key].length;
    }
    requireInput(action.text === undefined || action.append === undefined, '不能同时替换和追加同一正文');
    if (action.edit !== undefined) {
      const edit = action.edit;
      requireInput(version === 2 && type === 'update-node' && record(edit) && Object.keys(edit).every(key => ['start', 'deleteCount', 'insert', 'expectedRevision'].includes(key)) &&
        Number.isSafeInteger(edit.start) && Number(edit.start) >= 0 && Number.isSafeInteger(edit.deleteCount) && Number(edit.deleteCount) >= 0 &&
        Number.isSafeInteger(edit.expectedRevision) && Number(edit.expectedRevision) >= 1 && typeof edit.insert === 'string', '局部修改范围或修订无效');
      requireInput(action.text === undefined && action.append === undefined, '局部修改不能同时替换全文或追加');
      textLength += edit.insert.length;
    }
    for (const key of ['x', 'y', 'width', 'height'] as const) if (action[key] !== undefined) {
      requireInput(typeof action[key] === 'number' && Number.isFinite(action[key]) && Math.abs(action[key]) <= 1_000_000, '节点位置或尺寸无效');
      if (key === 'width' || key === 'height') requireInput(Number(action[key]) > 0, '节点尺寸必须大于零');
    }
    if (action.presentation !== undefined) requireInput(action.presentation === 'card' || action.presentation === 'text-box', '节点显示方式无效');
    if (action.color !== undefined) requireInput(typeof action.color === 'string' && /^#[a-f0-9]{6}$/iu.test(action.color), '对象颜色须为六位十六进制色值');
    if (action.label !== undefined) requireInput(typeof action.label === 'string' && action.label.length <= 200, '连线标签超过 200 字符');
    if (action.line !== undefined) requireInput(action.line === 'solid' || action.line === 'dashed', '连线只能是实线或虚线');
    if (type === 'create-connection') requireInput(id(action.from) && id(action.to) && action.line !== undefined, '新连线缺少端点或线型');
    for (const key of ['from', 'to'] as const) if (action[key] !== undefined) requireInput(id(action[key]), '连线端点无效');
    if (type === 'create-group') requireInput(Array.isArray(action.members), '新群组缺少成员');
    for (const key of ['members', 'ids'] as const) if (action[key] !== undefined) {
      const ids = action[key];
      requireInput(Array.isArray(ids) && ids.length > 0 && ids.length <= CANVAS_CONTROL_MAX_OBJECTS && ids.every(id), '对象列表无效或超过 80 项');
      requireInput(new Set(ids).size === ids.length, '对象列表中有重复项');
      if (key === 'ids') for (const target of ids) {
        requireInput(!changed.has(target), '不能同时修改和删除同一对象');
        changed.add(target);
      }
    }
    if (type === 'delete') requireInput(Array.isArray(action.ids), '删除操作缺少对象');
  }
  requireInput(textLength <= CANVAS_CONTROL_MAX_TEXT, '本次画布操作文字超过十万字符，请分批生成');
  requireInput([...refs].every(ref => !changed.has(ref)), '请把新对象的全部字段放在创建操作里');
}
export function parseCanvasControlPlan(text: string): CanvasControlPlan {
  requireInput(text.length <= CANVAS_CONTROL_MAX_TEXT + 30_000, '画布计划过长，请分批生成');
  const trimmed = text.replace(/^\uFEFF/u, '').trim();
  const fenced = /^```(?:json|e8-control)?\s*\r?\n([\s\S]*?)\r?\n```$/iu.exec(trimmed);
  let value: unknown;
  try { value = JSON.parse(fenced?.[1] ?? trimmed) as unknown; }
  catch { throw new Error('AI 未返回完整的画布操作计划，请重新生成'); }
  requireInput(record(value) && (value.version === 1 || value.version === 2) && Object.keys(value).every(key => key === 'version' || key === 'actions' || key === 'answer'), '画布操作计划版本或字段不正确');
  requireInput(value.answer === undefined || (typeof value.answer === 'string' && value.answer.length <= 4000), '画布答复过长');
  validateCanvasControlActions(value.actions, true, value.version);
  return { version: value.version, actions: value.actions, ...(typeof value.answer === 'string' ? { answer: value.answer } : {}) };
}
