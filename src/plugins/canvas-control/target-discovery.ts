import type { PluginContext } from '../../core/contracts.ts';
import type { CanvasControlAdmission } from '../../protocols/canvas-control.ts';
import type { AIContextCatalogContribution } from '../../protocols/ai.ts';
import { canvasCommandText } from '../../services/ai-task-route.ts';
import { canvasTitleAliases, normalizeCanvasTitle } from '../../services/canvas-titles.ts';
import { optionalControlOwner } from './context.ts';
import type { StoredControlReview } from './task-state.ts';

export async function discoverControlTargets(context: PluginContext, input: CanvasControlAdmission, reviews: readonly StoredControlReview[], signal?: AbortSignal) {
  const command = canvasCommandText(input.prompt).replace(/^\s*@画布操作\s*/u, '');
  const relations = /连线|连接|相连|连到|连起|连上|接到|接上|拉线|画线|实线|虚线|线型|插入|引用/u.test(command);
  const names = await findNamedNodes(context, command, signal);
  const lineFollowup = /实线|虚线|线型|这条线|刚才.{0,8}(?:连|线)|上(?:一|次).{0,8}(?:连|线)/u.test(command);
  const last = lineFollowup ? reviews.findLast(draft => draft.review.sessionId === input.sessionId && draft.review.status === 'applied' &&
    draft.review.actions.some(action => action.type === 'create-connection' || action.type === 'update-connection')) : undefined;
  const recentLineIds = last ? [...(last.createdIds ?? []), ...last.review.actions.flatMap(action => action.type === 'update-connection' ? [action.id] : [])] : [];
  return { names, relations, recentLineIds };
}

async function findNamedNodes(context: PluginContext, command: string, signal?: AbortSignal): Promise<string[]> {
  const catalogs = await context.capabilities.requestAll<AIContextCatalogContribution>('context.catalog@1', undefined, signal).catch(optionalControlOwner);
  const query = normalizeCanvasTitle(command);
  const matches = new Map<string, Set<string>>();
  for (const source of catalogs?.flatMap(catalog => catalog.sources) ?? []) {
    if (source.kind !== 'text' || source.automaticRetrieval === false) continue;
    for (const alias of canvasTitleAliases(source.title)) {
      const quoted = ['「' + alias + '」', '『' + alias + '』', '“' + alias + '”', '"' + alias + '"'].some(literal => query.includes(literal));
      if (!quoted && (alias.length < 2 || !query.includes(alias))) continue;
      if (!quoted && /^[\p{Script=Latin}\d _-]+$/u.test(alias) && !new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(alias)}(?:$|[^a-z0-9])`, 'u').test(query)) continue;
      const ids = matches.get(alias) ?? new Set<string>();
      ids.add(source.sourceId);
      matches.set(alias, ids);
    }
  }
  const titles = [...matches.keys()];
  if (titles.length > 24) return [];
  const distinct = titles.filter(title => !titles.some(other => other !== title && other.includes(title) && query.replaceAll(other, '').indexOf(title) === -1));
  const ids = [...new Set(distinct.flatMap(title => {
    const matchesForTitle = matches.get(title)!;
    return matchesForTitle.size === 1 ? [...matchesForTitle] : [];
  }))];
  return ids.length <= 8 ? ids : [];
}

function escapeRegExp(text: string): string { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
