import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationKernel } from '../src/core/kernel.ts';
import { createTextNodePlugin } from '../src/plugins/text-node/plugin.ts';
import { createSelectionPlugin } from '../src/plugins/selection/model.ts';
import { createGroupsPlugin } from '../src/plugins/groups/model.ts';
import { createConnectionsPlugin } from '../src/plugins/connections/model.ts';
import { createCanvasControlPlugin } from '../src/plugins/canvas-control/model.ts';
import { createEditorPlugin } from '../src/plugins/editor/model.ts';
import { createClipboardPlugin } from '../src/plugins/clipboard/model.ts';
import { createSmartLayoutPlugin } from '../src/plugins/smart-layout/model.ts';
import { createAnnotationsPlugin } from '../src/plugins/annotations/model.ts';
import { historyControlsPlugin } from '../src/plugins/system/history-controls.ts';
import { workspaceActionsPlugin } from '../src/plugins/workspace-actions/model.ts';
import type { WorkspaceActionIndex, WorkspaceCoverageReport, WorkspacePlan, WorkspacePlanReceipt } from '../src/protocols/workspace-actions.ts';
import type { ContentSummary } from '../src/protocols/content.ts';
import type { CanvasControlState } from '../src/protocols/canvas-control.ts';
import type { ConnectionGraphSnapshot } from '../src/protocols/connections.ts';
import { isTitleConnection } from '../src/protocols/connections.ts';
import { classifyAITurn } from '../src/plugins/ai-assistant/turn-route.ts';
import { workspaceCatalogIntent } from '../src/services/workspace-catalog-intent.ts';
import { readWorkspaceSequence } from '../src/services/workspace-sequence-intent.ts';
import { defineManifest } from '../src/plugins/manifest.ts';
import { isRecord, type PluginDefinition } from '../src/core/contracts.ts';
import { createImportExportPlugin } from '../src/plugins/import-export/model.ts';
import { createPalettePlugin } from '../src/plugins/palette/model.ts';
import { parseProject } from '../src/plugins/import-export/codec.ts';
import type { FileArtifact, FileSaveTarget, LocalFileTaskResult } from '../src/protocols/files.ts';

const source = 'core.test';

async function harness(extra: PluginDefinition[] = []) {
  const kernel = new ApplicationKernel([
    createTextNodePlugin(), createSelectionPlugin(), createGroupsPlugin(), createConnectionsPlugin(),
    createAnnotationsPlugin(), createCanvasControlPlugin(), createEditorPlugin(), createClipboardPlugin(),
    createSmartLayoutPlugin(), historyControlsPlugin, ...extra, workspaceActionsPlugin,
  ]);
  await kernel.start();
  assert.equal(kernel.plugins.isActive('workspace-actions'), true);
  const initial = await kernel.capabilities.request<ContentSummary[]>('content.summaries@1');
  await kernel.router.dispatch('selection.set', { ids: initial.map(node => node.id) }, source);
  await kernel.router.dispatch('selection.delete', undefined, source);
  const run = (id: string, steps: WorkspacePlan['steps'], constraints?: WorkspacePlan['constraints']) =>
    kernel.router.dispatch<WorkspacePlanReceipt>('workspace.plan.run@1', { version: 1, id, steps, constraints }, source);
  const nodes = () => kernel.capabilities.request<ContentSummary[]>('content.summaries@1');
  return { kernel, run, nodes };
}

test('[A58 X08 X27] the runtime index distinguishes executable, inactive, and manual entries', async () => {
  const { kernel, run } = await harness();
  const index = () => kernel.router.ask<WorkspaceActionIndex>('workspace.actions@1', undefined, source);
  const actions = (await index()).actions;
  assert.equal(new Set(actions.map(a => a.id)).size, actions.length);
  assert.equal(actions.find(a => a.id === 'group.list')?.status, 'available');
  assert.equal(actions.find(a => a.id === 'viewport.set')?.status, 'inactive');
  assert.ok(actions.some(a => a.status === 'manual'));
  await kernel.plugins.stop('groups');
  assert.equal((await index()).actions.find(a => a.id === 'group.list')?.status, 'inactive');
  await assert.rejects(run('unavailable', [{ id: 'group', action: 'group.list' }]), /本地动作不可用/u);
});

test('[A10 A14 A29 A45 X09 X11 X17 X24] a fixed plan can find, branch, create, read, open, select and copy through feature owners', async () => {
  const { kernel, run, nodes } = await harness();
  const steps: WorkspacePlan['steps'] = [
    { id: 'find', action: 'content.find', arguments: { title: '第一章' } },
    { id: 'make', action: 'node.create', when: { step: 'find', exists: false }, arguments: {
      title: '第一章', x: 100, y: 180, text: '这里是正文。',
    } },
    { id: 'read', action: 'content.read', arguments: { target: { from: 'make' }, start: 0, length: 100 } },
    { id: 'open', action: 'editor.open', arguments: { target: { from: 'make' }, mode: 'add' } },
  ];
  const receipt = await run('create', steps);
  assert.equal(receipt.status, 'completed', JSON.stringify(receipt));
  assert.equal((receipt.steps[2]?.result as { text: string }).text, '这里是正文。');
  const [node] = await nodes();
  assert.deepEqual([node?.x, node?.y], [100, 180]);
  assert.deepEqual((await run('create', steps)).steps, receipt.steps);
  assert.equal((await nodes()).length, 1);
  const skip = await run('condition', steps);
  assert.equal(skip.steps[1]?.status, 'skipped');
  assert.equal(skip.steps[2]?.status, 'skipped');
  const copied = await run('copy', [
    { id: 'select', action: 'selection.set', arguments: { ids: [node!.id] } },
    { id: 'copy', action: 'clipboard.copy', dependsOn: ['select'] },
    { id: 'panel', action: 'editor.read' },
  ]);
  assert.equal(copied.status, 'completed', JSON.stringify(copied));
  assert.equal((copied.steps[1]?.result as { count: number }).count, 1);
  assert.deepEqual(await kernel.router.ask<string[]>('editor.openPanes', undefined, source), [node!.id]);
  await assert.rejects(run('create', [{ id: 'other', action: 'selection.read' }]), /同一计划编号/u);
});

test('[X01 X13 X18 X22] preflight rejects wrong scope, dangling references, invalid params and unsupported atomic batches before any changes', async () => {
  const { run, nodes } = await harness();
  const create = { id: 'make', action: 'node.create', arguments: { title: '不应创建', x: 0, y: 0 } };
  await assert.rejects(run('scope', [create], { effectScope: 'workspace' }), /作用范围/u);
  await assert.rejects(run('invalid', [create, { id: 'clear', action: 'selection.clear', arguments: { ids: [] } }]), /参数无效/u);
  await assert.rejects(run('missing-targets', [create, { id: 'select', action: 'selection.set' }]), /参数无效/u);
  await assert.rejects(run('conflicting-targets', [create, { id: 'select', action: 'selection.set',
    arguments: { ids: ['fake'], targets: [{ title: '同一对象' }] } }]), /参数无效/u);
  await assert.rejects(run('ref', [{ id: 'open', action: 'editor.open', arguments: { target: { from: 'missing' } } }]), /前置步骤/u);
  await assert.rejects(run('partial', [create, { id: 'cut', action: 'clipboard.cut' }]), /合并/u);
  assert.equal((await nodes()).length, 0);
});

