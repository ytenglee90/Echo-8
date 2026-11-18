import { test, expect, type Browser, type Page } from '@playwright/test';
import dataWorker from '../cloud/data-worker/worker.js';
import { SQLiteD1 } from '../tests/helpers/d1.ts';
import { signDataToken } from '../src/server/cloud/crypto.ts';

async function command(page: Page, label: string) {
  await page.getByRole('button', { name: '命令面板', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '命令面板' });
  await panel.getByRole('textbox', { name: '搜索命令' }).fill(label);
  await panel.getByRole('option', { name: new RegExp(`^${label}`, 'u') }).first().click();
}

async function account(browser: Browser, workerVersion = 6) {
  const db = new SQLiteD1();
  const env = { DB: db, DATA_WORKER_VERSION: String(workerVersion), STORAGE_MODE: 'd1', INSTALLATION_ID: 'preferences-browser-installation', DATA_SIGNING_SECRET: 'browser-preferences-test-secret', ALLOWED_ORIGIN: new URL(test.info().project.use.baseURL ?? 'http://localhost:3000').origin };
  const contexts: Awaited<ReturnType<Browser['newContext']>>[] = [];
  const device = async (user = 'alice') => {
    const context = await browser.newContext(); contexts.push(context);
    const page = await context.newPage();
    const token = await signDataToken({ sub: user, aud: env.INSTALLATION_ID, installationId: env.INSTALLATION_ID, scope: ['projects:read', 'projects:write'] }, env.DATA_SIGNING_SECRET, 600);
    await page.route('**/api/cloud/status', route => route.fulfill({ json: {
      configured: true, authenticated: true, user: { id: user }, accounts: [],
      installations: [{ id: env.INSTALLATION_ID, accountId: 'preferences-account', accountName: '个人账户', workerUrl: 'https://preferences-data.test', workerVersion, latestWorkerVersion: workerVersion, upgradeAvailable: false, status: 'ready' }],
    } }));
    await page.route('**/api/cloud/token', route => route.fulfill({ json: { installationId: env.INSTALLATION_ID, workerUrl: 'https://preferences-data.test', token: token.token, expiresAt: Date.now() + 600_000 } }));
    await page.route('https://preferences-data.test/**', async route => {
      const request = route.request();
      const response = await dataWorker.fetch(new Request(request.url(), { method: request.method(), headers: request.headers(),
        ...(['GET', 'HEAD'].includes(request.method()) ? {} : { body: request.postData() ?? undefined }) }), env);
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    });
    await page.goto('/');
    await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
    await command(page, '云同步设置');
    await expect(page.getByText(/^保存设置已同步：/u)).toBeVisible();
    await command(page, '书籍与恢复设置');
    return page;
  };
  const stored = () => db.sqlite.prepare("SELECT revision, body_json FROM account_preferences WHERE user_id='alice'").get();
  const assistant = () => db.sqlite.prepare("SELECT body_json FROM account_assistant_preferences WHERE user_id='alice'").get();
  return { device, stored, assistant, close: async () => { await Promise.all(contexts.map(context => context.close())); db.sqlite.close(); } };
}

const interval = (page: Page) => page.getByRole('combobox', { name: '自动保存当前目标的间隔' });
const retention = (page: Page) => page.getByRole('combobox', { name: '恢复副本自动保留数量' });

