import { expect, test, type Page } from '@playwright/test';
import { serializeProject } from '../src/plugins/import-export/codec.ts';
import { createContentStorage } from '../src/plugins/text-node/content-storage.ts';
import type { ProjectSource } from '../src/protocols/files.ts';

async function openMap(page: Page) {
  await page.addInitScript(() => Object.defineProperty(window, 'showOpenFilePicker', { configurable: true, value: undefined }));
  await page.goto('/');
  await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
  const namespaces: ProjectSource['document']['namespaces'] = { textNode: {}, textContent: {}, textContentChunk: {}, connections: {} };
  for (const [id, x, y, color, presentation] of [
    ['a', -1600, -600, '#db4545', 'card'], ['b', 200, 100, '#38a16a', 'card'], ['c', 2200, 1100, '#547ce0', 'text-box'],
  ] as const) {
    const content = createContentStorage(`body-${id}`, `不应在小地图中绘制的正文${id}`, 1);
    namespaces.textContent[`body-${id}`] = content.content;
    for (const patch of content.chunkPatches) if (patch.op === 'set') namespaces.textContentChunk[patch.key] = patch.value;
    namespaces.textNode[id] = { id, contentId: `body-${id}`, title: `地图${id}`, x, y, width: 280, height: 158,
      presentation, titleColor: color, revision: 1, createdAt: 1, updatedAt: 1 };
  }
  namespaces.connections.edge = { id: 'edge', from: { nodeId: 'a', side: 'right' }, to: { nodeId: 'b', side: 'left' }, label: '不显示的连线文字框', revision: 1, createdAt: 1 };
  const blob = await serializeProject({ document: { revision: 1, namespaces }, plugins: [
    { id: 'text-node', version: '0.1.0', dataVersion: 2, namespaces: ['textNode', 'textContent', 'textContentChunk'], available: true },
    { id: 'connections', version: '0.1.0', dataVersion: 7, namespaces: ['connections', 'connectionJunction'], available: true },
  ] });
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: '命令面板' });
  await palette.getByRole('textbox', { name: '搜索命令' }).fill('打开书籍');
  await palette.getByRole('option', { name: /^打开书籍/u }).click();
  const notice = page.getByRole('status').filter({ hasText: '当前书籍还有未保存修改' });
  const chooser = page.waitForEvent('filechooser');
  await notice.getByRole('button', { name: '不保存，继续选择书籍' }).click();
  await (await chooser).setFiles({ name: '小地图.echo8', mimeType: blob.type, buffer: Buffer.from(await blob.arrayBuffer()) });
  await expect(notice).toHaveCount(0);
  await page.getByRole('button', { name: '打开小地图', exact: true }).click();
  await expect(page.locator('[data-map-node]')).toHaveCount(3);
}

async function camera(page: Page) {
  return page.locator('.canvas-world').first().evaluate((element) => {
    const transform = new DOMMatrix(getComputedStyle(element).transform);
    const host = document.querySelector('.canvas-host')!.getBoundingClientRect();
    return { x: (host.width / 2 - transform.e) / transform.a, y: (host.height / 2 - transform.f) / transform.a, zoom: transform.a };
  });
}

async function mapLocation(page: Page, x: number, y: number) {
  return page.locator('.minimap-surface').evaluate((element, point) => {
    const box = element.getBoundingClientRect();
    const block = element.querySelector<SVGRectElement>('[data-map-node="b"]')!;
    const scale = block.width.baseVal.value / 280;
    return { clientX: box.left + point.x * box.width / 240, clientY: box.top + point.y * box.height / 160,
      worldX: 200 + (point.x - block.x.baseVal.value) / scale, worldY: 100 + (point.y - block.y.baseVal.value) / scale,
      // WebKit delivers integer pointer coordinates. Allow one map CSS pixel in world space.
      tolerance: 240 / box.width / scale };
  }, { x, y });
}