test('[A58 X08 X17] a discovered owner action uses the real validator before any plan side effects and disappears on unplug', async () => {
  let calls = 0;
  const extension: PluginDefinition = {
    manifest: defineManifest('local-extension', '本地扩展', { commands: ['extension.choose'],
      permissions: ['ui.action.register'], actions: ['extension.choose'] }),
    start(context) {
      context.commands.register({ type: 'extension.choose',
        validate: (value): value is { amount: number } => isRecord(value) && Object.keys(value).length === 1 &&
          typeof value.amount === 'number' && Number.isInteger(value.amount) && value.amount > 0 && value.amount < 4,
        handle: value => { calls += 1; return { result: { amount: value.amount } }; },
      });
      context.ui.action({ id: 'extension.choose', label: '新增可发现动作', category: '扩展', command: 'extension.choose',
        localTool: { version: 1, effect: 'workspace', inputSchema: { type: 'object', required: ['amount'],
          properties: { amount: { type: 'integer', minimum: 1, maximum: 3 } }, additionalProperties: false }, resultMode: 'returned' } });
    },
  };
  const { kernel, run, nodes } = await harness([extension]);
  const action = 'registered:local-extension:extension.choose';
  const index = () => kernel.router.ask<WorkspaceActionIndex>('workspace.actions@1', undefined, source);
  assert.equal((await index()).actions.find(entry => entry.id === action)?.status, 'available');
  assert.ok((await index()).registry.commands.some(entry => entry.type === 'extension.choose'));
  await assert.rejects(run('bad-dynamic', [
    { id: 'create', action: 'node.create', arguments: { title: '不应该创建', x: 0, y: 0 } },
    { id: 'extension', action, arguments: { amount: 10 } },
  ]), /参数无效/u);
  assert.equal((await nodes()).length, 0); assert.equal(calls, 0);
  const done = await run('dynamic', [{ id: 'extension', action, arguments: { amount: 2 } }]);
  assert.deepEqual(done.steps[0]?.result, { amount: 2 }); assert.equal(calls, 1);
  await kernel.plugins.stop('local-extension');
  assert.equal((await index()).actions.some(entry => entry.id === action), false);
  await assert.rejects(run('unplugged-dynamic', [{ id: 'extension', action, arguments: { amount: 2 } }]), /不可用/u);
});

