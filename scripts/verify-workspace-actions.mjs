import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { workspaceCoverageCatalog } from '../src/plugins/workspace-actions/coverage-catalog.generated.ts';
import { localActions } from '../src/plugins/workspace-actions/actions.ts';

const run = spawnSync(process.execPath, ['--experimental-strip-types', '--test', '--test-reporter=tap', 'tests/workspace-actions.test.ts'],
  { encoding: 'utf8', cwd: new URL('..', import.meta.url), maxBuffer: 4 * 1024 * 1024 });
const output = (run.stdout ?? '') + (run.stderr ?? '');
const tests = [...output.matchAll(/^(ok|not ok) \d+ - (.+)$/gmu)].map(([, status, name]) => ({
  name, status: status === 'ok' ? 'passed' : 'failed', coverageIds: [...name.matchAll(/\b(?:A\d{2}|X\d{2}|E\d{2})\b/gu)].map(match => match[0]),
}));
const modelRequired = new Set(['A30', 'A31', 'A32', 'A33', 'A40', 'A44', 'A61', 'A62', 'A63']);
const remoteOnly = new Set(['A54', 'A55']);
const evidence = id => tests.filter(test => test.coverageIds.includes(id));
const entries = [...workspaceCoverageCatalog.categories, ...workspaceCoverageCatalog.crossCategory, ...workspaceCoverageCatalog.scenarios].map(entry => ({
  ...entry, evidence: evidence(entry.id),
  status: evidence(entry.id).some(test => test.status === 'failed') ? 'failed' : evidence(entry.id).length ? 'partial-evidence' :
    modelRequired.has(entry.id) ? 'local-generative-model-required' : remoteOnly.has(entry.id) ? 'local-simulation-required' : 'not-run',
}));
const report = { version: 1, generatedAt: new Date().toISOString(), cloudModelRequests: 0,
  scope: 'This run executes only fixed plans, not a natural-language or model-quality acceptance.',
  actionAdapterCount: localActions.length, tests, entries,
  completion: 'incomplete',
  note: '有代表行为的通过证据不等于整类动作和参数变体全部通过；不自动关闭原清单。模型生成、事实质量和远端效果仍需独立验证。',
};
const jsonPath = new URL('../../deliveries/Echo-8-本地工作区动作验收报告.json', import.meta.url);
const mdPath = new URL('../../deliveries/Echo-8-本地工作区动作验收报告.md', import.meta.url);
await writeFile(jsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
const escape = text => text.replaceAll('|', '\\|').replaceAll('\n', ' ');
const statusLabels = { 'partial-evidence': '已有部分固定计划证据', failed: '存在失败', 'not-run': '待逐项验收',
  'local-generative-model-required': '待本地生成式模型', 'local-simulation-required': '待本机模拟验收' };
const markdown = [
  '# Echo-8 本地工作区动作验收报告', '',
  `生成时间：${report.generatedAt}。本次运行 ${tests.length} 项定向测试，通过 ${tests.filter(test => test.status === 'passed').length} 项；执行适配 ${localActions.length} 个。云端模型调用为 0。`, '',
  '**整体尚未完成。** 66 类动作、27 项跨类别能力与 11 个组合场景已进入运行时目录。本报告逐项登记实际证据；已有部分证据的条目仍需完成原代表用例和其余参数变体。', '',
  report.note, '',
  '入口：设置中心 → 工作区动作，或命令面板搜索“查看本地工作区动作与固定计划”。可运行配套固定计划 JSON，查看真实回执，应用预览及续接等待步骤。', '',
  '运行 `node --experimental-strip-types scripts/verify-workspace-actions.mjs` 可重新生成本报告。浏览器、便携、压力及完整回归结果在 ADR 0159 的交付记录中登记，不由此脚本推测。', '',
  '| 编号 | 类别或场景 | 当前状态 | 本次证据 |', '|---|---|---|---|',
  ...entries.map(entry => `| ${entry.id} | ${escape(entry.name ?? entry.scenario)} | ${statusLabels[entry.status]} | ${entry.evidence.length ? entry.evidence.map(test => escape(test.name)).join('<br>') : '—'} |`), '',
  '本次详细用例：', '', ...tests.map(test => `- ${test.status === 'passed' ? '通过' : '失败'}：${test.name}`), '',
].join('\n');
await writeFile(mdPath, markdown, 'utf8');
const chapter = '第一段原文。\n\n第二段原文。\n\n首句保留。原来的第三段。';
const examples = {
  version: 1, purpose: '仅用于独立本地测试书的固定计划验收；不调用模型，不是自然语言规则。按顺序复制每个 plan 到工作区动作面板。',
  examples: [
    { title: '准备隔离夹具；应用一次文档预览', plan: { version: 1, id: 'acceptance-fixture-1', steps: [
      { id: 'chapter', action: 'node.create', arguments: { title: '验收_第一章', x: 0, y: 0, text: chapter } },
      { id: 'blank', action: 'node.create', arguments: { title: '验收_空白1', x: 600, y: 300 } },
      { id: 'ten', action: 'node.create', arguments: { title: '验收_空卡10', x: 1200, y: 0 } },
      { id: 'two', action: 'node.create', arguments: { title: '验收_空卡2', x: 1600, y: 400 } },
    ] } },
    { title: '聚焦指定卡、保持60%、打开小地图，并读取最终值', plan: { version: 1, id: 'acceptance-view-1', constraints: { effectScope: 'workspace' }, steps: [
      { id: 'view', action: 'viewport.set', arguments: { target: { title: '验收_空白1' }, zoom: 0.6 } },
      { id: 'map', action: 'minimap.open' },
    ], verify: [{ action: 'viewport.read', field: ['zoom'], equals: 0.6 }, { action: 'minimap.read', field: ['open'], equals: true }] } },
    { title: '区分缩到60%与缩小60%；本例从100%相对缩到40%', plan: { version: 1, id: 'acceptance-relative-1', constraints: { effectScope: 'workspace' }, steps: [
      { id: 'absolute', action: 'viewport.set', arguments: { zoom: 1 } },
      { id: 'relative', action: 'viewport.scale', arguments: { factor: 0.4 }, dependsOn: ['absolute'] },
    ], verify: [{ action: 'viewport.read', field: ['zoom'], equals: 0.4 }] } },
    { title: '固定稿件替换第三段的一部分，保留首句；应用后再聚焦并保持60%', plan: { version: 1, id: 'acceptance-draft-1', steps: [
      { id: 'draft', action: 'content.draft.preview', arguments: { target: { title: '验收_第一章' }, start: chapter.indexOf('原来的第三段。'),
        deleteCount: '原来的第三段。'.length, expectedRevision: 1, text: '润色后的第三段正文。' } },
      { id: 'view', action: 'viewport.set', arguments: { target: { title: '验收_空白1' }, zoom: 0.6 }, dependsOn: ['draft'] },
      { id: 'map', action: 'minimap.open', dependsOn: ['draft'] },
    ], verify: [{ action: 'viewport.read', field: ['zoom'], equals: 0.6 }, { action: 'minimap.read', field: ['open'], equals: true }] } },
    { title: '筛选同一批空卡，统计并按数字标题排两列、标黄；选区变化不会改写目标', plan: { version: 1, id: 'acceptance-layout-1', steps: [
      { id: 'find', action: 'content.filter', arguments: { titleIncludes: '验收_空卡', empty: true, unconnected: true, sort: 'title', limit: 2 } },
      { id: 'count', action: 'content.statistics', arguments: { nodeIds: { $step: 'find', path: ['ids'] } } },
      { id: 'layout', action: 'layout.plan', arguments: { nodeIds: { $step: 'find', path: ['ids'] }, columns: 2, gap: 40, sort: 'title', color: '#ffee00' } },
      { id: 'preview', action: 'canvas.batch.preview', arguments: { plan: { $step: 'layout', path: ['plan'] }, expectedRevision: { $step: 'layout', path: ['expectedRevision'] } } },
      { id: 'clear', action: 'selection.clear' },
    ] } },
  ],
};
await writeFile(new URL('../../deliveries/Echo-8-本地固定计划示例.json', import.meta.url), JSON.stringify(examples, null, 2) + '\n', 'utf8');
process.stdout.write(`${tests.filter(test => test.status === 'passed').length}/${tests.length} fixed-plan regressions passed; ${localActions.length} adapters. Full coverage remains incomplete.\n`);
if (run.status !== 0 || !tests.length) { process.stderr.write(output); process.exitCode = run.status || 1; }