test('minimap contains only colored node/text-box blocks, focuses a clicked block and pans blank clicks without zooming', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openMap(page);
  const toolbarOrder = await page.getByRole('group', { name: '画布状态', exact: true }).evaluate(element =>
    [...element.querySelectorAll('button, input')].map(control => control.getAttribute('aria-label') ?? ''));
  expect(toolbarOrder.findIndex(label => label === '关闭小地图')).toBe(toolbarOrder.findIndex(label => label.startsWith('聚焦选中项')) + 1);
  await page.locator('.minimap-surface').focus();
  await expect(page.locator('.minimap-surface')).toHaveCSS('outline-style', 'none');
  const map = page.getByRole('region', { name: '画布小地图', exact: true });
  await expect(map.locator('text, foreignObject, path, line')).toHaveCount(0);
  await expect(map).toHaveText('');
  await expect(map.locator('[data-map-node="a"]')).toHaveAttribute('fill', '#db4545');
  await expect(map.locator('[data-map-node="c"]')).toHaveAttribute('fill', '#547ce0');
  const hostBox = await page.locator('.canvas-host').boundingBox();
  const mapBox = await map.boundingBox();
  expect(mapBox!.x - hostBox!.x).toBeLessThan(20);
  expect(hostBox!.y + hostBox!.height - mapBox!.y - mapBox!.height).toBeLessThan(20);
  await map.locator('[data-map-node="c"]').click();
  await expect.poll(async () => Math.round((await camera(page)).x)).toBe(2340);
  await expect.poll(async () => Math.round((await camera(page)).y)).toBe(1179);
  const zoom = (await camera(page)).zoom;
  const target = await mapLocation(page, 210, 25);
  await page.mouse.click(target.clientX, target.clientY);
  await expect(page.locator('.minimap-click-pulse')).toBeVisible();
  await expect.poll(async () => Math.abs((await camera(page)).x - target.worldX)).toBeLessThan(target.tolerance);
  await expect.poll(async () => Math.abs((await camera(page)).y - target.worldY)).toBeLessThan(target.tolerance);
  expect((await camera(page)).zoom).toBeCloseTo(zoom);
  await page.getByRole('button', { name: '关闭小地图', exact: true }).click();
  await expect(map).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('dragging from a block pans live and never focuses; cancelling restores the initial view and releases interaction', async ({ page }) => {
  await openMap(page);
  const block = page.locator('[data-map-node="b"]');
  const box = await block.boundingBox();
  const original = await camera(page);
  const target = await mapLocation(page, 180, 120);
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.clientX, target.clientY, { steps: 8 });
  await expect.poll(async () => Math.abs((await camera(page)).x - target.worldX)).toBeLessThan(target.tolerance);
  expect((await camera(page)).zoom).toBeCloseTo(original.zoom);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect.poll(async () => (await camera(page)).x).toBeCloseTo(original.x);
  await expect.poll(async () => (await camera(page)).y).toBeCloseTo(original.y);
  // A second session can begin immediately after cancellation, including outside capture bounds.
  await page.mouse.move(box!.x + 2, box!.y + 2);
  await page.mouse.down();
  await page.mouse.move(target.clientX, target.clientY, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => Math.abs((await camera(page)).x - target.worldX)).toBeLessThan(target.tolerance);
  expect((await camera(page)).zoom).toBeCloseTo(original.zoom);
});

test('minimap can be assigned a shortcut, toggled and hot-disabled without leaving navigation controls', async ({ page }) => {
  await openMap(page);
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: '命令面板' });
  await palette.getByRole('textbox', { name: '搜索命令' }).fill('快捷键');
  await palette.getByRole('option', { name: /快捷键中心/u }).click();
  const row = page.locator('.shortcut-row').filter({ hasText: '打开或关闭小地图' });
  await expect(row).toBeVisible();
  const input = row.getByRole('textbox');
  await input.focus();
  await page.keyboard.press('Control+Alt+y');
  await expect(input).not.toHaveValue('未设置');
  await page.getByRole('button', { name: '关闭快捷键中心', exact: true }).click();
  await page.locator('.canvas-surface').focus();
  await page.keyboard.press('Control+Alt+y');
  await expect(page.locator('.canvas-minimap')).toHaveCount(0);
  await page.keyboard.press('Control+Alt+y');
  await expect(page.locator('.canvas-minimap')).toHaveCount(1);
  await page.keyboard.press('Control+k');
  await palette.getByRole('textbox', { name: '搜索命令' }).fill('插件');
  await palette.getByRole('option', { name: /插件中心/u }).click();
  const plugin = page.locator('.plugin-row').filter({ hasText: '画布小地图' });
  await plugin.getByRole('switch', { name: '停用画布小地图', exact: true }).click();
  await expect(page.locator('.canvas-minimap')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '关闭小地图', exact: true })).toHaveCount(0);
  await plugin.getByRole('switch', { name: '启用画布小地图', exact: true }).click();
  await expect(page.locator('.canvas-minimap')).toHaveCount(1);
});

test('minimap surface and click hints invert with the actual canvas background, including color preview cancellation', async ({ page }) => {
  await openMap(page);
  const map = page.locator('.canvas-minimap');
  await expect(map).toHaveAttribute('data-tone', 'light');
  await expect(map).toHaveCSS('background-color', 'rgba(255, 255, 255, 0.72)');
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: '命令面板' });
  await palette.getByRole('textbox', { name: '搜索命令' }).fill('打开全局颜色设置');
  await palette.getByRole('option', { name: /^打开全局颜色设置/u }).click();
  await page.getByRole('button', { name: '画布背景颜色', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '颜色选择器' });
  for (const channel of ['R', 'G', 'B']) await picker.getByRole('spinbutton', { name: `${channel} 通道数值` }).fill('20');
  await expect(map).toHaveAttribute('data-tone', 'dark');
  await expect(map).toHaveCSS('background-color', 'rgba(24, 25, 27, 0.72)');
  await page.keyboard.press('Escape');
  await expect(map).toHaveAttribute('data-tone', 'light');
});
