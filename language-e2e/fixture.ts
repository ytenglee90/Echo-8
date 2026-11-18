import { ApplicationKernel } from '../src/core/kernel.ts';
import { createTextNodePlugin } from '../src/plugins/text-node/plugin.ts';
import { createSelectionPlugin } from '../src/plugins/selection/model.ts';
import { createGroupsPlugin } from '../src/plugins/groups/model.ts';
import { createConnectionsPlugin } from '../src/plugins/connections/model.ts';
import { createAnnotationsPlugin } from '../src/plugins/annotations/model.ts';
import { serializeProject } from '../src/plugins/import-export/codec.ts';
import type { ProjectSource } from '../src/protocols/files.ts';
import type { ContentSummary } from '../src/protocols/content.ts';

export interface Fixture { bytes: Buffer; ids: Record<string, string>; edgeId: string; annotationId: string; source: ProjectSource; junctionId?: string }
export const LANGUAGE_FIXTURE_RECORDS = [
  ['第一章', '第一段：主角决定追查旧案。\n\n第二段：配角提供了一条线索。\n\n第三段：旧塔确实发生过火灾。'],
  ['第二章', '第一段：配角决定追查旧案。\n\n第二段：配角提供了一条线索。\n\n第三段：旧塔确实发生过火灾。'],
  ['主角', '姓名：林舟。年龄：二十岁。旧案让他重新回到故乡。'],
  ['配角', '姓名：沈青。职业：调查员。她掌握旧案的另一份证据。'],
  ['反派', '姓名：陆衡。为了掩盖旧案，他封锁了旧塔。'],
  ['空白1', ''], ['空白2', ''], ['线索', '旧塔中的铜钥匙。'], ['世界观', '故事发生在架空的临海城。势力包括巡夜司和商会。'],
] as const;
const fixtures = new Map<boolean, Promise<Fixture>>();
export function languageFixture(junction = false): Promise<Fixture> {
  if (!fixtures.has(junction)) fixtures.set(junction, build(junction));
  return fixtures.get(junction)!;
}
async function build(withJunction: boolean): Promise<Fixture> {
  const kernel = new ApplicationKernel([createTextNodePlugin(), createSelectionPlugin(), createGroupsPlugin(), createConnectionsPlugin(), createAnnotationsPlugin()]);
  await kernel.start();
  const initial = await kernel.capabilities.request<ContentSummary[]>('content.summaries@1');
  await kernel.router.dispatch('selection.set', { ids: initial.map(node => node.id) }, 'core.test');
  await kernel.router.dispatch('selection.delete', undefined, 'core.test');
  const ids: Record<string, string> = {};
  for (const [i, [title, body]] of LANGUAGE_FIXTURE_RECORDS.entries()) {
    const result = await kernel.router.dispatch<{ id: string }>('node.create', { title, body, x: 80 + i % 3 * 360, y: 60 + Math.floor(i / 3) * 250 }, 'core.test');
    ids[title!] = result.id;
  }
  await kernel.router.dispatch('selection.set', { ids: [ids['主角'], ids['配角']] }, 'core.test');
  await kernel.router.dispatch('group.create', { title: '人物组' }, 'core.test');
  await kernel.router.dispatch('selection.set', { ids: [ids['线索'], ids['世界观']] }, 'core.test');
  await kernel.router.dispatch('group.create', { title: '线索组' }, 'core.test');
  const edge = await kernel.router.dispatch<{ id: string }>('connection.create', {
    from: { nodeId: ids['主角'], side: 'right' }, to: { nodeId: ids['反派'], side: 'left' },
  }, 'core.test');
  const annotation = await kernel.router.dispatch<{ id: string }>('annotation.create', { target: { kind: 'text-node', targetId: ids['第一章'] }, body: '需核对' }, 'core.test');
  const junction = withJunction ? await kernel.router.dispatch<{ id: string }>('connection.addJunction', {
    x: 650, y: 220, connections: [{ id: edge.id, revision: 1 }],
  }, 'core.test') : undefined;
  const source = await kernel.router.ask<ProjectSource>('system.project.source', undefined, 'core.test');
  const blob = await serializeProject(source);
  for (const plugin of kernel.plugins.list().reverse()) if (plugin.status === 'active') await kernel.plugins.stop(plugin.id);
  return { bytes: Buffer.from(await blob.arrayBuffer()), ids, edgeId: edge.id, annotationId: annotation.id, source, junctionId: junction?.id };
}