test('multiple phrases and legacy layout entries remain manageable without a defaults tab', async ({ browser }, info) => {
  const a = await account(browser, 9);
  try {
    const page = await a.device();
    await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '指令与偏好', exact: true }).click();
    const panel = page.getByRole('region', { name: 'AI 指令与偏好', exact: true });
    await panel.getByRole('tab', { name: '我的用语', exact: true }).click();
    await panel.getByRole('button', { name: '添加条目', exact: true }).click();
    const form = panel.getByRole('form', { name: '添加条目' });
    await expect.poll(() => form.getByRole('combobox', { name: '对应动作' }).locator('option').count()).toBeGreaterThan(20);
    await form.getByRole('combobox', { name: '动作类别' }).selectOption('排版');
    await form.getByRole('combobox', { name: '对应动作' }).selectOption('vertical');
    await form.getByRole('spinbutton', { name: '本用语的间距（可选）' }).fill('120');
    await form.getByRole('textbox', { name: '个人用语', exact: true }).fill('往下摆松些\n向下排松点');
    await expect(form.getByRole('status')).toContainText('把选中节点垂直排列，间距 120');
    await panel.screenshot({ path: info.outputPath('personal-alias-preview.png') });
    await form.getByRole('button', { name: '添加', exact: true }).click();
    const read = () => JSON.parse(String(a.assistant()?.body_json));
    await expect.poll(() => read()).toMatchObject({ schemaVersion: 2, entries: [{ kind: 'phrase', action: 'vertical', gap: 120 }, { kind: 'phrase', action: 'vertical', gap: 120 }] });
    await expect(panel.getByRole('tab', { name: '默认偏好', exact: true })).toHaveCount(0);
    await panel.getByText('导入与导出', { exact: true }).click();
    await panel.getByLabel('选择导入文件').setInputFiles({ name: '旧版排列设置.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
      schemaVersion: 2, enabled: true, learning: false, entries: [{ id: 'legacy-grid', kind: 'gap', layout: 'grid', gap: 80, enabled: true, origin: 'manual' }],
    })) });
    await panel.getByRole('button', { name: '保留已有冲突项', exact: true }).click();
    const learning = panel.getByRole('region', { name: '学习记录', exact: true });
    await learning.getByRole('button', { name: '编辑', exact: true }).click();
    const legacyEdit = panel.getByRole('form', { name: '编辑条目', exact: true });
    await legacyEdit.getByRole('spinbutton', { name: '默认间距', exact: true }).fill('90');
    await legacyEdit.getByRole('button', { name: '保存修改', exact: true }).click();
    await expect.poll(() => read().entries).toHaveLength(3);
    await panel.getByRole('button', { name: '关闭指令与偏好' }).click();
    await command(page, '全选画布节点');
    await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    await ai.locator('.ai-composer textarea').fill('往下摆松些');
    await ai.locator('.ai-composer textarea').press('Enter');
    await expect(ai.getByRole('status')).toContainText('已直接完成 2 项操作');
    const second = await a.device();
    await second.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '指令与偏好', exact: true }).click();
    const restored = second.getByRole('region', { name: 'AI 指令与偏好', exact: true });
    await restored.getByRole('tab', { name: '我的用语', exact: true }).click();
    await expect(restored).toContainText('往下摆松些');
    await expect(restored).toContainText('向下排松点');
    await expect(restored.getByRole('region', { name: '学习记录', exact: true })).toContainText('网格默认间距 90');
  } finally { await a.close(); }
});