test('[A14 A21 A23 A31 A35 A65 X02 X09 X19 X22 X24 E02] separate document steps compile to one preview, pass new IDs onward, and undo atomically', async () => {
  const { kernel, run, nodes } = await harness();
  const result = await run('atomic-create', [
    { id: 'hero', action: 'node.create', arguments: { title: '主角', x: 10, y: 20 } },
    { id: 'draft', action: 'content.draft.preview', arguments: { target: { from: 'hero' }, start: 0,
      deleteCount: 0, expectedRevision: 1, text: '主角小传。' } },
    { id: 'case', action: 'node.create', arguments: { title: '旧案', x: 450, y: 20 } },
    { id: 'edge', action: 'connection.create', arguments: { from: { from: 'hero' }, to: { from: 'case' }, line: 'dashed' } },
    { id: 'group', action: 'group.createExplicit', arguments: { title: '故事线', members: [{ from: 'hero' }, { from: 'case' }] } },
    { id: 'read', action: 'content.read', arguments: { target: { from: 'hero' }, start: 0, length: 100 } },
  ]);
  assert.equal(result.status, 'waiting', JSON.stringify(result));
  assert.equal((await nodes()).length, 0);
  const before = kernel.history.getState().undoCount;
  const applied = await kernel.router.dispatch<WorkspacePlanReceipt>('workspace.plan.resume@1', { id: result.id, apply: ['hero'] }, source);
  assert.equal(applied.status, 'completed', JSON.stringify(applied));
  assert.equal((applied.steps.at(-1)?.result as { text: string }).text, '主角小传。');
  assert.equal(kernel.history.getState().undoCount, before + 1);
  assert.equal((await nodes()).length, 2);
  const graph = await kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1');
  assert.equal(graph.connections.length, 1); assert.equal(isTitleConnection(graph.connections[0]!), true);
  const replay = await kernel.router.dispatch<WorkspacePlanReceipt>('workspace.plan.resume@1', { id: result.id }, source);
  assert.equal(replay.status, 'completed'); assert.equal((await nodes()).length, 2);
  await kernel.router.dispatch('history.undo', undefined, source);
  assert.equal((await nodes()).length, 0);
  assert.equal((await kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1')).connections.length, 0);
});

test('[A16 X21] a copied excerpt preview becomes stale if its read source changes before apply', async () => {
  const { kernel, run, nodes } = await harness();
  await kernel.router.dispatch('node.create', { title: '原文', x: 0, y: 0, body: '第一段原文。' }, source);
  const node = (await nodes())[0]!;
  const preview = await run('excerpt', [{ id: 'extract', action: 'content.extract.preview', arguments: {
    target: { id: node.id }, start: 0, length: 3, expectedRevision: node.revision, title: '摘录',
  } }]);
  assert.equal(preview.status, 'waiting', JSON.stringify(preview));
  await kernel.router.dispatch('content.applyDelta', { nodeId: node.id, start: 0, deleteCount: 1, insert: '新', expectedRevision: node.revision }, source);
  const rejected = await kernel.router.dispatch<WorkspacePlanReceipt>('workspace.plan.resume@1', { id: preview.id, apply: ['extract'] }, source);
  assert.equal(rejected.status, 'failed'); assert.match(rejected.steps[0]?.message ?? '', /变化/u);
  assert.equal((await nodes()).length, 1);
});

test('[X04 X05] a same-title choice resumes only the returned candidate and does not replay completed independent steps', async () => {
  const { kernel, run, nodes } = await harness();
  await kernel.router.dispatch('node.create', { title: '甲', x: 0, y: 0 }, source);
  await kernel.router.dispatch('node.create', { title: '乙', x: 400, y: 0 }, source);
  const original = await nodes();
  kernel.capabilities.register('core.test', { key: 'content.summaries@1', priority: 100,
    invoke: () => original.map(node => ({ ...node, title: '同名' })) });
  const result = await run('choice', [
    { id: 'open', action: 'editor.open', arguments: { target: { title: '同名' }, mode: 'add' } },
    { id: 'read', action: 'content.read', arguments: { target: { from: 'open' }, start: 0, length: 10 } },
    { id: 'independent', action: 'selection.read' },
  ]);
  await assert.rejects(kernel.router.dispatch('workspace.plan.resume@1', { id: result.id,
    choices: { open: { argument: 'target', id: 'not-a-candidate' } } }, source), /候选/u);
  const resumed = await kernel.router.dispatch<WorkspacePlanReceipt>('workspace.plan.resume@1', { id: result.id,
    choices: { open: { argument: 'target', id: original[1]!.id } } }, source);
  assert.equal(resumed.status, 'completed', JSON.stringify(resumed));
  assert.deepEqual(await kernel.router.ask('editor.openPanes', undefined, source), [original[1]!.id]);
});

test('[A08 A19 A20 A27 A43 X07 X10 E03] filtering, counting, coloring and layout share frozen IDs across selection changes', async () => {
  const { kernel, run, nodes } = await harness();
  for (const [i, title] of ['空白10', '空白2', '主角'].entries()) {
    await kernel.router.dispatch('node.create', { title, x: i * 500, y: i * 280, body: title === '主角' ? '正文四字' : '' }, source);
  }
  const original = await nodes();
  const hero = original.find(node => node.title === '主角')!;
  const result = await run('filtered-layout', [
    { id: 'find', action: 'content.filter', arguments: { empty: true, unconnected: true, excludeIds: [hero.id], sort: 'title', limit: 2 } },
    { id: 'count', action: 'content.statistics', arguments: { nodeIds: { $step: 'find', path: ['ids'] } } },
    { id: 'layout', action: 'layout.plan', arguments: { nodeIds: { $step: 'find', path: ['ids'] }, columns: 2, gap: 40, sort: 'title', color: '#ffee00' } },
    { id: 'preview', action: 'canvas.batch.preview', arguments: {
      plan: { $step: 'layout', path: ['plan'] }, expectedRevision: { $step: 'layout', path: ['expectedRevision'] },
    } },
    { id: 'other-selection', action: 'selection.set', arguments: { ids: [hero.id] } },
  ]);
  assert.equal(result.status, 'waiting', JSON.stringify(result));
  assert.equal((result.steps[1]?.result as { nodeCount: number }).nodeCount, 2);
  assert.equal((result.steps[1]?.result as { utf16Units: number }).utf16Units, 0);
  const applied = await kernel.router.dispatch<WorkspacePlanReceipt>('workspace.plan.resume@1', { id: result.id, apply: ['preview'] }, source);
  assert.equal(applied.status, 'completed', JSON.stringify(applied));
  const actual = await nodes();
  const a = actual.find(node => node.title === '空白2')!;
  const b = actual.find(node => node.title === '空白10')!;
  assert.equal(b.x - a.x - a.width, 40); assert.equal(a.y, b.y);
  assert.equal(a.titleColor, '#ffee00'); assert.equal(b.titleColor, '#ffee00');
  assert.deepEqual(actual.find(node => node.id === hero.id), hero);
  assert.deepEqual((await kernel.capabilities.request<{ ids: string[] }>('selection.read@1')).ids, [hero.id]);
  const subset = await kernel.capabilities.request<{ utf16Units: number }>('content.statistics@2', { nodeIds: [hero.id] });
  assert.equal(subset.utf16Units, 4);
  const all = await kernel.capabilities.request<{ nodeCount: number; utf16Units: number }>('content.statistics@1');
  assert.equal(all.nodeCount, 3); assert.equal(all.utf16Units, 4);
  await kernel.router.dispatch('history.undo', undefined, source);
  assert.deepEqual(await nodes(), original);
});

test('[A34 X18 X26] bounded original-text diff and failed readback checks do not modify the document', async () => {
  const { kernel, run, nodes } = await harness();
  await kernel.router.dispatch('node.create', { title: '第一版', x: 0, y: 0, body: '相同开头甲。相同结尾' }, source);
  await kernel.router.dispatch('node.create', { title: '第二版', x: 400, y: 0, body: '相同开头乙。相同结尾' }, source);
  const before = await nodes(); const undo = kernel.history.getState().undoCount;
  const result = await run('diff', [{ id: 'compare', action: 'content.diff', arguments: {
    left: { title: '第一版' }, right: { title: '第二版' }, length: 32768,
  } }], { effectScope: 'read-only' });
  const diff = result.steps[0]!.result as { equal: boolean; left: { text: string }; right: { text: string } };
  assert.equal(diff.equal, false); assert.equal(diff.left.text, '甲'); assert.equal(diff.right.text, '乙');
  const failed = await kernel.router.dispatch<WorkspacePlanReceipt>('workspace.plan.run@1', {
    version: 1, id: 'verify-failure', steps: [{ id: 'state', action: 'selection.read' }],
    verify: [{ action: 'selection.read', field: ['ids'], equals: ['does-not-exist'] }],
  }, source);
  assert.equal(failed.status, 'partial'); assert.equal(failed.steps.at(-1)?.status, 'failed');
  assert.deepEqual(await nodes(), before); assert.equal(kernel.history.getState().undoCount, undo);
});

test('[X08 X27] the complete coverage directory separates source registration, executable adapters and untested acceptance', async () => {
  const { kernel } = await harness();
  const report = await kernel.router.ask<WorkspaceCoverageReport>('workspace.coverage@1', undefined, source);
  assert.equal(report.categories.length, 66); assert.equal(report.crossCategory.length, 27); assert.equal(report.scenarios.length, 11);
  const geometry = report.categories.find(entry => entry.id === 'A02')!;
  assert.equal(geometry.actions.find(action => action.id === 'viewport.set')?.status, 'inactive');
  assert.ok(geometry.missing.length > 0);
  assert.equal(geometry.missing.some(key => geometry.registered.includes(key)), false);
  assert.equal(report.categories.every(entry => entry.acceptanceStatus === 'not-run'), true);
  assert.ok(report.categories.find(entry => entry.id === 'A31')?.limits.includes('requires-local-generative-model'));
  assert.ok(report.categories.find(entry => entry.id === 'A54')?.limits.includes('remote-execution-disabled'));
});

test('[A50 A51 X24 X25 X26] local copy uses a fresh destination and file receipts distinguish completion, cancellation and failure', async () => {
  const { kernel, run } = await harness([createImportExportPlugin()]);
  await kernel.router.dispatch('node.create', { title: '要另存的书', body: '副本里的中文内容', x: 15, y: 28 }, source);
  let originalWrites = 0; let copyClosed = false;
  const parts: BlobPart[] = [];
  const original: FileSaveTarget = { name: '原书.e8', createWritable: async () => ({
    write: async () => { originalWrites += 1; }, close: async () => undefined,
  }) };
  const copy: FileSaveTarget = { name: '副本.e8', createWritable: async () => ({
    write: async part => { parts.push(part as BlobPart); }, close: async () => { copyClosed = true; },
  }) };
  const waitTask = async (taskId: string) => {
    for (let i = 0; i < 200; i += 1) {
      const task = await kernel.capabilities.request<LocalFileTaskResult>('file.operationResult@1', { taskId });
      if (task.state !== 'running') return task;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('本地文件任务未结束');
  };
  const saved = await kernel.router.dispatch<{ taskId: string }>('file.saveProject', { destination: original }, source);
  assert.equal((await waitTask(saved.taskId)).state, 'ready');
  const baselineWrites = originalWrites;
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { showSaveFilePicker: async () => copy } });
    const receipt = await run('local-copy', [{ id: 'save', action: 'file.copy' }]);
    assert.equal(receipt.status, 'waiting');
    const taskId = (receipt.steps[0]!.result as { taskId: string }).taskId;
    assert.equal((await waitTask(taskId)).state, 'ready');
    const done = await kernel.router.dispatch<WorkspacePlanReceipt>('workspace.plan.resume@1', { id: receipt.id }, source);
    assert.equal(done.status, 'completed'); assert.equal(copyClosed, true); assert.equal(originalWrites, baselineWrites);
    const parsed = await parseProject(new Blob(parts));
    assert.ok(JSON.stringify(parsed).includes('副本里的中文内容'));
    assert.equal((await run('local-copy', [{ id: 'save', action: 'file.copy' }])).status, 'completed');
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { showSaveFilePicker: async () => { throw new DOMException('用户取消', 'AbortError'); } } });
    const cancelled = await run('cancel-copy', [{ id: 'save', action: 'file.copy' }]);
    assert.equal(cancelled.status, 'failed'); assert.match(cancelled.steps[0]?.message ?? '', /取消/u);
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { showSaveFilePicker: async () => ({
      name: '失败的副本.e8', createWritable: async () => ({ write: async () => undefined,
        close: async () => { throw new Error('磁盘写入失败'); }, abort: async () => undefined }),
    }) } });
    const failure = await run('failed-copy', [{ id: 'save', action: 'file.copy' }]);
    const failedId = (failure.steps[0]!.result as { taskId: string }).taskId;
    assert.equal((await waitTask(failedId)).state, 'error');
    const failed = await kernel.router.dispatch<WorkspacePlanReceipt>('workspace.plan.resume@1', { id: failure.id }, source);
    assert.equal(failed.status, 'failed'); assert.match(failed.steps[0]?.message ?? '', /磁盘写入失败/u);
    assert.equal(originalWrites, baselineWrites);
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window');
    await kernel.plugins.stop('import-export');
  }
});

test('[A50 X26] exporting a specified node produces the actual text artifact before the task is acknowledged', async () => {
  const { kernel, run, nodes } = await harness([createImportExportPlugin()]);
  await kernel.router.dispatch('node.create', { title: '第一章', body: '第一章原文。\n第二段。', x: 0, y: 0 }, source);
  const node = (await nodes())[0]!;
  const artifacts: FileArtifact[] = [];
  const unsubscribe = kernel.router.subscribeSignal('core.test', 'file.artifact.ready', message => { artifacts.push(message.payload as FileArtifact); });
  const receipt = await run('export-text', [{ id: 'export', action: 'file.exportText', arguments: { target: { id: node.id } } }]);
  assert.equal(receipt.status, 'waiting');
  let final = receipt;
  for (let i = 0; i < 200 && final.status === 'waiting'; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
    final = await kernel.router.dispatch<WorkspacePlanReceipt>('workspace.plan.resume@1', { id: receipt.id }, source);
  }
  assert.equal(final.status, 'completed', JSON.stringify(final));
  assert.equal(artifacts.length, 1); assert.equal(artifacts[0]!.filename, '第一章.txt');
  assert.match(await artifacts[0]!.blob.text(), /第一章原文。\n第二段。/u);
  unsubscribe(); await kernel.plugins.stop('import-export');
});

