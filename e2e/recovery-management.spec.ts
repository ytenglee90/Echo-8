import { test, expect, type Page } from '@playwright/test';

async function command(page: Page, label: string) {
  await page.getByRole('button', { name: '命令面板', exact: true }).click();
  const panel = page.getByRole('dialog', { name: '命令面板' });
  await panel.getByRole('textbox', { name: '搜索命令' }).fill(label);
  await panel.getByRole('option', { name: new RegExp(`^${label}`, 'u') }).first().click();
}

async function start(page: Page) {
  await page.goto('/');
  await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  await command(page, '书籍与恢复设置');
  await page.getByRole('button', { name: '创建手动恢复点', exact: true }).click();
  await expect(page.locator('.recovery-row')).toHaveCount(1);
}

async function seedCopies(page: Page, count: number) {
  // Legacy schema fixture: no new retention preference and no backup marker.
  await page.evaluate(async (amount) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('infinite-canvas-framework', 5);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('recovery', 'readwrite');
      const store = tx.objectStore('recovery');
      const request = store.openCursor();
      request.onsuccess = () => {
        const original = request.result!.value;
        for (let index = 1; index <= amount; index++) {
          const createdAt = original.summary.createdAt - index * 1000;
          const id = `recovery:${createdAt}:fixture-${index}`;
          store.put({ ...original, summary: { ...original.summary, id, label: `旧副本 ${index}`, createdAt } }, id);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, count);
  await page.keyboard.press('Escape');
  await command(page, '书籍与恢复设置');
}

test('single, selected and clear operations preserve current document and undo across restart', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await start(page);
  await seedCopies(page, 3);
  const manager = page.getByRole('region', { name: '恢复副本管理', exact: true });
  const rows = manager.locator('.recovery-row');
  await expect(rows).toHaveCount(4);
  const localData = page.getByRole('region', { name: '本机数据与恢复', exact: true });
  await expect(localData.getByRole('region', { name: '浏览器本地数据占用与清理', exact: true })).toBeVisible();
  await expect(localData.getByRole('region', { name: '恢复副本管理', exact: true })).toBeVisible();
  await expect(localData.getByRole('button', { name: '选择已加载副本', exact: true })).toHaveCount(0);
  await rows.first().getByRole('button', { name: /^删除恢复副本/u }).click();
  const confirm = manager.getByRole('group', { name: '确认清理恢复副本' });
  await manager.screenshot({ path: info.outputPath('recovery-manager.png') });
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  await expect(rows).toHaveCount(4);
  await rows.first().getByRole('button', { name: /^删除恢复副本/u }).click();
  await confirm.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(rows).toHaveCount(3);
  await rows.nth(0).getByRole('checkbox').check();
  await rows.nth(1).getByRole('checkbox').check();
  await manager.getByRole('button', { name: /^删除选中副本/u }).click();
  await confirm.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(rows).toHaveCount(1);
  await manager.getByRole('button', { name: '清空恢复副本', exact: true }).click();
  await confirm.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(rows).toHaveCount(0);
  await expect(page.locator('.text-node-card')).toHaveCount(3);
  await page.reload();
  await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
  await expect(page.locator('.text-node-card')).toHaveCount(3);
  await command(page, '书籍与恢复设置');
  await expect(rows).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z');
  await expect(page.locator('.text-node-card')).toHaveCount(2);
  await page.keyboard.press('Control+Shift+z');
  await expect(page.locator('.text-node-card')).toHaveCount(3);
  expect(errors).toEqual([]);
});

test('old recovery records paginate and retention is opt-in, confirmed and durable', async ({ page }) => {
  await start(page);
  await seedCopies(page, 34);
  const manager = page.getByRole('region', { name: '恢复副本管理', exact: true });
  const rows = manager.locator('.recovery-row');
  const retention = manager.getByRole('combobox', { name: '恢复副本自动保留数量' });
  await expect(retention).toHaveValue('none');
  await expect(rows).toHaveCount(30);
  await manager.getByRole('button', { name: '加载更多恢复副本' }).click();
  await expect(rows).toHaveCount(35);
  await retention.selectOption('8');
  const confirm = manager.getByRole('group', { name: '确认清理恢复副本' });
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  await expect(rows).toHaveCount(35);
  await expect(retention).toHaveValue('none');
  await retention.selectOption('8');
  await confirm.getByRole('button', { name: '确认更改', exact: true }).click();
  await expect(rows).toHaveCount(8);
  await expect(retention).toHaveValue('8');
  await page.getByRole('button', { name: '创建手动恢复点' }).click();
  await expect(rows).toHaveCount(8);
  await expect(manager.getByText('旧副本 7', { exact: true })).toHaveCount(0);
  await page.reload();
  await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
  await command(page, '书籍与恢复设置');
  await expect(retention).toHaveValue('8');
  await expect(rows).toHaveCount(8);
  await retention.selectOption('none');
  await confirm.getByRole('button', { name: '确认更改', exact: true }).click();
  await expect(retention).toHaveValue('none');
  await page.getByRole('button', { name: '创建手动恢复点' }).click();
  await expect(rows).toHaveCount(9);
});

test('deletion releases recovery-only chunks while preserving shared content and personal data', async ({ page }) => {
  await start(page);
  const sharedChunkIds = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open('infinite-canvas-framework', 5);
      request.onsuccess = () => resolve(request.result);
    });
    const shared = await new Promise<string[]>((resolve, reject) => {
      const tx = db.transaction(['recovery', 'contentChunks', 'meta', 'personalAssets'], 'readwrite');
      const store = tx.objectStore('recovery');
      const request = store.openCursor();
      let chunkIds: string[] = [];
      request.onsuccess = () => {
        const original = request.result!.value;
        chunkIds = original.snapshot.contentChunkIds;
        const createdAt = original.summary.createdAt - 1000;
        const id = `recovery:${createdAt}:isolated`;
        store.put({ ...original, summary: { ...original.summary, id, createdAt, label: '只用于旧版本的正文' },
          snapshot: { ...original.snapshot, contentChunkIds: [...chunkIds, 'fixture-old-only'] } }, id);
        tx.objectStore('contentChunks').put({ text: '旧版本专用正文' }, 'fixture-old-only');
        tx.objectStore('meta').put('personal-setting-kept', 'fixture-setting');
        tx.objectStore('personalAssets').put({ text: 'pending-upload-kept' }, 'fixture-pending');
      };
      tx.oncomplete = () => resolve(chunkIds);
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return shared;
  });
  expect(sharedChunkIds.length).toBeGreaterThan(0);
  await page.reload();
  await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
  await command(page, '书籍与恢复设置');
  const manager = page.getByRole('region', { name: '恢复副本管理', exact: true });
  await expect(manager.locator('.recovery-row')).toHaveCount(2);
  await manager.getByRole('button', { name: '删除恢复副本：只用于旧版本的正文', exact: true }).click();
  await manager.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(manager.locator('.recovery-row')).toHaveCount(1);
  const retained = await page.evaluate(async (ids) => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open('infinite-canvas-framework', 5);
      request.onsuccess = () => resolve(request.result);
    });
    const result = await new Promise<{ oldMissing: boolean; sharedCount: number; setting: string; pending: string }>((resolve) => {
      const tx = db.transaction(['contentChunks', 'meta', 'personalAssets'], 'readonly');
      const chunks = tx.objectStore('contentChunks');
      const old = chunks.get('fixture-old-only');
      const shared = ids.map((id) => chunks.get(id));
      const setting = tx.objectStore('meta').get('fixture-setting');
      const pending = tx.objectStore('personalAssets').get('fixture-pending');
      tx.oncomplete = () => resolve({ oldMissing: old.result === undefined, sharedCount: shared.filter((r) => r.result !== undefined).length, setting: setting.result, pending: pending.result.text });
    });
    db.close();
    return result;
  }, sharedChunkIds);
  expect(retained).toEqual({ oldMissing: true, sharedCount: sharedChunkIds.length, setting: 'personal-setting-kept', pending: 'pending-upload-kept' });
  await manager.getByRole('button', { name: '预览并恢复', exact: true }).click();
  await expect(manager.getByText('恢复前预览', { exact: true })).toBeVisible();
  await manager.getByRole('button', { name: '确认恢复', exact: true }).click();
  await expect(page.locator('.text-node-card')).toHaveCount(3);
});