test('assistant preferences keep switches compact and open a responsive form on demand', async ({ browser }, info) => {
  const a = await account(browser, 8);
  try {
    const page = await a.device();
    const center = page.getByRole('region', { name: '设置中心', exact: true });
    const nav = center.getByRole('navigation', { name: '设置分类' });
    const panel = center.getByRole('region', { name: 'AI 指令与偏好', exact: true });
    await nav.getByRole('button', { name: '指令与偏好', exact: true }).click();
    await panel.getByRole('tab', { name: '我的用语', exact: true }).click();
    const learning = panel.getByRole('switch', { name: '从反馈学习' });
    await expect(learning).toBeEnabled();
    const label = await panel.getByText('从反馈学习', { exact: true }).boundingBox();
    const toggle = await learning.boundingBox();
    expect(toggle!.width).toBeLessThanOrEqual(36);
    expect(toggle!.height).toBeLessThanOrEqual(22);
    expect(toggle!.x).toBeGreaterThan(label!.x + label!.width);
    await expect(panel.getByRole('form')).toHaveCount(0);
    await expect(panel.getByText('尚未添加个人用语', { exact: true })).toBeVisible();
    await center.screenshot({ path: info.outputPath('ai-preferences-empty.png') });

    await panel.getByRole('button', { name: '添加条目', exact: true }).click();
    const editor = panel.getByRole('form', { name: '添加条目' });
    const phrase = editor.getByRole('textbox', { name: '个人用语' });
    await expect(phrase).toBeFocused();
    await expect(editor.getByRole('button', { name: '添加', exact: true })).toBeDisabled();
    await phrase.fill('收一下');
    await center.screenshot({ path: info.outputPath('ai-preferences-editor.png') });
    await editor.getByRole('button', { name: '添加', exact: true }).click();
    const entry = panel.getByText('「收一下」→ 给选中节点编组', { exact: true });
    await expect(entry).toBeVisible();

    await nav.getByRole('button', { name: '外观', exact: true }).click();
    await center.getByRole('button', { name: /^B 暗调/u }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await nav.getByRole('button', { name: '指令与偏好', exact: true }).click();
    await panel.getByRole('tab', { name: '我的用语', exact: true }).click();
    await expect(entry).toBeVisible();
    await panel.getByRole('button', { name: '编辑', exact: true }).click();
    const edit = panel.getByRole('form', { name: '编辑条目' });
    await expect(edit.getByRole('textbox', { name: '个人用语' })).toBeFocused();
    const kind = await edit.getByRole('combobox', { name: '动作类别' }).boundingBox();
    const scope = await edit.getByRole('combobox', { name: '适用范围' }).boundingBox();
    expect(kind!.y).toBeGreaterThan(scope!.y + scope!.height);
    expect(await panel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await center.screenshot({ path: info.outputPath('ai-preferences-narrow-dark.png') });
    await edit.getByRole('button', { name: '取消', exact: true }).click();
    await expect(panel.getByRole('button', { name: '添加条目', exact: true })).toBeFocused();
  } finally { await a.close(); }
});

test('assistant phrases are learned from a correction, confirmed in settings, and loaded on another device', async ({ browser }, info) => {
  const a = await account(browser, 8);
  try {
    const openPreferences = async (page: Page) => {
      await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '指令与偏好', exact: true }).click();
      const panel = page.getByRole('region', { name: 'AI 指令与偏好', exact: true });
      await panel.getByRole('tab', { name: '我的用语', exact: true }).click();
      await expect(panel.getByRole('switch', { name: '从反馈学习' })).toBeEnabled();
      return panel;
    };
    const first = await a.device();
    let panel = await openPreferences(first);
    await expect(panel.getByRole('region', { name: '学习记录', exact: true })).toContainText('还没有学习记录');
    await panel.getByRole('switch', { name: '从反馈学习' }).click();
    await expect(panel.getByRole('switch', { name: '从反馈学习' })).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => JSON.parse(String(a.assistant()?.body_json)).learning).toBe(true);
    await panel.getByRole('button', { name: '关闭指令与偏好' }).click();
    await first.getByRole('button', { name: /^打开 AI 助手/u }).click();
    const assistant = first.getByRole('region', { name: 'AI 助手', exact: true });
    await assistant.locator('.ai-composer textarea').fill('收一下');
    await assistant.locator('.ai-composer textarea').press('Enter');
    await expect(assistant.getByText('收一下', { exact: true })).toBeVisible();
    await assistant.locator('.ai-composer textarea').fill('我说的「收一下」是编组');
    await assistant.locator('.ai-composer textarea').press('Enter');
    await expect.poll(() => JSON.parse(String(a.assistant()?.body_json)).entries).toMatchObject([{ phrase: '收一下', status: 'candidate', evidence: 1 }]);
    await command(first, '书籍与恢复设置');
    panel = await openPreferences(first);
    let learning = panel.getByRole('region', { name: '学习记录', exact: true });
    await expect(learning).toContainText('待确认 1');
    await expect(learning).toContainText('来源：反馈学习：明确纠正 1 次');
    await learning.screenshot({ path: info.outputPath('learning-record-pending.png') });
    await learning.getByRole('button', { name: '确认生效', exact: true }).click();
    await expect.poll(() => JSON.parse(String(a.assistant()?.body_json)).entries).toMatchObject([{ phrase: '收一下', status: 'active' }]);
    await expect(learning).toContainText('已生效');
    await learning.getByRole('combobox', { name: '查看学习记录' }).selectOption('pending');
    await expect(learning).toContainText('没有匹配的学习记录');
    await learning.getByRole('combobox', { name: '查看学习记录' }).selectOption('confirmed');
    await learning.screenshot({ path: info.outputPath('learning-record-confirmed.png') });
    const second = await a.device();
    let restored = await openPreferences(second);
    learning = restored.getByRole('region', { name: '学习记录', exact: true });
    await expect(learning.getByText('「收一下」→ 给选中节点编组', { exact: true })).toBeVisible();
    await expect(learning).toContainText('已生效');
    await learning.getByRole('button', { name: '停用', exact: true }).click();
    await expect(learning).toContainText('已停用');
    await learning.getByRole('button', { name: '启用', exact: true }).click();
    await restored.getByText('导入与导出', { exact: true }).click();
    const download = second.waitForEvent('download');
    await restored.getByRole('button', { name: '导出全部', exact: true }).click();
    expect((await download).suggestedFilename()).toMatch(/\.json$/u);
    await restored.getByRole('button', { name: '关闭指令与偏好' }).click();
    await command(second, '全选画布节点');
    await second.getByRole('button', { name: /^打开 AI 助手/u }).click();
    const restoredAssistant = second.getByRole('region', { name: 'AI 助手', exact: true });
    await restoredAssistant.locator('.ai-composer textarea').fill('收一下');
    await restoredAssistant.locator('.ai-composer textarea').press('Enter');
    await expect(second.locator('.group-frame')).toHaveCount(1);
    await command(second, '书籍与恢复设置');
    restored = await openPreferences(second);
    await restored.getByRole('button', { name: '删除', exact: true }).click();
    await expect.poll(() => JSON.parse(String(a.assistant()?.body_json)).entries).toEqual([]);
  } finally { await a.close(); }
});

