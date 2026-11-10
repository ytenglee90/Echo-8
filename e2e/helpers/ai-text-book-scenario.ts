import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { parseProject } from '../../src/plugins/import-export/codec.ts';

const fixture = readFileSync(new URL('../../tests/fixtures/ai-text-book-v1.txt', import.meta.url));

export function aiTextBookScenarios(url: string): void {
  test.use({ viewport: { width: 3000, height: 4000 } });
  test('AI finished TXT renamed to echo8 opens, edits, undoes, saves and reopens without user scripts', async ({ page, context }) => {
    test.setTimeout(60_000);
    await context.addInitScript(() => Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true }));
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await openBook(page, url, fixture);
    await expect(page.locator('.text-node-card')).toHaveCount(17);
    await expect(page.locator('.text-node-card.text-box')).toHaveCount(8);
    await expect(page.locator('.group-frame')).toHaveCount(7);
    await expect(page.locator('.connection-path:not(.title-connection):not(.draft)')).toHaveCount(4);
    await expect(page.locator('.connection-path.title-connection:not(.draft)')).toHaveCount(2);
    await expect(page.locator('.connection-path.title-connection').first()).not.toHaveCSS('stroke-dasharray', 'none');
    await expect(page.locator('.connection-path:not(.title-connection)').first()).toHaveCSS('stroke-dasharray', 'none');
    const colors = await page.getByRole('article', { name: /文本节点：配角｜/u }).locator('header')
      .evaluateAll(elements => elements.map(element => getComputedStyle(element).backgroundColor));
    expect(colors).toEqual(['rgb(53, 104, 168)', 'rgb(53, 104, 168)']);
    for (const title of ['大纲', '卷纲', '小剧情｜第001卷·旧钟', '章纲｜第001卷·旧钟', '正文｜第001卷·旧钟']) {
      await expect(page.getByRole('article', { name: `文本框：${title}`, exact: true })).toBeVisible();
    }
    await page.getByRole('article', { name: /文本节点：主角｜林渊$/u }).getByRole('paragraph').dblclick({ position: { x: 50, y: 35 } });
    const editor = page.locator('.editor-writing-area').first();
    await expect(editor).toContainText('“明天见🧭”');
    await expect(editor).toContainText('<b>普通文字</b>');
    await editor.focus(); await editor.press('Control+End');
    await page.keyboard.insertText('\n直接改后缀测试已保存🧭');
    await expect(editor).toContainText('直接改后缀测试已保存🧭');
    await editor.press('Control+z'); await expect(editor).not.toContainText('直接改后缀测试已保存🧭');
    await editor.press('Control+Shift+z'); await expect(editor).toContainText('直接改后缀测试已保存🧭');
    await page.getByRole('button', { name: '关闭编辑器', exact: true }).click();
    await page.getByRole('button', { name: '命令面板', exact: true }).focus();
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: '命令面板' });
    await palette.getByRole('textbox', { name: '搜索命令' }).fill('另存本地副本');
    const downloadPromise = page.waitForEvent('download');
    await palette.getByRole('option', { name: /^另存本地副本/u }).click();
    const download = await downloadPromise;
    const stream = await download.createReadStream();
    const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const project = await parseProject(new Blob([bytes]));
    expect(project.manifest.kind).toBe('echo-8-project'); expect(project.manifest.formatVersion).toBe(2);
    expect(Object.keys(project.document.namespaces.groups)).toHaveLength(7);
    expect(Object.keys(project.document.namespaces.connections)).toHaveLength(6);
    await page.close();
    const reopened = await context.newPage(); reopened.on('pageerror', error => errors.push(error.message));
    await openBook(reopened, url, bytes); await reopened.bringToFront();
    const reopenedCard = reopened.getByRole('article', { name: /文本节点：主角｜林渊$/u });
    await reopenedCard.focus(); await reopenedCard.press('Enter');
    await expect(reopened.locator('.editor-writing-area').first()).toContainText('直接改后缀测试已保存🧭');
    expect(errors).toEqual([]);
  });

  test('incomplete AI TXT is rejected before replacing the current document', async ({ page }) => {
    await openBook(page, url, fixture);
    await expect(page.locator('.text-node-card')).toHaveCount(17);
    await page.getByRole('button', { name: '返回首页', exact: true }).click();
    const library = page.getByRole('region', { name: 'Echo-8 书库' });
    const before = await page.locator('.text-node-card').count();
    const incomplete = fixture.toString('utf8').replace('{"type":"end"}', '');
    await library.locator('input[type=file]').setInputFiles({ name: '未输出完整.echo8', mimeType: 'text/plain', buffer: Buffer.from(incomplete) });
    await expect(page.getByText(/AI 文本书籍缺少节点或结束标记/u).first()).toBeVisible();
    await expect(library).toBeVisible(); await expect(page.locator('.text-node-card')).toHaveCount(before);
  });
}

async function openBook(page: Page, url: string, buffer: Buffer): Promise<void> {
  await page.goto(url);
  const library = page.getByRole('region', { name: 'Echo-8 书库' });
  await library.locator('input[type=file]').setInputFiles({ name: 'AI直接给出的成品.echo8', mimeType: 'text/plain', buffer });
  await expect(library).toHaveCount(0);
}
