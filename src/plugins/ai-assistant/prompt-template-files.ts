import { isRecord } from '../../core/contracts.ts';
import type { AIPromptTemplateCatalog, AIPromptTemplateRecord } from '../../protocols/ai.ts';

const MAX_PROMPT_TEMPLATES = 24;
const MAX_TEMPLATE_ID_LENGTH = 160;
const MAX_TEMPLATE_NAME_LENGTH = 80;
const MAX_SYSTEM_INSTRUCTION_LENGTH = 12_000;
const MAX_USER_INSTRUCTION_LENGTH = 8_000;

export interface PromptTemplateDraft {
  id?: string;
  name: string;
  systemInstruction: string;
  userInstruction: string;
}

export function isPromptTemplateDraft(value: unknown): value is PromptTemplateDraft {
  return isRecord(value) &&
    (value.id === undefined || typeof value.id === 'string') &&
    typeof value.name === 'string' && value.name.trim().length > 0 &&
    value.name.trim().length <= MAX_TEMPLATE_NAME_LENGTH &&
    typeof value.systemInstruction === 'string' &&
    value.systemInstruction.length <= MAX_SYSTEM_INSTRUCTION_LENGTH &&
    typeof value.userInstruction === 'string' &&
    value.userInstruction.length <= MAX_USER_INSTRUCTION_LENGTH &&
    Boolean(value.systemInstruction.trim() || value.userInstruction.trim());
}

export function parsePromptTemplateFile(text: string): PromptTemplateDraft {
  const normalized = text.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
  const systemMarker = '\n\n系统工作方式：\n';
  const taskMarker = '\n\n本次任务前缀：\n';
  if (!normalized.startsWith('模板名称：') || !normalized.includes(systemMarker) || !normalized.includes(taskMarker)) {
    throw new Error('这不是有效的 Echo-8 Prompt 文本模板');
  }
  const systemStart = normalized.indexOf(systemMarker);
  const taskStart = normalized.indexOf(taskMarker, systemStart + systemMarker.length);
  if (taskStart < 0) throw new Error('这不是有效的 Echo-8 Prompt 文本模板');
  const draft = {
    name: normalized.slice('模板名称：'.length, systemStart).trim(),
    systemInstruction: normalized.slice(systemStart + systemMarker.length, taskStart).trim(),
    userInstruction: normalized.slice(taskStart + taskMarker.length).trim(),
  };
  if (!isPromptTemplateDraft(draft)) throw new Error('Prompt 模板内容不完整或超过长度限制');
  return draft;
}

export function serializePromptTemplateFile(
  template: Pick<AIPromptTemplateRecord, 'name' | 'systemInstruction' | 'userInstruction'>,
): string {
  return [
    `模板名称：${template.name.trim()}`,
    `系统工作方式：\n${template.systemInstruction.trim()}`,
    `本次任务前缀：\n${template.userInstruction.trim()}`,
  ].join('\n\n');
}

export function uniquePromptTemplateName(name: string, templates: AIPromptTemplateRecord[]): string {
  const base = name.trim();
  const occupied = new Set(templates.map((template) => template.name.trim().toLocaleLowerCase('zh-CN')));
  if (!occupied.has(base.toLocaleLowerCase('zh-CN'))) return base;
  let ordinal = 2;
  while (occupied.has(`${base} (${ordinal})`.toLocaleLowerCase('zh-CN'))) ordinal += 1;
  return `${base} (${ordinal})`;
}

export function isPromptTemplateCatalog(value: unknown): value is AIPromptTemplateCatalog {
  return isRecord(value) && Array.isArray(value.templates) && value.templates.length <= MAX_PROMPT_TEMPLATES &&
    value.templates.every(isPromptTemplateRecord) &&
    (value.activeTemplateId === undefined || typeof value.activeTemplateId === 'string');
}

export function normalizePromptTemplateCatalog(
  templatesValue: unknown,
  activeValue: unknown,
): AIPromptTemplateCatalog {
  const templates = Array.isArray(templatesValue)
    ? templatesValue.filter(isPromptTemplateRecord).slice(0, MAX_PROMPT_TEMPLATES)
    : [];
  const activeTemplateId = typeof activeValue === 'string' &&
    templates.some((template) => template.id === activeValue)
    ? activeValue
    : undefined;
  return { activeTemplateId, templates };
}

export function isPromptTemplateRecord(value: unknown): value is AIPromptTemplateRecord {
  return isRecord(value) &&
    typeof value.id === 'string' && value.id.length > 0 && value.id.length <= MAX_TEMPLATE_ID_LENGTH &&
    typeof value.name === 'string' && value.name.length > 0 && value.name.length <= MAX_TEMPLATE_NAME_LENGTH &&
    typeof value.systemInstruction === 'string' &&
    value.systemInstruction.length <= MAX_SYSTEM_INSTRUCTION_LENGTH &&
    typeof value.userInstruction === 'string' &&
    value.userInstruction.length <= MAX_USER_INSTRUCTION_LENGTH &&
    typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) &&
    typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt);
}
