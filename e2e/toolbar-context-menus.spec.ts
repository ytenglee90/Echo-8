import { expect, test, type Page } from '@playwright/test';
import { serializeProject } from '../src/plugins/import-export/codec.ts';
import { createContentStorage } from '../src/plugins/text-node/content-storage.ts';
import type { ProjectSource } from '../src/protocols/files.ts';

test.use({ viewport: { width: 1600, height: 960 } });
async function openFixture(page: Page, grouped = false, lines?: 'parallel' | 'mixed' | 'unrelated') {
  const namespaces: ProjectSource['document']['namespaces'] = { textNode: {}, textContent: {}, textContentChunk: {}, groups: {}, connections: {}, connectionJunction: {} };
  for (let index = 0; index < 4; index++) {
    const id = `toolbar-node-${index}`, contentId = `toolbar-body-${index}`;
    const content = createContentStorage(contentId, '工具栏测试正文', 1);
    namespaces.textContent[contentId] = content.content;
    for (const patch of content.chunkPatches) if (patch.op === 'set') namespaces.textContentChunk[patch.key] = patch.value;
    namespaces.textNode[id] = { id, contentId, title: `对象 ${index + 1}`, x: grouped ? index < 3 ? 100 + index * 400 : 500 : 100 + index % 2 * 500,
      y: grouped ? index < 3 ? 200 : 600 : 200 + Math.floor(index / 2) * 300, width: 260, height: 146, titleColor: '#444444', revision: 1, createdAt: 1, updatedAt: 1 };
  }
  if (grouped) namespaces.groups['toolbar-group'] = { id: 'toolbar-group', memberIds: ['toolbar-node-0', 'toolbar-node-1', 'toolbar-node-2'], title: '', titleStyle: { fontSize: 13, fontWeight: 650 }, revision: 1, createdAt: 1, updatedAt: 1 };
  if (lines) {
    namespaces.connections['toolbar-line-0'] = { id: 'toolbar-line-0', from: { nodeId: 'toolbar-node-0', side: 'right' }, to: { nodeId: 'toolbar-node-1', side: 'left' }, labelWidth: 120, labelHeight: 32, revision: 1, createdAt: 1 };
    namespaces.connections['toolbar-line-1'] = { id: 'toolbar-line-1',
      from: { nodeId: lines === 'unrelated' ? 'toolbar-node-2' : 'toolbar-node-0', side: lines === 'mixed' ? 'title' : lines === 'parallel' ? 'left' : 'right' },
      to: { nodeId: lines === 'unrelated' ? 'toolbar-node-3' : 'toolbar-node-1', side: lines === 'mixed' ? 'title' : lines === 'parallel' ? 'right' : 'left' },
      ...(lines === 'mixed' ? { titleRoute: true, titleOrigin: { side: 'left', sourceIsLeft: true } } : {}), labelWidth: 120, labelHeight: 32, revision: 1, createdAt: 1 };
  }
  const blob = await serializeProject({ document: { revision: 1, namespaces }, plugins: [
    { id: 'text-node', version: '0.1.0', dataVersion: 2, namespaces: ['textNode', 'textContent', 'textContentChunk'], available: true },
    { id: 'groups', version: '0.1.0', dataVersion: 2, namespaces: ['groups'], available: true },
    { id: 'connections', version: '0.1.0', dataVersion: 14, namespaces: ['connections', 'connectionJunction'], available: true },
  ] });
  await page.goto('/');
  const library = page.getByRole('region', { name: 'Echo-8 书库' });
  await library.locator('input[type=file]').setInputFiles({ name: '导航栏测试.e8', mimeType: blob.type, buffer: Buffer.from(await blob.arrayBuffer()) });
  await expect(library).toHaveCount(0);
  await expect(page.locator('.text-node-card')).toHaveCount(4);
}
const card = (page: Page, index: number) => page.getByRole('article', { name: new RegExp(`文本节点：对象 ${index + 1}$`, 'u') });
async function select(page: Page, indices: number[]) {
  for (const [position, index] of indices.entries()) await card(page, index).click({ position: { x: 80, y: 16 }, ...(position ? { modifiers: ['Control'] as const } : {}) });
}
async function clickCurve(page: Page, index: number | string = 0, add = false) {
  const target = typeof index === 'number' ? page.locator('.connection-hit-area').nth(index) : page.locator(`.connection-hit-area[data-connection-id="${index}"]`);
  const point = await target.evaluate(element => {
    const path = element as SVGPathElement;
    for (const step of [...Array.from({ length: 20 }, (_, index) => index + 20), ...Array.from({ length: 19 }, (_, index) => index + 1)]) {
      const point = path.getPointAtLength(path.getTotalLength() * step / 40);
      const screen = new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM()!);
      if (document.elementFromPoint(screen.x, screen.y) === path) return { x: screen.x, y: screen.y };
    }
    throw new Error('No exposed connection stroke was found');
  });
  if (add) await page.keyboard.down('Control');
  try { await page.mouse.click(point.x, point.y); }
  finally { if (add) await page.keyboard.up('Control'); }
}

