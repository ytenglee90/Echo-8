import type { PluginContext } from '../../core/contracts.ts';
import type { CanvasControlAdmission } from '../../protocols/canvas-control.ts';
import type { AIContextCatalogContribution } from '../../protocols/ai.ts';
import { canvasCommandText } from '../../services/ai-task-route.ts';
import { optionalControlOwner } from './context.ts';
import type { StoredControlReview } from './task-state.ts';

export async function discoverControlTargets(context: PluginContext, input: CanvasControlAdmission, reviews: readonly StoredControlReview[], signal?: AbortSignal) {
  const command = canvasCommandText(input.prompt).replace(/^\s*@画布操作\s*/u, '');
  const relations = /连线|连接|相连|连到|接到|接上|实线|虚线|线型|插入|引用/u.test(command);
  const named = /找|查|有|查看|设计|补充|续写|改写|修改|改色|添加|新建|创建|移动|分组|节点|正文|对象/u.test(command) || relations;
  const names = named ? await findNamedNodes(context, command, signal) : [];
  const lineFollowup = /实线|虚线|线型|这条线|刚才.{0,8}(?:连|线)|上(?:一|次).{0,8}(?:连|线)/u.test(command);
  const last = lineFollowup ? reviews.findLast(draft => draft.review.sessionId === input.sessionId && draft.review.status === 'applied' &&
    draft.review.actions.some(action => action.type === 'create-connection' || action.type === 'update-connection')) : undefined;
  const recentLineIds = last ? [...(last.createdIds ?? []), ...last.review.actions.flatMap(action => action.type === 'update-connection' ? [action.id] : [])] : [];
  return { names, relations, recentLineIds };
}

async function findNamedNodes(context: PluginContext, command: string, signal?: AbortSignal): Promise<string[]> {
  const catalogs = await context.capabilities.requestAll<AIContextCatalogContribution>('context.catalog@1', undefined, signal).catch(optionalControlOwner);
  const query = command.normalize('NFKC').toLocaleLowerCase();
  const matches = new Map<string, Set<string>>();
  for (const source of catalogs?.flatMap(catalog => catalog.sources) ?? []) {
    if (source.kind !== 'text' || source.automaticRetrieval === false) continue;
    const title = source.title.normalize('NFKC').trim().toLocaleLowerCase();
    if (title.length < 2 || !query.includes(title)) continue;
    if (/^[\p{Script=Latin}\d _-]+$/u.test(title) && !new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(title)}(?:$|[^a-z0-9])`, 'u').test(query)) continue;
    const ids = matches.get(title) ?? new Set<string>();
    ids.add(source.sourceId);
    matches.set(title, ids);
  }
  const titles = [...matches.keys()].filter(title => ![...matches.keys()].some(other => other !== title && other.includes(title)));
  if (titles.length > 8) return [];
  return titles.flatMap(title => {
    const ids = matches.get(title)!;
    return ids.size === 1 ? [...ids] : [];
  });
}

function escapeRegExp(text: string): string { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
