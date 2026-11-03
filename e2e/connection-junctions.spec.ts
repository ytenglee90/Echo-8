import { expect, test, type Page } from '@playwright/test';
import { serializeProject } from '../src/plugins/import-export/codec.ts';
import { createContentStorage } from '../src/plugins/text-node/content-storage.ts';
import type { ProjectSource } from '../src/protocols/files.ts';

async function openGraph(page: Page, outputs = false, title = false) {
  await page.addInitScript(() => Object.defineProperty(window, 'showOpenFilePicker', { configurable: true, value: undefined }));
  await page.goto('/');
  await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
  const namespaces: ProjectSource['document']['namespaces'] = { textNode: {}, textContent: {}, textContentChunk: {}, connections: {}, connectionJunction: {} };
  for (const [id, x, y] of [['a', 80, 80], ['b', 80, 340], ['c', 800, 210]] as const) {
    const content = createContentStorage(`body-${id}`, `正文${id}`, 1);
    namespaces.textContent[`body-${id}`] = content.content;
    for (const patch of content.chunkPatches) if (patch.op === 'set') namespaces.textContentChunk[patch.key] = patch.value;
    namespaces.textNode[id] = { id, contentId: `body-${id}`, title: `节点${id}`, x, y, width: 280, height: 158, titleColor: '#303030', revision: 1, createdAt: 1, updatedAt: 1 };
  }
  for (const [id, from, to] of (outputs ? [['edge-a', 'a', 'b'], ['edge-b', 'a', 'c']] : [['edge-a', 'a', 'c'], ['edge-b', 'b', 'c']])) {
    namespaces.connections[id] = { id, from: { nodeId: from, side: title ? 'title' : 'right' }, to: { nodeId: to, side: title ? 'title' : 'left' }, label: id, labelWidth: 100, labelHeight: 40, revision: 1, createdAt: 1 };
  }
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
  await (await chooser).setFiles({ name: '中转点测试.echo8', mimeType: blob.type, buffer: Buffer.from(await blob.arrayBuffer()) });
  await expect(notice).toHaveCount(0);
  await expect(page.locator('.connection-hit-area')).toHaveCount(2);
}

async function pointOnScreen(page: Page, x: number, y: number) {
  return page.locator('.connection-layer > g').evaluate((element, point) => {
    const matrix = (element as SVGGElement).getScreenCTM();
    if (!matrix) throw new Error('missing canvas transform');
    const result = new DOMPoint(point.x, point.y).matrixTransform(matrix);
    return { x: result.x, y: result.y };
  }, { x, y });
}

async function rightClickAt(page: Page, x: number, y: number) {
  const point = await pointOnScreen(page, x, y);
  await page.mouse.click(point.x, point.y, { button: 'right' });
}

const label = (page: Page, id: string) => page.locator(`.connection-label-foreign[data-connection-id="${id}"]`);

async function expectLabelAtSegmentMiddle(page: Page, id: string) {
  const geometry = await page.locator(`.connection-hit-area[data-connection-id="${id}"]`).evaluate((path, edgeId) => {
    const curve = path as SVGPathElement;
    const from = curve.getPointAtLength(0);
    const to = curve.getPointAtLength(curve.getTotalLength());
    const box = document.querySelector<SVGForeignObjectElement>(`.connection-label-foreign[data-connection-id="${edgeId}"]`)!;
    return { actualX: box.x.baseVal.value + box.width.baseVal.value / 2, actualY: box.y.baseVal.value + box.height.baseVal.value / 2,
      expectedX: (from.x + to.x) / 2, expectedY: (from.y + to.y) / 2 };
  }, id);
  expect(geometry.actualX).toBeCloseTo(geometry.expectedX, 1);
  expect(geometry.actualY).toBeCloseTo(geometry.expectedY, 1);
}

test('a right-click adds one movable junction, labels follow its branch and deleting it restores the node connection', async ({ page }) => {
  await openGraph(page);
  const originalPath = await page.locator('[data-connection-id="edge-a"].connection-hit-area').getAttribute('d');
  await label(page, 'edge-a').click();
  await rightClickAt(page, 540, 520);
  const junction = page.locator('.connection-junction');
  await expect(junction).toHaveCount(1);
  await expect(junction).toHaveAttribute('transform', 'translate(540 520)');
  await expect(page.locator('.connection-hit-area')).toHaveCount(3);
  await expectLabelAtSegmentMiddle(page, 'edge-a');
  const start = await pointOnScreen(page, 540, 520);
  const end = await pointOnScreen(page, 615, 590);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 10 });
  await page.mouse.up();
  await expect(junction).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => junction.getAttribute('transform')).not.toBe('translate(540 520)');
  await expectLabelAtSegmentMiddle(page, 'edge-a');
  const beforeKeyboard = await junction.getAttribute('transform');
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => junction.getAttribute('transform')).not.toBe(beforeKeyboard);
  await expectLabelAtSegmentMiddle(page, 'edge-a');
  await page.keyboard.press('Delete');
  await expect(junction).toHaveCount(0);
  await expect(page.locator('.connection-hit-area')).toHaveCount(2);
  await expect(page.locator('[data-connection-id="edge-a"].connection-hit-area')).toHaveAttribute('d', originalPath!);
  await page.keyboard.press('Control+z');
  await expect(junction).toHaveCount(1);
  await expect(page.locator('.connection-hit-area')).toHaveCount(3);
});

