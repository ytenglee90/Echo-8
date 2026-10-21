import type { AIInlineReference, AIOperation } from '../../protocols/ai.ts';
import { AI_OPERATION_DEFINITIONS, type AIOperationCategory } from './operations.ts';

export const AI_OPERATION_COMMANDS: ReadonlyArray<{
  label: string;
  operation: AIOperation;
  category: AIOperationCategory;
  description: string;
}> = [
  ...AI_OPERATION_DEFINITIONS,
];

const COMMAND_BY_LABEL = new Map(AI_OPERATION_COMMANDS.map((command) => [command.label, command.operation]));
const commandAlternatives = AI_OPERATION_COMMANDS.map((command) => escapeRegExp(command.label)).join('|');
const COMMAND_PATTERN = new RegExp(
  `(^|[\\s，。！？、；：,.!?;:])@(${commandAlternatives})(?=\\s|$|[，。！？、；：,.!?;:])[ \\t]*`,
  'gu',
);

export function explicitAtOperation(prompt: string): AIOperation | undefined {
  const match = [...prompt.matchAll(COMMAND_PATTERN)].at(-1);
  return match ? COMMAND_BY_LABEL.get(match[2]) : undefined;
}

export function inferAtOperation(prompt: string): AIOperation {
  return explicitAtOperation(prompt) ?? 'general';
}

export function stripOperationCommands(prompt: string): string {
  return prompt.replace(COMMAND_PATTERN, (_whole, prefix: string) => prefix);
}

export interface AtQuery {
  start: number;
  end: number;
  query: string;
}

export function atQueryAt(text: string, caret: number): AtQuery | undefined {
  const safeCaret = Math.min(Math.max(0, caret), text.length);
  const prefix = text.slice(0, safeCaret);
  const match = prefix.match(/(?:^|[\s，。！？、；：,.!?;:])@([^@\s[\]()]{0,120})$/u);
  if (!match || match.index === undefined) return undefined;
  const at = match.index + (match[0].startsWith('@') ? 0 : 1);
  return { start: at, end: safeCaret, query: match[1] };
}

export function replaceAtQuery(text: string, query: AtQuery, token: string): {
  text: string;
  caret: number;
} {
  const insertion = `${token} `;
  return {
    text: `${text.slice(0, query.start)}${insertion}${text.slice(query.end)}`,
    caret: query.start + insertion.length,
  };
}

export function compactReferenceToken(title: string, sourceId: string, duplicateTitle = false): string {
  const clean = title.replaceAll('[', ' ').replaceAll(']', ' ').replace(/[\r\n]+/gu, ' ')
    .replace(/\s+/gu, ' ').trim() || '未命名节点';
  const visible = clean.length > 32 ? `${clean.slice(0, 31)}…` : clean;
  const suffix = duplicateTitle ? ` · ${shortSourceId(sourceId)}` : '';
  return `@[${visible}${suffix}]`;
}

export function activeInlineReferences(
  prompt: string,
  references: readonly AIInlineReference[],
): AIInlineReference[] {
  const ids = new Set<string>();
  return references.filter((reference) => {
    if (!prompt.includes(reference.token) || ids.has(reference.sourceId)) return false;
    ids.add(reference.sourceId);
    return true;
  });
}

function shortSourceId(sourceId: string): string {
  const clean = sourceId.replace(/[^a-z0-9]/giu, '');
  return (clean.slice(-6) || '节点').toLocaleUpperCase('zh-CN');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
