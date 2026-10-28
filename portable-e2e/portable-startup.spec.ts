import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';

const artifactUrl = pathToFileURL(resolve(process.cwd(), 'artifacts', 'Echo-8.html')).href;

test('the generated single HTML starts from the library and edits without external assets', async ({ page }) => {
  const failures: string[] = [];
  const requestedUrls: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' || /Unable to preventDefault inside passive event listener/u.test(message.text())) {
      failures.push(message.text());
    }
  });
  page.on('request', (request) => requestedUrls.push(request.url()));
  page.on('requestfailed', (request) => failures.push(
    `request failed: ${request.url()} (${request.failure()?.errorText ?? 'unknown'})`,
  ));

  await page.goto(artifactUrl, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveTitle(/Echo-8/u);
  const library = page.getByRole('region', { name: 'Echo-8 书库' });
  await expect(library).toBeVisible();
  await expect(library.locator('#cloud-books-title')).toHaveClass('sr-only');
  const libraryMark = library.locator('.book-library-brand [data-icon="echo-8"]');
  await expect(libraryMark).toBeVisible();
  await expect(libraryMark).toHaveAttribute('src', /^data:image\/svg\+xml,/u);
  const libraryMarkBox = await libraryMark.boundingBox();
  expect(libraryMarkBox).not.toBeNull();
  expect(libraryMarkBox!.width / libraryMarkBox!.height).toBeGreaterThan(2.2);
  const libraryMarkCornerAlpha = await libraryMark.evaluate((element) => {
    const image = element as HTMLImageElement;
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    context?.drawImage(image, 0, 0);
    return context?.getImageData(0, 0, 1, 1).data[3] ?? 255;
  });
  expect(libraryMarkCornerAlpha).toBe(0);
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute('href', /^data:image\/svg\+xml,/u);
  await expect(library.getByText('单文件模式已保留云同步入口')).toBeVisible();
  await expect(library.getByRole('button', { name: '继续当前浏览器中的画布' })).toHaveCount(0);
  await page.keyboard.press('Control+k');
  const commandPalette = page.getByRole('dialog', { name: '命令面板' });
  await commandPalette.getByRole('textbox', { name: '搜索命令' }).fill('进入当前画布');
  await commandPalette.getByRole('option', { name: /^进入当前画布/u }).click();
  await expect(page.getByRole('article', { name: /文本节点：/u })).toHaveCount(2);
  await expect(page.getByRole('status').filter({ hasText: '纠错规则尚未导入' })).toBeVisible();

  const sourceNode = page.getByRole('article', { name: '文本节点：AI 助手使用指南', exact: true });
  const targetNode = page.getByRole('article', { name: '文本节点：画布基本操作指南', exact: true });
  const titlePort = sourceNode.getByRole('button', { name: '从AI 助手使用指南标题栏连接', exact: true });
  const [titlePortBox, targetNodeBox] = await Promise.all([titlePort.boundingBox(), targetNode.boundingBox()]);
  expect(titlePortBox).not.toBeNull();
  expect(targetNodeBox).not.toBeNull();
  await page.mouse.move(
    titlePortBox!.x + titlePortBox!.width / 2,
    titlePortBox!.y + titlePortBox!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(targetNodeBox!.x + 8, targetNodeBox!.y + 21, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('.connection-hit-area')).toHaveCount(1);

  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  const created = page.getByRole('article', { name: '文本节点：未命名节点', exact: true });
  await expect(created).toBeVisible();
  await created.getByRole('paragraph').dblclick({ position: { x: 80, y: 80 } });
  const editor = page.locator('.editor-writing-area').first();
  await expect(editor).toBeVisible();
  await editor.focus();
  await editor.pressSequentially('便携版输入正常');
  await expect(editor).toContainText('便携版输入正常');
  await page.locator('.canvas-surface').hover({ position: { x: 120, y: 120 } });
  await page.mouse.wheel(0, -120);

  await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
  const feed = page.locator('.ai-chat-feed');
  await feed.evaluate((element) => {
    const fixture = document.createElement('div');
    fixture.style.height = '2400px';
    fixture.textContent = '便携版滚动测试';
    (element as HTMLElement).appendChild(fixture);
    element.scrollTop = 0;
  });
  const scrollbar = page.getByRole('scrollbar', { name: 'AI 对话滚动条，双击跳到最新对话' });
  await expect(scrollbar).toBeVisible();
  await scrollbar.dblclick({ position: { x: 6, y: 20 } });
  await expect.poll(async () => feed.evaluate((element) =>
    Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThanOrEqual(2);

  const externalRequests = requestedUrls.filter((url) => (
    url !== artifactUrl
    && !url.startsWith('data:')
    && !url.startsWith('blob:')
  ));
  expect(externalRequests).toEqual([]);
  expect(failures).toEqual([]);
});