test('[A43 X21 X23 X25] large statistics leave the command queue available and cancel through the owned task', async () => {
  const { kernel, run, nodes } = await harness();
  await kernel.router.dispatch('node.create', { title: '长文', body: '字'.repeat(300_000), x: 0, y: 0 }, source);
  const node = (await nodes())[0]!;
  let aborted = false;
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const unregister = kernel.capabilities.register('core.test', { key: 'content.statistics@2', priority: 100,
    invoke: (_input, signal) => new Promise((_resolve, reject) => {
      started();
      signal?.addEventListener('abort', () => { aborted = true; reject(new DOMException('查询已取消', 'AbortError')); }, { once: true });
    }),
  });
  const result = await run('large-statistics', [
    { id: 'count', action: 'content.statistics', arguments: { nodeIds: [node.id] } },
    { id: 'independent', action: 'selection.read' },
  ]);
  assert.equal(result.status, 'waiting', JSON.stringify(result)); assert.equal(result.steps[1]?.status, 'completed');
  await Promise.race([running, new Promise((_, reject) => setTimeout(() => reject(new Error('查询未启动')), 1000))]);
  await kernel.router.dispatch('node.rename', { id: node.id, title: '长文仍可操作' }, source);
  assert.equal((await nodes())[0]?.title, '长文仍可操作');
  const cancelled = await kernel.router.dispatch<WorkspacePlanReceipt>('workspace.plan.cancel@1', { id: result.id }, source);
  assert.equal(cancelled.status, 'cancelled');
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(aborted, true);
  unregister();
  await kernel.plugins.stop('workspace-actions');
  assert.equal(kernel.resources.summary().some(entry => entry.owner === 'workspace-actions'), false);
});