for (const lines of ['parallel', 'mixed', 'unrelated'] as const) test(`junction remains in its fixed menu slot for ${lines} selected lines and batches into one undo`, async ({ page }, info) => {
  await openFixture(page, false, lines);
  if (lines === 'parallel') {
    const center = await page.locator('.connection-hit-area').first().evaluate(element => {
      const path = element as SVGPathElement, point = path.getPointAtLength(path.getTotalLength() / 2);
      const screen = new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM()!);
      return { x: screen.x, y: screen.y };
    });
    await page.mouse.move(center.x - 20, center.y - 40); await page.mouse.down();
    await page.mouse.move(center.x + 20, center.y + 40, { steps: 8 }); await page.mouse.up();
  } else { await clickCurve(page, 'toolbar-line-0'); await clickCurve(page, 'toolbar-line-1', true); }
  await expect(page.locator('.connection-hit-area[aria-pressed="true"]')).toHaveCount(2);
  if (lines === 'unrelated') await card(page, 0).click({ position: { x: 80, y: 16 }, modifiers: ['Control'] });
  await page.getByRole('button', { name: '断开选中连线', exact: true }).hover();
  const menu = page.getByRole('menu', { name: '连接选项' });
  await expect(menu.getByRole('menuitem')).toHaveCount(3);
  await expect(menu.getByRole('menuitem').nth(0)).toHaveAccessibleName('断开正文连接');
  await expect(menu.getByRole('menuitem').nth(1)).toHaveAccessibleName(lines === 'mixed' ? '断开标题连接' : '标题连接');
  const create = menu.getByRole('menuitem').nth(2);
  await expect(create).toHaveAccessibleName('创建中转点'); await expect(create).toBeEnabled();
  await menu.screenshot({ path: info.outputPath('fixed-vertical-connection-icons.png') });
  await create.click();
  await expect(page.locator('.connection-junction')).toHaveCount(lines === 'parallel' ? 1 : 2);
  await expect(page.getByRole('button', { name: '删除中转点', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.locator('.connection-junction')).toHaveCount(0);
  await expect(page.locator('.connection-hit-area')).toHaveCount(2);
  await expect(page.locator('.text-node-card')).toHaveCount(4);
});

test('connection icon menu toggles body/title separately and adds/removes a selected-line junction with one undo', async ({ page }, info) => {
  await openFixture(page); await select(page, [0, 1]);
  const body = page.getByRole('button', { name: '正文连接', exact: true });
  await body.hover();
  const menu = page.getByRole('menu', { name: '连接选项' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '创建中转点', exact: true })).toBeDisabled();
  await expect(menu.getByRole('menuitem')).toHaveCount(3);
  const menuBox = (await menu.boundingBox())!;
  const firstIcon = (await menu.getByRole('menuitem').first().boundingBox())!;
  const lastIcon = (await menu.getByRole('menuitem').last().boundingBox())!;
  expect(Math.abs((firstIcon.x - menuBox.x) - (menuBox.x + menuBox.width - lastIcon.x - lastIcon.width))).toBeLessThan(1);
  expect(lastIcon.y).toBeGreaterThan(firstIcon.y + firstIcon.height);
  await menu.getByRole('menuitem', { name: '标题连接', exact: true }).click();
  await expect(page.locator('.connection-hit-area')).toHaveCount(1);
  await body.click(); await expect(page.locator('.connection-hit-area')).toHaveCount(2);
  await page.getByRole('button', { name: '断开正文连接', exact: true }).click();
  await expect(page.locator('.connection-hit-area')).toHaveCount(1);
  await clickCurve(page);
  await page.getByRole('button', { name: '断开选中连线', exact: true }).hover();
  await expect(menu.getByRole('menuitem', { name: '创建中转点', exact: true })).toBeEnabled();
  await menu.screenshot({ path: info.outputPath('connection-icons.png') });
  await menu.getByRole('menuitem', { name: '创建中转点', exact: true }).click();
  await expect(page.locator('.connection-junction')).toHaveCount(1);
  await expect(page.locator('.connection-hit-area')).toHaveCount(2);
  await page.getByRole('button', { name: '删除中转点', exact: true }).hover();
  await expect(menu.getByRole('menuitem').nth(2)).toHaveAccessibleName('删除中转点');
  await menu.getByRole('menuitem', { name: '删除中转点', exact: true }).click();
  await expect(page.locator('.connection-junction')).toHaveCount(0);
  await expect(page.locator('.connection-hit-area')).toHaveCount(1);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.locator('.connection-junction')).toHaveCount(1);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(page.locator('.connection-junction')).toHaveCount(0);
  await expect(page.locator('.text-node-card')).toHaveCount(4);
});

