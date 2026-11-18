import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://localhost:3000') return route.abort();
    if (url.pathname === '/api/cloud/status') {
      return route.fulfill({ json: { configured: false, authenticated: false, accounts: [], installations: [] } });
    }
    return url.pathname.startsWith('/api/') ? route.abort() : route.continue();
  });
  await page.goto('http://localhost:3000');
  await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
  await page.getByRole('button', { name: '命令面板', exact: true }).click();
  const command = page.getByRole('dialog', { name: '命令面板' });
  await command.getByRole('textbox', { name: '搜索命令' }).fill('查看本地工作区动作');
  await command.getByRole('option', { name: /查看本地工作区动作/u }).click();
  const panel = page.getByRole('region', { name: '工作区动作', exact: true });
  await panel.locator('.workspace-actions-catalog > details').first().waitFor({ state: 'attached' });
  const entries = await panel.locator('.workspace-actions-catalog > details').evaluateAll(elements => elements.map(element => ({
    id: element.querySelector('code')?.textContent, label: element.querySelector('summary')?.textContent,
    metadata: element.querySelector('p')?.textContent,
    inputSchema: JSON.parse(element.querySelector('pre')?.textContent ?? '{}'),
    sourceKeys: (element.querySelector('[aria-label="动作协议来源"]')?.textContent ?? '').split('\n').filter(Boolean),
  })));
  const summary = await panel.getByRole('status').first().textContent();
  const crossCategory = await panel.locator('details').evaluateAll(elements => elements.flatMap(element => {
    const label = element.querySelector(':scope > summary')?.textContent ?? '';
    if (!/^X\d{2}\s/u.test(label)) return [];
    return [{ id: label.slice(0, 3), label: label.slice(4),
      actionMapping: Array.from(element.querySelectorAll(':scope > p')).map(item => item.textContent ?? '').find(text => text.startsWith('已接入动作：')) ?? '',
      acceptanceStatus: 'not-run' }];
  }));
  await mkdir('local-data/workspace-language', { recursive: true });
  await writeFile('local-data/workspace-language/runtime-catalog.json', JSON.stringify(entries, null, 2));
  const index = { version: 1, generatedAt: new Date().toISOString(), source: 'Live workspace action panel; local browser only.',
    note: '动作适配与界面入口索引；注册数量和可用状态不代表验收通过。原始语料与新增动作分别验收。', summary,
    actions: entries, crossCategory };
  await writeFile(new URL('../../deliveries/Echo-8-运行时动作索引.json', import.meta.url), JSON.stringify(index, null, 2));
  await writeFile(new URL('../../deliveries/Echo-8-运行时动作索引.md', import.meta.url), [
    '# Echo-8 运行时动作索引', '', '采集时间：' + index.generatedAt, '', summary ?? '', '', index.note, '',
    '| 动作 ID | 标签及状态 | 所有者与效果 | 实际协议来源 |', '|---|---|---|---|',
    ...entries.map(entry => '| ' + [entry.id, entry.label, entry.metadata, entry.sourceKeys.join('<br>')].join(' | ') + ' |'), '',
    '## 跨类别能力的动作映射', '',
    ...crossCategory.map(entry => '- ' + entry.id + ' ' + entry.label + '：' + (entry.actionMapping || '尚未登记具体动作映射') + '；验收仍待逐项核对。'), '',
    '参数结构见同名 JSON；源码基线见 Echo-8-源码动作索引.md。', '',
  ].join('\n'));
  process.stdout.write(JSON.stringify({ actions: entries.length, crossCategory: crossCategory.length, summary }));
} finally { await browser.close(); }