async function keep(page: Page, value: string) {
  await retention(page).selectOption(value);
  await page.getByRole('group', { name: '确认清理恢复副本' }).getByRole('button', { name: '确认更改', exact: true }).click();
  await expect(retention(page)).toHaveValue(value);
}

test('three verified horizontal arrangements suggest an account preference without enabling it', async ({ browser }) => {
  const a = await account(browser, 8);
  try {
    const page = await a.device();
    const panel = page.getByRole('region', { name: 'AI 指令与偏好', exact: true });
    const open = async () => {
      await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '指令与偏好', exact: true }).click();
      await panel.getByRole('tab', { name: '我的用语', exact: true }).click();
    };
    await open();
    await panel.getByRole('tab', { name: '我的用语', exact: true }).click();
    await panel.getByRole('switch', { name: '从反馈学习' }).click();
    const read = () => JSON.parse(String(a.assistant()?.body_json));
    await expect.poll(() => read().learning).toBe(true);
    await panel.getByRole('button', { name: '关闭指令与偏好' }).click();
    await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
    const ai = page.getByRole('region', { name: 'AI 助手', exact: true });
    const input = ai.locator('.ai-composer textarea');
    const send = async (prompt: string, responseCount: number) => {
      await input.fill(prompt);
      await input.press('Enter');
      await expect(ai.getByLabel('本轮 Token 用量')).toHaveCount(responseCount);
    };
    await send('新建一张偏好甲，一张偏好乙', 1);
    await expect(ai.getByRole('status')).toContainText('已直接完成 2 项操作');
    for (let index = 1; index <= 3; index++) {
      await send('把偏好甲和偏好乙横排，间距 80', index + 1);
      const control = page.getByRole('region', { name: '画布控制', exact: true });
      await control.getByRole('button', { name: '应用整份计划', exact: true }).click();
      await expect(ai.getByRole('status')).toContainText('已完成回读核对');
      await control.getByRole('button', { name: '关闭画布控制' }).click();
      if (index < 3) expect(read().entries).toEqual([]);
    }
    await expect.poll(() => read().entries).toMatchObject([{ kind: 'gap', gap: 80, enabled: false, origin: 'feedback' }]);
    await command(page, '书籍与恢复设置');
    await open();
    const learning = panel.getByRole('region', { name: '学习记录', exact: true });
    const candidate = learning.getByRole('listitem').filter({ hasText: '横排默认间距 80' });
    await expect(candidate).toContainText('待确认');
    await expect(candidate).toContainText('重复应用 3 次');
    await candidate.getByRole('button', { name: '确认生效' }).click();
    await expect.poll(() => read().entries).toMatchObject([{ kind: 'gap', gap: 80, enabled: true }]);
    await expect(candidate).toContainText('已生效');
    await candidate.getByRole('button', { name: '停用' }).click();
    await expect(candidate).toContainText('已停用');
    await expect(learning.getByRole('button', { name: '确认生效' })).toHaveCount(0);
  } finally { await a.close(); }
});