test('toolbar hover menu supports keyboard navigation, Escape focus restoration and delayed pointer close', async ({ page }) => {
  await openFixture(page); await select(page, [0, 1]);
  const trigger = page.getByRole('button', { name: '正文连接', exact: true });
  await trigger.focus(); await trigger.press('ArrowDown');
  const menu = page.getByRole('menu', { name: '连接选项' });
  await expect(menu.getByRole('menuitem', { name: '正文连接', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: '标题连接', exact: true })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(menu).toBeHidden(); await expect(trigger).toBeFocused();
  await trigger.hover(); await expect(menu).toBeVisible();
  await menu.hover(); await expect(menu).toBeVisible();
  await page.mouse.move(1500, 850); await expect(menu).toBeHidden();
  await expect(page.locator('.connection-hit-area')).toHaveCount(0);
});

test('arrangement dropdown has vertical fixed layouts while primary clicks cycle grid horizontal vertical', async ({ page }, info) => {
  await openFixture(page); await select(page, [0, 1, 2]);
  const arrange = page.getByRole('button', { name: '自动排列（宫格、横排、竖排轮转）', exact: true });
  await arrange.hover();
  const menu = page.getByRole('menu', { name: '自动排列选项' });
  await expect(menu.getByRole('menuitem')).toHaveCount(3);
  await menu.screenshot({ path: info.outputPath('arrangement-icons.png') });
  await menu.getByRole('menuitem', { name: '横排', exact: true }).click();
  await expect.poll(async () => Math.round((await card(page, 2).boundingBox())!.y - (await card(page, 0).boundingBox())!.y)).toBe(0);
  await arrange.hover(); await menu.getByRole('menuitem', { name: '竖排', exact: true }).click();
  await expect.poll(async () => Math.round((await card(page, 2).boundingBox())!.x - (await card(page, 0).boundingBox())!.x)).toBe(0);
  await arrange.click();
  await expect(arrange.locator('[data-icon="grid-horizontal"]')).toBeVisible();
  await expect.poll(async () => Math.round((await card(page, 0).boundingBox())!.y - (await card(page, 1).boundingBox())!.y)).toBe(0);
  await expect.poll(async () => Math.round((await card(page, 2).boundingBox())!.x - (await card(page, 0).boundingBox())!.x)).toBe(0);
  expect((await card(page, 2).boundingBox())!.y).toBeGreaterThan((await card(page, 0).boundingBox())!.y + 100);
  await arrange.click();
  await expect(arrange.locator('[data-icon="grid-vertical"]')).toBeVisible();
  await expect.poll(async () => Math.round((await card(page, 2).boundingBox())!.y - (await card(page, 0).boundingBox())!.y)).toBe(0);
  await arrange.click();
  await expect(arrange.locator('[data-icon="grid"]')).toBeVisible();
  await expect.poll(async () => Math.round((await card(page, 2).boundingBox())!.x - (await card(page, 0).boundingBox())!.x)).toBe(0);
  expect((await card(page, 2).boundingBox())!.y).toBeGreaterThan((await card(page, 0).boundingBox())!.y + 200);
});

test('group icon switches to add or kick directly without a dropdown or dialog', async ({ page }, info) => {
  await openFixture(page, true);
  const group = page.locator('.group-frame');
  const original = (await group.boundingBox())!;
  await select(page, [3]);
  await group.click({ position: { x: 8, y: 8 }, modifiers: ['Control'] });
  const add = page.getByRole('button', { name: '加入群组', exact: true });
  await expect(add).toBeEnabled(); await add.hover();
  await expect(page.getByRole('menu', { name: '群组选项' })).toHaveCount(0);
  await expect(add).not.toHaveAttribute('aria-haspopup');
  await add.click();
  await expect.poll(async () => (await group.boundingBox())!.height).toBeGreaterThan(original.height + 200);
  await select(page, [3]);
  const kick = page.getByRole('button', { name: '踢出群组', exact: true });
  await expect(kick).toBeEnabled(); await expect(kick.locator('[data-icon="group-remove"]')).toBeVisible();
  await kick.hover(); await kick.screenshot({ path: info.outputPath('group-kick-icon.png') });
  await kick.click();
  await expect.poll(async () => Math.round((await group.boundingBox())!.height)).toBe(Math.round(original.height));
  await expect(page.getByRole('dialog', { name: '加入或移出已有群组' })).toHaveCount(0);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect.poll(async () => (await group.boundingBox())!.height).toBeGreaterThan(original.height + 200);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect.poll(async () => Math.round((await group.boundingBox())!.height)).toBe(Math.round(original.height));
});