for (const outputs of [false, true]) test(`multiple ${outputs ? 'outgoing' : 'incoming'} lines share exactly one junction and deleting its trunk leaves the branches intact`, async ({ page }) => {
  await openGraph(page, outputs);
  await label(page, 'edge-a').click();
  await label(page, 'edge-b').click({ modifiers: ['Shift'] });
  await rightClickAt(page, 540, 520);
  await expect(page.locator('.connection-junction')).toHaveCount(1);
  await expect(page.locator('.connection-hit-area')).toHaveCount(3);
  await expectLabelAtSegmentMiddle(page, 'edge-a');
  await expectLabelAtSegmentMiddle(page, 'edge-b');
  const trunk = page.locator('.connection-hit-area:not([data-connection-id="edge-a"]):not([data-connection-id="edge-b"])');
  await trunk.focus();
  await trunk.press('Enter');
  await expect(trunk).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Delete');
  await expect(page.locator('.connection-hit-area')).toHaveCount(2);
  await expect(page.locator('.connection-junction')).toHaveCount(1);
  await expect(label(page, 'edge-a')).toBeVisible();
  await expect(label(page, 'edge-b')).toBeVisible();
});

test('junction drag snaps to node references and its actions are configurable in shortcut centre', async ({ page }) => {
  await openGraph(page);
  await label(page, 'edge-a').click();
  await rightClickAt(page, 540, 520);
  const start = await pointOnScreen(page, 540, 520);
  const end = await pointOnScreen(page, 785, 465);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 10 });
  await expect(page.locator('.canvas-snap-guide')).not.toHaveCount(0);
  await page.mouse.up();
  await expect(page.locator('.connection-junction')).toHaveAttribute('transform', /translate\(800 /u);
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: '命令面板' });
  await palette.getByRole('textbox', { name: '搜索命令' }).fill('打开快捷键中心');
  await palette.getByRole('option', { name: /^打开快捷键中心/u }).click();
  const centre = page.getByRole('region', { name: '快捷键中心' });
  await centre.getByPlaceholder('搜索操作或分类…').fill('中转点');
  await expect(centre.getByRole('textbox', { name: '修改在鼠标位置添加连接中转点的快捷键' })).toBeVisible();
  await expect(centre.getByRole('textbox', { name: '修改删除选中中转点并恢复节点连接的快捷键' })).toBeVisible();
  await centre.getByRole('textbox', { name: '修改在鼠标位置添加连接中转点的快捷键' }).focus();
  await page.keyboard.press('Control+Alt+j');
  await centre.getByRole('button', { name: '关闭快捷键中心', exact: true }).click();
  const branch = page.locator('.connection-hit-area[data-connection-id="edge-a"]');
  await branch.focus();
  await branch.press('Enter');
  const pointer = await pointOnScreen(page, 620, 530);
  await page.mouse.move(pointer.x, pointer.y);
  await page.keyboard.press('Control+Alt+j');
  await expect(page.locator('.connection-junction')).toHaveCount(2);
});

test('title routes and their text boxes stay dashed before and after shared junction routing', async ({ page }) => {
  await openGraph(page, false, true);
  const paths = page.locator('.connection-path');
  await expect(paths).toHaveCount(2);
  for (const path of await paths.all()) await expect(path).toHaveCSS('stroke-dasharray', '6px, 4px');
  for (const box of await page.locator('.connection-label-display').all()) await expect(box).toHaveCSS('border-top-style', 'dashed');
  const firstHit = page.locator('.connection-hit-area[data-connection-id="edge-a"]');
  await firstHit.focus();
  await firstHit.press('F2');
  await expect(page.getByRole('textbox', { name: '连接文字', exact: true })).toHaveCSS('border-top-style', 'dashed');
  await page.keyboard.press('Enter');
  await firstHit.focus();
  await firstHit.press('Enter');
  await label(page, 'edge-b').click({ modifiers: ['Shift'] });
  await rightClickAt(page, 540, 520);
  await expect(page.locator('.connection-junction')).toHaveCount(1);
  await expect(paths).toHaveCount(3);
  for (const path of await paths.all()) await expect(path).toHaveCSS('stroke-dasharray', '6px, 4px');
  for (const box of await page.locator('.connection-label-display').all()) await expect(box).toHaveCSS('border-top-style', 'dashed');
  await page.locator('.connection-junction').click();
  await page.keyboard.press('Delete');
  await expect(paths).toHaveCount(2);
  for (const path of await paths.all()) await expect(path).toHaveCSS('stroke-dasharray', '6px, 4px');
});
