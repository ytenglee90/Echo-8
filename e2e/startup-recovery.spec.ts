import { expect, test, type Page } from '@playwright/test';

const DATABASE_NAME = 'infinite-canvas-framework';

async function seedCorruptedRecovery(page: Page): Promise<void> {
  await page.evaluate(async (databaseName) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 5);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const now = Date.now();
    const contentId = 'corrupted-content';
    const chunkId = 'corrupted-chunk';
    const snapshot = {
      formatVersion: 1,
      savedAt: now + 60_000,
      store: {
        formatVersion: 1,
        document: {
          revision: 1,
          namespaces: {
            textNode: {
              'corrupted-node': {
                id: 'corrupted-node', contentId, title: '损坏恢复数据',
                x: 0, y: 0, width: 320, height: 220, titleColor: '#202124',
                revision: 1, createdAt: now, updatedAt: now,
              },
            },
            textContent: {
              [contentId]: {
                id: contentId, storageVersion: 2, chunkIds: [chunkId],
                chunkLengths: [999], length: 999, revision: 1,
              },
            },
            textContentChunk: {
              [chunkId]: { id: chunkId, contentId, text: 'damaged' },
            },
          },
        },
        workspace: { revision: 0, namespaces: {} },
      },
      history: { undo: [], redo: [] },
      projectPlugins: [],
    };
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(['snapshots', 'journal', 'recovery'], 'readwrite');
      transaction.objectStore('snapshots').put(snapshot, 'latest');
      transaction.objectStore('journal').clear();
      transaction.objectStore('recovery').clear();
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
  }, DATABASE_NAME);
}

async function storedSnapshotTitle(page: Page): Promise<string | undefined> {
  return page.evaluate(async (databaseName) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 5);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const value = await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
      const request = database.transaction('snapshots', 'readonly').objectStore('snapshots').get('latest');
      request.onsuccess = () => resolve(request.result as Record<string, unknown> | undefined);
      request.onerror = () => reject(request.error);
    });
    database.close();
    const store = value?.store as { document?: { namespaces?: Record<string, Record<string, { title?: string }>> } } | undefined;
    return store?.document?.namespaces?.textNode?.['corrupted-node']?.title;
  }, DATABASE_NAME);
}

test('startup failure offers non-destructive safe entry and confirmed local recovery cleanup', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Echo-8 书库' })).toBeVisible();
  await seedCorruptedRecovery(page);

  await page.reload();
  const fatal = page.locator('.fatal-screen');
  await expect(fatal).toBeVisible();
  await expect(fatal).toContainText('正文分块长度校验失败');

  await fatal.getByRole('button', { name: '保留恢复数据，安全进入' }).click();
  await expect(page).toHaveURL(/echo8-safe-start=1/u);
  await expect(page.locator('.startup-safe-mode')).toContainText('恢复安全模式');
  await expect(page.getByRole('region', { name: 'Echo-8 书库' })).toBeVisible();
  expect(await storedSnapshotTitle(page)).toBe('损坏恢复数据');

  await page.getByRole('button', { name: '退出安全模式并重试恢复' }).click();
  await expect(fatal).toBeVisible();
  await fatal.getByRole('button', { name: '清除损坏的本机恢复数据' }).click();
  await expect(fatal.getByRole('alert')).toContainText('已保存的 .echo8 文件不受影响');
  await fatal.getByRole('button', { name: '确认清除并进入空白画布' }).click();

  await expect(page).not.toHaveURL(/echo8-safe-start/u);
  await expect(page.getByRole('region', { name: 'Echo-8 书库' })).toBeVisible();
  await expect(page.locator('.fatal-screen')).toHaveCount(0);
});
