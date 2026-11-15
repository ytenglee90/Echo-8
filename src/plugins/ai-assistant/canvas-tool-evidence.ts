import type { AIGenerateRequest, AIPreparedContext } from '../../protocols/ai.ts';
import type { CanvasAgentQueryResult, CanvasAgentReadResult } from '../../protocols/canvas-agent.ts';
import { agentDirectory, DIRECTORY_FIELDS, projectCanvasObjects, readCanvasDirectory, type CanvasRequestScope } from './canvas-request-scope.ts';

type Reference = { source: number } | { previousCall: string };
type SentRange = { id: string; revision: number; start: number; text: string; reference: Reference };

export function canvasToolEvidence(initial: AIGenerateRequest, prepared: AIPreparedContext, scope: CanvasRequestScope | undefined) {
  const objects = new Map<string, { fields: Record<string, unknown>; seenIn: string }>();
  const initialDirectory = readCanvasDirectory(initial.messages.find(message => message.content.startsWith('<untrusted-canvas-objects>\n'))?.content);
  for (const key of DIRECTORY_FIELDS) {
    for (const item of initialDirectory[key] ?? []) objects.set(key + item.id, { fields: item, seenIn: '对象目录' });
  }
  const openingEvidence = initial.messages.find(message => message.content.startsWith('画布原文证据：\n'))?.content;
  const ranges: SentRange[] = prepared.sources.flatMap((source, index) =>
    source.kind === 'text' && source.reason === 'explicit-reference' && source.text &&
    openingEvidence?.includes(`[来源 ${index + 1}]`) && openingEvidence.includes(source.text)
      ? [{ id: source.sourceId, revision: source.revision, start: source.start, text: source.text, reference: { source: index + 1 } }]
      : []);

  function query(result: CanvasAgentQueryResult, mode: unknown, callId: string) {
    const raw = agentDirectory(result);
    const queryScope = scope && mode === 'relations' ? new Set([...scope, 'links', 'groups'] as const) : scope;
    const directory = queryScope ? projectCanvasObjects(raw, queryScope) : raw;
    const updates: Array<[string, Record<string, unknown>]> = [];
    const rows = Object.fromEntries(DIRECTORY_FIELDS.flatMap(key => {
      const entries = directory[key];
      if (!entries?.length) return [];
      return [[key, entries.map(item => {
        const id = key + item.id;
        const prior = objects.get(id);
        if (prior && Object.entries(item).every(([field, value]) => JSON.stringify(prior.fields[field]) === JSON.stringify(value))) {
          const reference = { id: item.id, seenIn: prior.seenIn };
          if (JSON.stringify(reference).length < JSON.stringify(item).length) return reference;
        }
        updates.push([id, item]);
        return item;
      })]];
    }));
    const { total, nextCursor, selectedIds, recentIds, createdIds, pendingTask, available, tasks } = result;
    const metadata = { total, nextCursor, selectedIds, recentIds, createdIds, pendingTask, available };
    const recentPlans = scope && tasks ? tasks.plans.map(({ goal, status, actionCount, targets }) => ({ goal, status, actionCount,
      targets: targets.map(target => target.id) })) : undefined;
    return { value: { ...rows, ...metadata, ...(recentPlans ? { recentPlans } : tasks ? { tasks } : {}) },
      record: () => { for (const [id, fields] of updates) objects.set(id, { fields, seenIn: callId }); } };
  }

  function read(result: CanvasAgentReadResult, callId: string) {
    const { id, revision, start, text, ...location } = result;
    const end = start + text.length;
    const overlaps = ranges.filter(part => {
      if (part.id !== id || part.revision !== revision) return false;
      const left = Math.max(start, part.start);
      const right = Math.min(end, part.start + part.text.length);
      return right > left && text.slice(left - start, right - start) === part.text.slice(left - part.start, right - part.start);
    });
    const newRanges: SentRange[] = [];
    const parts: Array<{ start: number; text: string } | { start: number; length: number } & Reference> = [];
    if (overlaps.length) {
      let offset = start;
      while (offset < end) {
        const matching = overlaps.filter(part => part.start <= offset && part.start + part.text.length > offset)
          .sort((left, right) => right.start + right.text.length - left.start - left.text.length)[0];
        if (matching) {
          const next = Math.min(end, matching.start + matching.text.length);
          const { reference } = matching;
          parts.push({ start: offset, length: next - offset, ...reference });
          offset = next;
        } else {
          const next = Math.min(end, ...overlaps.filter(part => part.start > offset).map(part => part.start));
          const content = text.slice(offset - start, next - start);
          parts.push({ start: offset, text: content });
          newRanges.push({ id, revision, start: offset, text: content, reference: { previousCall: callId } });
          offset = next;
        }
      }
    }
    const reference = parts.length === 1 && !('text' in parts[0]!) ? parts[0] : undefined;
    const packed = reference ? { id, revision, ...location, ...reference }
      : { id, revision, start, ...location, ...(parts.length ? { parts } : {}) };
    const usePacked = parts.length > 0 && JSON.stringify(packed).length < JSON.stringify(result).length;
    return { value: usePacked ? packed : result, record: () => {
      if (usePacked) ranges.push(...newRanges);
      else if (text) ranges.push({ id, revision, start, text, reference: { previousCall: callId } });
    } };
  }

  return { query, read };
}