test('[A23 A24 X19 X22 X26] a single relation preview preserves direction and applies the requested line and label once', async () => {
  const { kernel, run, nodes } = await harness();
  await kernel.router.dispatch('node.create', { title: '师父', x: 0, y: 0 }, source);
  await kernel.router.dispatch('node.create', { title: '徒弟', x: 500, y: 0 }, source);
  const [a, b] = await nodes();
  const preview = await run('single-relation', [{ id: 'edge', action: 'connection.create', arguments: {
    from: { id: a!.id }, to: { id: b!.id }, line: 'dashed', label: '师徒',
  } }]);
  assert.equal(preview.status, 'waiting');
  assert.equal((await kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1')).connections.length, 0);
  const before = kernel.history.getState().undoCount;
  const applied = await kernel.router.dispatch<WorkspacePlanReceipt>('workspace.plan.resume@1', { id: preview.id, apply: ['edge'] }, source);
  assert.equal(applied.status, 'completed', JSON.stringify(applied));
  const graph = await kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1');
  assert.equal(graph.connections.length, 1);
  assert.equal(graph.connections[0]!.from.nodeId, a!.id); assert.equal(graph.connections[0]!.to.nodeId, b!.id);
  assert.equal(graph.connections[0]!.label, '师徒'); assert.equal(isTitleConnection(graph.connections[0]!), true);
  assert.equal(kernel.history.getState().undoCount, before + 1);
  await kernel.router.dispatch('workspace.plan.resume@1', { id: preview.id }, source);
  assert.equal(kernel.history.getState().undoCount, before + 1);
});

test('[X02 X04 X05 X09] two ambiguous roles are clarified independently and the first binding survives the second choice', async () => {
  const { kernel, run, nodes } = await harness();
  for (const [i, title] of ['起点甲', '起点乙', '终点甲', '终点乙'].entries()) {
    await kernel.router.dispatch('node.create', { title, x: i * 400, y: 0 }, source);
  }
  const original = await nodes();
  kernel.capabilities.register('core.test', { key: 'content.summaries@1', priority: 100,
    invoke: () => original.map((node, i) => ({ ...node, title: i < 2 ? '同名起点' : '同名终点' })) });
  const first = await run('two-roles', [{ id: 'edge', action: 'connection.create', arguments: {
    from: { title: '同名起点' }, to: { title: '同名终点' }, line: 'solid',
  } }]);
  assert.equal((first.steps[0]?.result as { argument: string }).argument, 'from');
  await assert.rejects(kernel.router.dispatch('workspace.plan.resume@1', { id: first.id,
    choices: { edge: { argument: 'to', id: original[0]!.id } } }, source), /候选/u);
  const second = await kernel.router.dispatch<WorkspacePlanReceipt>('workspace.plan.resume@1', { id: first.id,
    choices: { edge: { argument: 'from', id: original[1]!.id } } }, source);
  assert.equal((second.steps[0]?.result as { argument: string }).argument, 'to');
  const ready = await kernel.router.dispatch<WorkspacePlanReceipt>('workspace.plan.resume@1', { id: first.id,
    choices: { edge: { argument: 'to', id: original[3]!.id } } }, source);
  assert.equal(typeof (ready.steps[0]?.result as { reviewId: string }).reviewId, 'string');
  const applied = await kernel.router.dispatch<WorkspacePlanReceipt>('workspace.plan.resume@1', { id: first.id, apply: ['edge'] }, source);
  assert.equal(applied.status, 'completed', JSON.stringify(applied));
  const graph = await kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1');
  assert.equal(graph.connections.length, 1); assert.equal(graph.connections[0]!.from.nodeId, original[1]!.id);
  assert.equal(graph.connections[0]!.to.nodeId, original[3]!.id);
});

test('[A50 X23 X25] cancelling a plan forwards cancellation to its running file owner without closing the partial write', async () => {
  const { kernel, run } = await harness([createImportExportPlugin()]);
  let release!: () => void; let started!: () => void; let closed = false; let aborted = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const writing = new Promise<void>(resolve => { started = resolve; });
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { showSaveFilePicker: async () => ({
    name: '取消的副本.e8', createWritable: async () => ({
      write: async () => { started(); await gate; }, close: async () => { closed = true; }, abort: async () => { aborted = true; },
    }),
  }) } });
  try {
    const result = await run('cancel-running-file', [{ id: 'save', action: 'file.copy' }]);
    await writing;
    const cancelled = await kernel.router.dispatch<WorkspacePlanReceipt>('workspace.plan.cancel@1', { id: result.id }, source);
    assert.equal(cancelled.status, 'cancelled'); assert.match(cancelled.steps[0]?.message ?? '', /请求取消/u);
    release();
    let task: LocalFileTaskResult | undefined;
    for (let i = 0; i < 200; i += 1) {
      task = await kernel.capabilities.request<LocalFileTaskResult>('file.operationResult@1', { taskId: (result.steps[0]!.result as { taskId: string }).taskId });
      if (task.state !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(task?.state, 'cancelled'); assert.equal(closed, false); assert.equal(aborted, true);
  } finally {
    release(); if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window');
    await kernel.plugins.stop('import-export');
  }
});

test('[X21 X24 X25] cancellation and document replacement never replay a pending or completed plan', async () => {
  const { kernel, run, nodes } = await harness();
  const { revision } = await kernel.router.ask<{ revision: number }>('system.document.revision', undefined, source);
  const pending = await run('cancel-plan', [{ id: 'preview', action: 'canvas.batch.preview', arguments: {
    expectedRevision: revision, plan: { version: 1, actions: [{ type: 'create-node', ref: 'new', title: '取消的新卡' }] },
  } }]);
  const cancelled = await kernel.router.dispatch<WorkspacePlanReceipt>('workspace.plan.cancel@1', { id: pending.id }, source);
  assert.equal(cancelled.status, 'cancelled'); assert.equal((await nodes()).length, 0);
  await assert.rejects(kernel.router.dispatch('workspace.plan.resume@1', { id: pending.id, apply: ['preview'] }, source), /失效/u);
  assert.equal((await run('done', [{ id: 'make', action: 'node.create', arguments: { title: '只创建一次', x: 0, y: 0 } }])).status, 'completed');
  await kernel.router.dispatch('system.document.new', undefined, source);
  await new Promise(resolve => setTimeout(resolve, 0));
  const expired = await kernel.router.ask<WorkspacePlanReceipt>('workspace.plan.receipt@1', { id: 'done' }, source);
  assert.equal(expired.status, 'expired');
  await assert.rejects(kernel.router.dispatch('workspace.plan.resume@1', { id: 'done' }, source), /失效/u);
});

test('[X05 X11] duplicate titles leave only dependent steps waiting while unrelated queries can finish', async () => {
  const { kernel, run } = await harness();
  for (let i = 0; i < 2; i += 1) {
    await kernel.router.dispatch('node.create', { title: '空白1', x: i * 220, y: 50 }, source);
  }
  const original = await kernel.capabilities.request<ContentSummary[]>('content.summaries@1');
  kernel.capabilities.register('core.test', { key: 'content.summaries@1', priority: 100,
    invoke: () => original.map(node => ({ ...node, title: '空白1' })) });
  const receipt = await run('ambiguous', [
    { id: 'open', action: 'editor.open', arguments: { target: { title: '空白1' } } },
    { id: 'close', action: 'editor.close', arguments: { target: { title: '空白1' } }, dependsOn: ['open'] },
    { id: 'selection', action: 'selection.read' },
  ]);
  assert.equal(receipt.status, 'waiting');
  assert.deepEqual(receipt.steps.map(step => step.status), ['waiting', 'skipped', 'completed']);
  assert.equal((receipt.steps[0]?.result as { candidates: unknown[] }).candidates.length, 2);
  assert.deepEqual(await kernel.router.ask('editor.openPanes', undefined, source), []);
});

test('[A65 X19 X22] a workspace document batch waits, applies atomically, and undoes with one history entry', async () => {
  const { kernel, run, nodes } = await harness();
  const { revision } = await kernel.router.ask<{ revision: number }>('system.document.revision', undefined, source);
  const preview = await run('batch', [{
    id: 'review', action: 'canvas.batch.preview', arguments: { expectedRevision: revision, plan: { version: 1, actions: [
      { type: 'create-node', ref: 'hero', title: '主角' },
      { type: 'create-node', ref: 'case', title: '旧案' },
      { type: 'create-connection', ref: 'edge', from: 'hero', to: 'case', line: 'dashed' },
    ] } },
  }]);
  assert.equal(preview.status, 'waiting', JSON.stringify(preview));
  assert.equal((await nodes()).length, 0);
  const { reviewId } = preview.steps[0]!.result as { reviewId: string };
  const state = await kernel.router.ask<CanvasControlState>('canvasControl.state@1', undefined, source);
  assert.equal(state.reviews.find(item => item.id === reviewId)?.actions.length, 3);
  const before = kernel.history.getState().undoCount;
  await kernel.router.dispatch('canvasControl.apply@1', { id: reviewId }, source);
  assert.equal(kernel.history.getState().undoCount, before + 1);
  assert.equal((await nodes()).length, 2);
  const graph = () => kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1');
  assert.equal((await graph()).connections.length, 1);
  assert.equal(isTitleConnection((await graph()).connections[0]!), true);
  await run('undo', [{ id: 'undo', action: 'history.undo' }]);
  assert.equal((await nodes()).length, 0);
  assert.equal((await graph()).connections.length, 0);
});

test('[A02 A04 A06 X06 X13] deterministic viewport requests produce one scoped step preserving the explicit ratio', () => {
  const route = classifyAITurn('聚焦到空白1，保持 60%，打开小地图');
  assert.deepEqual(route.workspaceSteps, [
    { id: 'viewport', action: 'viewport.set', arguments: { target: { title: '空白1' }, zoom: 0.6 } },
    { id: 'minimap', action: 'minimap.open' },
  ]);
  assert.equal(route.category, 'operation');
  assert.equal(classifyAITurn('画布缩放到60%').workspaceSteps?.[0]?.arguments?.zoom, 0.6);
  assert.equal(classifyAITurn('怎么聚焦到空白1？').workspaceSteps, undefined);
  assert.equal(classifyAITurn('聚焦选中节点').native?.kind, 'view');
});

test('workspace phrasing keeps quoted titles intact and treats layout pronouns as selection operands', async () => {
  const { compileWorkspaceLanguage, workspaceNameKey } = await import('../src/services/workspace-language.ts');
  const steps = compileWorkspaceLanguage('请把当前视图设成百分之七十五，再聚焦「群组，关闭小地图」，接着展开迷你地图');
  assert.deepEqual(steps?.map(step => step.arguments), [
    { zoom: 0.75, target: { title: '群组，关闭小地图' } }, undefined,
  ]);
  assert.equal(steps?.[1]?.action, 'minimap.open');
  assert.deepEqual(compileWorkspaceLanguage('让这两张卡水平排列')?.[0]?.selection, { expectedCount: 2, expectedKind: 'text-node' });
  assert.deepEqual(compileWorkspaceLanguage('定位一下名为时空卡的窗口', new Set()), undefined);
  assert.deepEqual(compileWorkspaceLanguage('聚焦时空卡', new Set([workspaceNameKey('时空卡')]))?.[0]?.arguments,
    { target: { title: '时空卡' } });
  assert.equal(compileWorkspaceLanguage('聚焦「旧案」并关闭小地图然后改另一张卡'), undefined);
  assert.equal(compileWorkspaceLanguage('如何把画布缩至60%？'), undefined);
});

test('layout uses the IDs captured for the request and preserves the later selection', async () => {
  const { kernel, nodes, run } = await harness();
  for (const [title, x, y] of [['甲', 100, 200], ['乙', 300, 420], ['丙', 940, 680]] as const) {
    await kernel.router.dispatch('node.create', { title, x, y }, source);
  }
  const [a, b, c] = (await nodes()).sort((left, right) => left.x - right.x);
  assert.ok(a && b && c);
  await kernel.router.dispatch('selection.set', { ids: [c.id] }, source);
  const scope = { nodeIds: [a.id, b.id] };
  const outcome = await run('frozen-layout', [{ id: 'arrange', action: 'layout.horizontal', arguments: scope }]);
  assert.equal(outcome.status, 'completed');
  const arranged = new Map((await nodes()).map(node => [node.id, node]));
  assert.equal(arranged.get(a.id)?.y, arranged.get(b.id)?.y);
  assert.deepEqual([arranged.get(c.id)?.x, arranged.get(c.id)?.y], [c.x, c.y]);
  const selected = await kernel.capabilities.request<{ ids: string[] }>('selection.read@1');
  assert.deepEqual(selected.ids, [c.id]);
  const stale = await run('stale-layout', [{ id: 'arrange', action: 'layout.vertical',
    arguments: { nodeIds: [a.id, 'deleted'] } }]);
  assert.equal(stale.status, 'failed');
  assert.deepEqual(await nodes(), [...arranged.values()]);
});

test('catalog intents share operation and subject vocabulary without executing incomplete or negated requests', () => {
  const action = (prompt: string) => workspaceCatalogIntent(prompt)?.steps[0];
  assert.equal(action('展开键盘绑定的页面')?.action, 'settings.keys.open');
  assert.equal(action('快捷键现在都有哪些？')?.action, 'shortcuts.read');
  assert.equal(action('把关着的画布导航小窗打开')?.action, 'minimap.open');
  assert.equal(action('显示本地诊断面板')?.action, 'diagnostics.open');
  assert.equal(action('看看本地诊断结果')?.action, 'diagnostics.read');
  assert.deepEqual(action('先把拖动时的智能参考线关掉')?.arguments, { enabled: false });
  assert.equal(action('导出「A、B 两章」为 DOCX')?.action, 'file.exportWord');
  for (const prompt of [
    '不要打开查找面板', '查看开头三个字加粗是否生效', '打开诊断面板并删除当前文件',
    '打开小地图和搜索窗口', '如何设置快捷键？', '生成一份介绍操作日志的写作样例',
  ]) assert.equal(action(prompt), undefined, prompt);
});

test('the same requested switch state is idempotent and reads back the owner state', async () => {
  const { kernel, run } = await harness();
  const steps = [{ id: 'off', action: 'layout.guides.toggle', arguments: { enabled: false } }];
  assert.equal((await run('switch-1', steps)).status, 'completed');
  assert.equal((await run('switch-2', steps)).status, 'completed');
  assert.deepEqual(await kernel.capabilities.request('layout.settings@1'), { guides: false, snap: true });
  await run('legacy-toggle', [{ id: 'toggle', action: 'layout.guides.toggle' }]);
  assert.deepEqual(await kernel.capabilities.request('layout.settings@1'), { guides: true, snap: true });
});

test('catalog sequences require every clause and keep quoted names and unsupported temporary restoration intact', () => {
  const sequence = readWorkspaceSequence('先把画布缩放到60%，然后打开模型连接设置，再显示小地图').intent;
  assert.equal(sequence?.parts?.length, 3);
  assert.deepEqual(sequence?.steps.map(step => step.action), ['viewport.set', 'settings.models.open', 'minimap.open']);
  const unsupported = readWorkspaceSequence('缩放到60%，然后跳舞，再打开小地图');
  assert.equal(unsupported.matched, true);
  assert.equal(unsupported.intent, undefined);
  assert.equal(classifyAITurn('临时修改聚焦快捷键为Ctrl+Alt+9，开地图后把按键恢复原样').catalogIntent, undefined);
  assert.equal(readWorkspaceSequence('如果缩放到60%，然后打开小地图').intent, undefined);
  assert.equal(readWorkspaceSequence('读取「先打开小地图，然后修改标题」的第一段').matched, false);
  assert.equal(classifyAITurn('不要保存当前AI对话存档').archiveSession, false);
  assert.equal(classifyAITurn('保存当前AI对话存档，同时删除主角卡').archiveSession, false);
  const selectedColor = workspaceCatalogIntent('打开选中项的颜色选择器');
  assert.deepEqual(selectedColor?.steps[0]?.selection, { argument: 'ids' });
  for (const [prompt, action] of [
    ['暂不写入，展示第一章开头替换为追查从这里开始。的稿件', 'content.draft.preview'],
    ['不要直接创建，展示第一章首段做成摘录新卡的方案', 'content.extract.preview'],
    ['把空白1和空白2组成待核对组，先预览', 'group.createExplicit'],
    ['把主角的标题颜色改为#ffcc00，先预览', 'node.color'],
    ['我要调整工作区配色，打开设置页', 'palette.open'],
    ['不用联网，查看已有的同步状态', 'cloud.state'],
  ]) assert.equal(classifyAITurn(prompt!).catalogIntent?.steps[0]?.action, action, prompt);
});

test('copy aliases bind a selection operand and the owner copies captured IDs after a reselect', async () => {
  for (const utterance of ['拷贝当前选中的节点', '复制这两张卡到内部剪贴板', '把这些卡拷贝到剪贴板']) {
    const route = classifyAITurn(utterance);
    assert.equal(route.catalogIntent?.steps[0]?.action, 'clipboard.copy');
    assert.deepEqual(route.catalogIntent?.steps[0]?.selection, {
      expectedKind: 'text-node', ...(utterance.includes('两张') ? { expectedCount: 2 } : {}),
    });
    assert.equal(route.catalogIntent?.binding, undefined);
  }
  assert.equal(classifyAITurn('把选中的旧案复制到剪贴板').catalogIntent?.binding, 'clipboard-selection');
  const { kernel, run } = await harness();
  const captured = await kernel.router.dispatch<{ id: string }>('node.create', { title: '发送时', body: '发送时的正文' }, source);
  const newer = await kernel.router.dispatch<{ id: string }>('node.create', { title: '后来选择', body: '后来选择的正文' }, source);
  await kernel.router.dispatch('selection.set', { ids: [captured.id] }, source);
  const { ids: sourceIds } = await kernel.capabilities.request<{ ids: string[] }>('selection.read@1');
  await kernel.router.dispatch('selection.set', { ids: [newer.id] }, source);
  const result = await run('frozen-copy', [{ id: 'copy', action: 'clipboard.copy', arguments: { sourceIds, expectedKind: 'text-node' } }]);
  assert.equal(result.status, 'completed');
  const clipboard = await kernel.capabilities.request<{ count: number; plainTextPreview: string }>('clipboard.state@1');
  assert.equal(clipboard.count, 1);
  assert.match(clipboard.plainTextPreview, /发送时的正文/u);
  assert.doesNotMatch(clipboard.plainTextPreview, /后来选择的正文/u);
  assert.deepEqual((await kernel.capabilities.request<{ ids: string[] }>('selection.read@1')).ids, [newer.id]);
  const stale = await run('frozen-copy-stale', [{ id: 'copy', action: 'clipboard.copy', arguments: { sourceIds: [captured.id, 'stale'] } }]);
  assert.equal(stale.status, 'failed');
  assert.deepEqual(await kernel.capabilities.request('clipboard.state@1'), clipboard);
});

test('the retired developer entry is absent while the group manager retains its validated owner command', async () => {
  const { kernel, run } = await harness();
  const index = await kernel.router.ask<WorkspaceActionIndex>('workspace.actions@1', undefined, source);
  assert.equal(index.actions.some(action => action.id === 'registered:workspace-actions:workspace-actions.open'), false);
  const action = 'group.management.open';
  await assert.rejects(run('panel-excess', [{ id: 'show', action, arguments: { extra: true } }]), /参数无效/u);
  assert.equal((await run('panel-open', [{ id: 'show', action }])).status, 'completed');
  assert.deepEqual(await kernel.capabilities.request('group.membership.state@1'), { open: true });
});

test('expanded group and connection actions verify owners, reject stale revisions and preserve atomic undo', async () => {
  const { kernel, run, nodes } = await harness();
  const a = await kernel.router.dispatch<{ id: string }>('node.create', { title: '甲' }, source);
  const b = await kernel.router.dispatch<{ id: string }>('node.create', { title: '乙' }, source);
  await kernel.router.dispatch('selection.set', { ids: [a.id, b.id] }, source);
  const group = await kernel.router.dispatch<{ id: string }>('group.create', { title: '旧名称' }, source);
  await kernel.router.dispatch('connection.create', { from: { nodeId: a.id, side: 'right' }, to: { nodeId: b.id, side: 'left' } }, source);
  const edge = (await kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1')).connections[0]!;
  const inspect = await run('inspect-new', [{ id: 'g', action: 'group.inspect', arguments: { id: group.id } },
    { id: 'e', action: 'connection.inspect', arguments: { id: edge.id } }]);
  assert.equal((inspect.steps[0]?.result as { title: string }).title, '旧名称');
  await assert.rejects(run('stale-group', [{ id: 'g', action: 'group.rename', arguments: { id: group.id, title: '不应改名', expectedRevision: 99 } }]), /参数无效/u);
  await assert.rejects(run('empty-edge-style', [{ id: 'e', action: 'connection.appearance', arguments: { id: edge.id } }]), /参数无效/u);
  const result = await run('rename-and-recolor', [
    { id: 'g', action: 'group.rename', arguments: { id: group.id, title: '新名称', expectedRevision: 1 } },
    { id: 'e', action: 'connection.appearance', arguments: { id: edge.id, color: '#3568a8', line: 'dashed' } },
  ]);
  assert.equal(result.status, 'waiting');
  await kernel.router.dispatch('workspace.plan.resume@1', { id: result.id, apply: ['g'] }, source);
  const changed = await run('inspect-changed', [{ id: 'g', action: 'group.inspect', arguments: { id: group.id } },
    { id: 'e', action: 'connection.inspect', arguments: { id: edge.id } }]);
  assert.equal((changed.steps[0]?.result as { title: string }).title, '新名称');
  assert.equal((changed.steps[1]?.result as { lineColor: string }).lineColor, '#3568a8');
  assert.equal(isTitleConnection((changed.steps[1]?.result as ConnectionGraphSnapshot['connections'][number])), true);
  await kernel.router.dispatch('history.undo', undefined, source);
  const restored = await run('inspect-restored', [{ id: 'g', action: 'group.inspect', arguments: { id: group.id } },
    { id: 'e', action: 'connection.inspect', arguments: { id: edge.id } }]);
  assert.equal((restored.steps[0]?.result as { title: string }).title, '旧名称');
  assert.equal((restored.steps[1]?.result as { lineColor: string }).lineColor, edge.lineColor);
  assert.equal((await nodes()).length, 2);
});

test('expanded editor, selection and connection label controls return actual owner state', async () => {
  const { kernel, run } = await harness();
  const a = await kernel.router.dispatch<{ id: string }>('node.create', { title: '显示范围甲', body: '长正文'.repeat(200) }, source);
  const b = await kernel.router.dispatch<{ id: string }>('node.create', { title: '显示范围乙' }, source);
  await kernel.router.dispatch('editor.open', { id: a.id, mode: 'add' }, source);
  await kernel.router.dispatch('editor.open', { id: b.id, mode: 'add' }, source);
  const layout = await run('editor-actual-layout', [
    { id: 'layout', action: 'editor.layout', arguments: { width: 800, ratios: { [a.id]: 2, [b.id]: 1 } } },
    { id: 'window', action: 'editor.window', arguments: { target: { id: a.id }, start: 100 } },
    { id: 'state', action: 'editor.state' },
    { id: 'selection', action: 'selection.resolve', arguments: { ids: [a.id, b.id] } },
  ]);
  assert.equal(layout.status, 'completed', JSON.stringify(layout));
  const state = layout.steps[2]?.result as { paneWindows: Record<string, number>; paneRatios: Record<string, number>; dockWidth: number };
  assert.equal(state.paneWindows[a.id], 100);
  assert.equal(state.dockWidth, 800);
  assert.ok(Math.abs(state.paneRatios[a.id]! / state.paneRatios[b.id]! - 2) < 0.00001);
  assert.deepEqual((layout.steps[3]?.result as { expandedIds: string[] }).expandedIds.sort(), [a.id, b.id].sort());
  await kernel.router.dispatch('connection.create', { from: { nodeId: a.id, side: 'right' }, to: { nodeId: b.id, side: 'left' } }, source);
  let edge = (await kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1')).connections[0]!;
  await kernel.router.dispatch('connection.setLabel', { id: edge.id, label: '尺寸测试', expectedRevision: edge.revision }, source);
  edge = (await kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1')).connections[0]!;
  const resized = await run('label-size', [{ id: 'size', action: 'connection.labelSize', arguments: { id: edge.id, width: 180, height: 60, expectedRevision: edge.revision } }]);
  assert.equal(resized.status, 'completed', JSON.stringify(resized));
  assert.equal((resized.steps[0]?.result as { labelWidth: number }).labelWidth, 180);
  await kernel.router.dispatch('history.undo', undefined, source);
  assert.equal((await kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1')).connections[0]?.labelWidth, edge.labelWidth);
});

test('captured cut deletes only its original object in one undo and captured paste rejects a replaced clipboard', async () => {
  const { kernel, run } = await harness();
  const original = await kernel.router.dispatch<{ id: string }>('node.create', { title: '原选区', body: '保留此剪切正文' }, source);
  const newer = await kernel.router.dispatch<{ id: string }>('node.create', { title: '后来选区', body: '不可剪切的后来选区' }, source);
  await kernel.router.dispatch('selection.set', { ids: [newer.id] }, source);
  const result = await run('captured-cut', [{ id: 'cut', action: 'clipboard.cut',
    arguments: { sourceIds: [original.id], expectedKind: 'text-node' } }]);
  assert.equal(result.status, 'completed', JSON.stringify(result));
  const summaries = () => kernel.capabilities.request<Array<{ id: string }>>('content.summaries@1');
  assert.equal((await summaries()).some(node => node.id === original.id), false);
  assert.equal((await summaries()).some(node => node.id === newer.id), true);
  assert.deepEqual((await kernel.capabilities.request<{ ids: string[] }>('selection.read@1')).ids, [newer.id]);
  const frozen = await kernel.capabilities.request<{ copiedAt: number; sourceIds: string[] }>('clipboard.sources@1');
  assert.deepEqual(frozen.sourceIds, [original.id]);
  await run('undo-cut', [{ id: 'undo', action: 'history.undo' }]);
  assert.equal((await summaries()).some(node => node.id === original.id), true);
  await run('newer-copy', [{ id: 'copy', action: 'clipboard.copy', arguments: { sourceIds: [newer.id] } }]);
  const count = (await summaries()).length;
  const stale = await run('stale-paste', [{ id: 'paste', action: 'clipboard.paste', arguments: frozen }]);
  assert.equal(stale.status, 'failed');
  assert.equal((await summaries()).length, count);
});

test('a version-two local save writes a local artifact while the original UI save still uses its owner command', async () => {
  let cloudCalls = 0;
  const cloudState = () => ({ phase: 'ready', configured: true, authenticated: true,
    activeProjectId: 'test-cloud-book', accounts: [], installations: [], headRevision: cloudCalls,
    pendingCommits: 0, upgradeAvailable: false, panelOpen: false });
  const cloud: PluginDefinition = {
    manifest: defineManifest('cloud-sync', '测试同步', { commands: ['cloudSync.syncNow'], queries: ['cloudSync.state'] }),
    start(context) {
      context.queries.register({ type: 'cloudSync.state', handle: cloudState });
      context.commands.register({ type: 'cloudSync.syncNow', handle: () => {
        cloudCalls += 1;
        return { result: cloudState() };
      } });
    },
  };
  const { kernel, run } = await harness([cloud, createImportExportPlugin()]);
  await kernel.router.dispatch('node.create', { title: '本地保存验收', body: '这段正文应在本地文件中' }, source);
  const parts: BlobPart[] = [];
  const target: FileSaveTarget = { name: '本地保存.e8', createWritable: async () => ({
    write: async part => { parts.push(part as BlobPart); }, close: async () => undefined,
  }) };
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { showSaveFilePicker: async () => target } });
    const receipt = await run('owned-local-save', [{ id: 'save', action: 'registered:import-export:file.save-action' }]);
    let completed = receipt;
    for (let attempt = 0; attempt < 200 && completed.status === 'waiting'; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
      completed = await kernel.router.dispatch<WorkspacePlanReceipt>('workspace.plan.resume@1', { id: receipt.id }, source);
    }
    assert.equal(completed.status, 'completed', JSON.stringify(completed));
    assert.equal(cloudCalls, 0);
    assert.match(JSON.stringify(await parseProject(new Blob(parts))), /这段正文应在本地文件中/u);
    await kernel.router.dispatch('system.action.execute', { owner: 'import-export', id: 'file.save-action' }, source);
    await kernel.router.dispatch('selection.clear', undefined, source);
    assert.equal(cloudCalls, 1);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    await kernel.plugins.stop('import-export');
  }
});

test('local action aliases reject a foreign command and named palette targets survive a later reselect', async () => {
  const extension: PluginDefinition = {
    manifest: defineManifest('local-alias', '别名检查', {
      commands: ['node.create'], actions: ['alias.foreign'], permissions: ['ui.action.register'],
    }),
    start(context) {
      context.ui.action({ id: 'alias.foreign', label: '跨所有者别名', category: '测试', command: 'node.create',
        localTool: { version: 2, command: 'node.create', effect: 'document', resultMode: 'returned', inputSchema: { type: 'object' } } });
    },
  };
  const { kernel, run, nodes } = await harness([extension, createPalettePlugin()]);
  const index = await kernel.router.ask<WorkspaceActionIndex>('workspace.actions@1', undefined, source);
  assert.equal(index.actions.find(action => action.id === 'registered:local-alias:alias.foreign')?.status, 'inactive');
  await assert.rejects(run('foreign-alias', [{ id: 'bad', action: 'registered:local-alias:alias.foreign',
    arguments: { title: '不可创建' } }]), /本地动作不可用/u);
  await assert.rejects(kernel.router.dispatch('system.action.invoke@1', { owner: 'local-alias', id: 'alias.foreign',
    arguments: { title: '不可创建' } }, source), /尚未授权/u);
  assert.equal((await nodes()).length, 0);
  const first = await kernel.router.dispatch<{ id: string }>('node.create', { title: '调色目标' }, source);
  const second = await kernel.router.dispatch<{ id: string }>('node.create', { title: '后来选中' }, source);
  await kernel.router.dispatch('selection.set', { ids: [second.id] }, source);
  const result = await run('named-palette', [{ id: 'open', action: 'registered:palette:palette.selection-color-action',
    arguments: { ids: [first.id] } }]);
  assert.equal(result.status, 'completed', JSON.stringify(result));
  const picker = await kernel.router.ask<{ appearancePreview: { entityIds: string[] } }>('palette.colorPicker.state', undefined, source);
  assert.deepEqual(picker.appearancePreview.entityIds, [first.id]);
  assert.deepEqual((await kernel.capabilities.request<{ ids: string[] }>('selection.read@1')).ids, [second.id]);
});

test('captured duplication places one object set with only internal relations and one undo without replacing the clipboard', async () => {
  const { kernel, run, nodes } = await harness();
  const create = async (title: string, x: number) => kernel.router.dispatch<{ id: string }>('node.create', { title, x, y: 80, body: title }, source);
  const first = await create('原甲', 100), second = await create('原乙', 500), other = await create('外部', 900);
  const internal = await kernel.router.dispatch<{ id: string }>('connection.create', {
    from: { nodeId: first.id, side: 'title' }, to: { nodeId: second.id, side: 'title' },
  }, source);
  await kernel.router.dispatch('connection.create', {
    from: { nodeId: second.id, side: 'right' }, to: { nodeId: other.id, side: 'left' },
  }, source);
  const original = await nodes();
  const originalGraph = await kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1');
  await run('keep-clipboard', [{ id: 'copy', action: 'clipboard.copy', arguments: { sourceIds: [other.id] } }]);
  const clipboard = await kernel.capabilities.request('clipboard.sources@1');
  await kernel.router.dispatch('selection.set', { ids: [other.id] }, source);
  const result = await run('captured-duplicate', [{ id: 'duplicate', action: 'clipboard.duplicate', arguments: {
    sourceIds: [first.id, second.id], direction: 'right', gap: 120, includeInternalRelations: true,
  } }]);
  assert.equal(result.status, 'completed', JSON.stringify(result));
  const created = (result.steps[0]!.result as { createdIds: string[] }).createdIds;
  assert.equal(created.length, 2);
  const actual = await nodes();
  const sourceNodes = original.filter(node => node.id === first.id || node.id === second.id);
  const expectedOffset = Math.max(...sourceNodes.map(node => node.x + node.width)) - Math.min(...sourceNodes.map(node => node.x)) + 120;
  for (const node of original) assert.deepEqual(actual.find(current => current.id === node.id), node);
  for (const node of sourceNodes) {
    const clone = actual.find(current => created.includes(current.id) && current.title.startsWith(node.title))!;
    assert.equal(clone.x, node.x + expectedOffset); assert.equal(clone.y, node.y);
  }
  const graph = await kernel.capabilities.request<ConnectionGraphSnapshot>('connections.graph@1');
  assert.equal(graph.connections.length, originalGraph.connections.length + 1);
  const clonedEdge = graph.connections.find(edge => !originalGraph.connections.some(original => original.id === edge.id))!;
  assert(created.includes(clonedEdge.from.nodeId) && created.includes(clonedEdge.to.nodeId));
  assert.equal(isTitleConnection(clonedEdge), isTitleConnection(originalGraph.connections.find(edge => edge.id === internal.id)!));
  assert.deepEqual(await kernel.capabilities.request('clipboard.sources@1'), clipboard);
  await run('undo-duplicate', [{ id: 'undo', action: 'history.undo' }]);
  assert.deepEqual(await nodes(), original);
  assert.deepEqual(await kernel.capabilities.request('connections.graph@1'), originalGraph);
  await run('redo-duplicate', [{ id: 'redo', action: 'history.redo' }]);
  assert.deepEqual(await nodes(), actual);
  assert.deepEqual(await kernel.capabilities.request('connections.graph@1'), graph);
  await kernel.plugins.stop('connections');
  const unavailable = await run('relations-unavailable', [{ id: 'duplicate', action: 'clipboard.duplicate', arguments: {
    sourceIds: [first.id, second.id], direction: 'right', includeInternalRelations: true,
  } }]);
  assert.equal(unavailable.status, 'failed');
  assert.deepEqual(await nodes(), actual);
});

test('duplicate contracts reject conflicting placement and lost targets before writing and index links resolve real commands', async () => {
  const { kernel, run, nodes } = await harness([createImportExportPlugin()]);
  const node = await kernel.router.dispatch<{ id: string }>('node.create', { title: '唯一原件' }, source);
  const original = await nodes();
  await assert.rejects(kernel.router.dispatch('clipboard.duplicateCaptured@1', {
    sourceIds: [node.id], offset: { x: 50, y: 50 }, direction: 'right',
  }, source));
  for (const arguments_ of [
    { sourceIds: [node.id, 'missing'], direction: 'right' },
    { sourceIds: [node.id], direction: 'right', gap: -1 },
    { sourceIds: [node.id], direction: 'right', includeInternalRelations: false },
  ]) {
    await assert.rejects(kernel.router.dispatch('clipboard.duplicateCaptured@1', arguments_, source));
    assert.deepEqual(await nodes(), original);
  }
  assert.equal((await run('lost-duplicate', [{ id: 'duplicate', action: 'clipboard.duplicate', arguments: {
    sourceIds: [node.id, 'missing'], direction: 'right',
  } }])).status, 'failed');
  assert.deepEqual(await nodes(), original);
  const index = await kernel.router.ask<WorkspaceActionIndex>('workspace.actions@1', undefined, source);
  assert.deepEqual(index.actions.find(action => action.id === 'registered:import-export:file.save-action')?.sourceKeys, ['command:file.saveLocal@1']);
  assert(index.actions.find(action => action.id === 'clipboard.duplicate')?.sourceKeys?.includes('command:clipboard.duplicateCaptured@1'));
  const coverage = await kernel.router.ask<WorkspaceCoverageReport>('workspace.coverage@1', undefined, source);
  assert(coverage.crossCategory.find(entry => entry.id === 'X22')?.actions?.some(action => action.id === 'clipboard.duplicate'));
});

test('a missing fragment instantiator prevents the complete duplicate transaction', async () => {
  const extension: PluginDefinition = {
    manifest: defineManifest('copy-extension', '复制提供者故障验收', { providesCapabilities: ['clipboard.serialize@1'] }),
    start(context) {
      context.capabilities.provide({ key: 'clipboard.serialize@1', invoke: () => ({
        owner: 'copy-extension', version: 1, entityIds: ['extension:lost-object'], payload: {},
      }) });
    },
  };
  const { kernel, run, nodes } = await harness([extension]);
  const node = await kernel.router.dispatch<{ id: string }>('node.create', { title: '不可部分复制' }, source);
  const before = await nodes();
  const result = await run('missing-instantiator', [{ id: 'duplicate', action: 'clipboard.duplicate', arguments: {
    sourceIds: [node.id], offset: { x: 400, y: 0 },
  } }]);
  assert.equal(result.status, 'failed');
  assert.match(result.steps[0]!.message!, /部分对象无法实例化/u);
  assert.deepEqual(await nodes(), before);
});


test('local document actions edit the current cloud-backed book through normal owner transactions', async () => {
  const fileState: PluginDefinition = {
    manifest: defineManifest('import-export', 'Cloud book fixture', { providesCapabilities: ['file.state@1'] }),
    start(context) { context.capabilities.provide({ key: 'file.state@1', invoke: () => ({ cloudProjectActive: true }) }); },
  };
  const { kernel, run, nodes } = await harness([fileState]);
  await kernel.router.dispatch('node.create', { title: '云端节点', body: '保留正文' }, source);
  const [node] = await nodes();
  const receipt = await run('cloud-presentation', [{ id: 'present', action: 'node.presentation', arguments: { target: { id: node!.id }, presentation: 'text-box' } }]);
  assert.equal(receipt.status, 'completed', JSON.stringify(receipt));
  assert.equal((await nodes())[0]?.presentation, 'text-box');
  await kernel.router.dispatch('history.undo', undefined, source);
  assert.equal((await nodes())[0]?.presentation, 'card');
});