test('personal cadence and retention restore on fresh devices, including disabled and unlimited, without transferring recovery copies', async ({ browser }) => {
  test.setTimeout(90_000);
  const a = await account(browser);
  try {
    const first = await a.device();
    await interval(first).selectOption('0'); await keep(first, '8');
    await first.getByRole('button', { name: '创建手动恢复点', exact: true }).click();
    await expect(first.locator('.recovery-row')).toHaveCount(1);
    await expect.poll(() => JSON.parse(String(a.stored()?.body_json))).toMatchObject({ autosaveIntervalMs: 0, recoveryRetentionLimit: 8 });
    const second = await a.device();
    await expect(interval(second)).toHaveValue('0'); await expect(retention(second)).toHaveValue('8');
    await expect(second.locator('.recovery-row')).toHaveCount(0);
    await interval(second).selectOption('1000'); await keep(second, 'none');
    await expect.poll(() => JSON.parse(String(a.stored()?.body_json))).toMatchObject({ autosaveIntervalMs: 1000, recoveryRetentionLimit: null });
    const third = await a.device();
    await expect(interval(third)).toHaveValue('1000'); await expect(retention(third)).toHaveValue('none');
    await interval(third).selectOption('300000');
    await expect.poll(() => JSON.parse(String(a.stored()?.body_json))).toMatchObject({ autosaveIntervalMs: 300000 });
    await third.reload(); await third.getByRole('region', { name: 'Echo-8 书库' }).press('Escape'); await command(third, '书籍与恢复设置');
    await expect(interval(third)).toHaveValue('300000'); await expect(retention(third)).toHaveValue('none');
    const other = await a.device('bob'); await expect(interval(other)).toHaveValue('60000'); await expect(retention(other)).toHaveValue('none');
  } finally { await a.close(); }
});

test('concurrent device preference edits retain local choices until explicit account conflict resolution', async ({ browser }, info) => {
  const a = await account(browser);
  try {
    const first = await a.device(), second = await a.device();
    await interval(first).selectOption('0');
    await expect.poll(() => JSON.parse(String(a.stored()?.body_json)).autosaveIntervalMs).toBe(0);
    await interval(second).selectOption('300000');
    await command(second, '云同步设置');
    await expect(second.getByRole('button', { name: '使用账号保存设置', exact: true })).toBeVisible();
    await second.screenshot({ path: info.outputPath('saving-preferences-conflict.png') });
    expect(JSON.parse(String(a.stored()?.body_json)).autosaveIntervalMs).toBe(0);
    await second.getByRole('button', { name: '使用账号保存设置', exact: true }).click();
    await command(second, '书籍与恢复设置'); await expect(interval(second)).toHaveValue('0');
    await expect(second.locator('.text-node-card')).toHaveCount(2);
  } finally { await a.close(); }
});

test('a failed account preference write rolls back both local policies and retention cleanup', async ({ browser }) => {
  test.setTimeout(60_000);
  const a = await account(browser);
  try {
    const first = await a.device(), second = await a.device();
    for (let count = 0; count < 9; count++) await second.getByRole('button', { name: '创建手动恢复点', exact: true }).click();
    await expect(second.locator('.recovery-row')).toHaveCount(9);
    await interval(first).selectOption('0'); await keep(first, '8');
    await expect.poll(() => JSON.parse(String(a.stored()?.body_json))).toMatchObject({ autosaveIntervalMs: 0, recoveryRetentionLimit: 8 });
    await second.evaluate(() => {
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(value, key) {
        if (this.name === 'meta' && key === 'autosave-interval-ms') {
          IDBObjectStore.prototype.put = original;
          throw new DOMException('模拟设置写入失败', 'QuotaExceededError');
        }
        return original.call(this, value, key);
      };
    });
    await command(second, '云同步设置');
    await second.getByRole('button', { name: '同步保存设置', exact: true }).click();
    await expect(second.getByText('模拟设置写入失败', { exact: true })).toBeVisible();
    await command(second, '书籍与恢复设置');
    await expect(interval(second)).toHaveValue('60000'); await expect(retention(second)).toHaveValue('none');
    await expect(second.locator('.recovery-row')).toHaveCount(9);
    await expect(second.locator('.text-node-card')).toHaveCount(2);
    await second.reload(); await second.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
    await command(second, '书籍与恢复设置');
    await expect(interval(second)).toHaveValue('0'); await expect(retention(second)).toHaveValue('8');
    await expect(second.locator('.recovery-row')).toHaveCount(8);
  } finally { await a.close(); }
});
