import { expect, test, type Page } from '@playwright/test';
import { serializeProject } from '../src/plugins/import-export/codec.ts';
import { createContentStorage } from '../src/plugins/text-node/content-storage.ts';
import type { ProjectSource } from '../src/protocols/files.ts';

async function openFixture(page: Page) {
  await page.addInitScript(() => Object.defineProperty(window, 'showOpenFilePicker', { configurable: true, value: undefined }));
  await page.goto('/'); await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
  const namespaces: ProjectSource['document']['namespaces'] = { textNode: {}, textContent: {}, textContentChunk: {}, connections: {}, connectionJunction: {} };
  for (const [id, x] of [['a', 80], ['b', 900]] as const) {
    const content = createContentStorage(`body-${id}`, id, 1); namespaces.textContent[`body-${id}`] = content.content;
    for (const patch of content.chunkPatches) if (patch.op === 'set') namespaces.textContentChunk[patch.key] = patch.value;
    namespaces.textNode[id] = { id, contentId: `body-${id}`, title: `跟随${id}`, x, y: 80, width: 220, height: 130, titleColor: '#303030', revision: 1, createdAt: 1, updatedAt: 1 };
  }
  namespaces.connectionJunction.j1 = { id: 'j1', x: 400, y: 240, revision: 1 };
  namespaces.connectionJunction.j2 = { id: 'j2', x: 650, y: 240, revision: 1 };
  for (const [id, from, to] of [['one', { nodeId: 'a', side: 'right' }, { nodeId: 'j1', kind: 'junction', side: 'left' }],
    ['two', { nodeId: 'j1', kind: 'junction', side: 'right' }, { nodeId: 'j2', kind: 'junction', side: 'left' }],
    ['three', { nodeId: 'j2', kind: 'junction', side: 'right' }, { nodeId: 'b', side: 'left' }]] as const) namespaces.connections[id] = { id, from, to, revision: 1, createdAt: 1 };
  const blob = await serializeProject({ document: { revision: 1, namespaces }, plugins: [
    { id: 'text-node', version: '0.1.0', dataVersion: 2, namespaces: ['textNode', 'textContent', 'textContentChunk'], available: true },
    { id: 'connections', version: '0.1.0', dataVersion: 8, namespaces: ['connections', 'connectionJunction'], available: true },
  ] });
  await page.getByRole('button', { name: '命令面板', exact: true }).click(); const palette = page.getByRole('dialog', { name: '命令面板' });
  await palette.getByRole('textbox', { name: '搜索命令' }).fill('打开书籍'); await palette.getByRole('option', { name: /^打开书籍/u }).click();
  const notice = page.getByRole('status').filter({ hasText: '当前书籍还有未保存修改' }); const chooser = page.waitForEvent('filechooser');
  await notice.getByRole('button', { name: '不保存，继续选择书籍' }).click();
  await (await chooser).setFiles({ name: '中转点移动.echo8', mimeType: blob.type, buffer: Buffer.from(await blob.arrayBuffer()) });
  await expect(notice).toHaveCount(0); await expect(page.locator('.connection-junction')).toHaveCount(2);
}
async function points(page: Page) { return page.locator('.connection-junction').evaluateAll(elements => elements.map(element => element.getAttribute('transform')!.match(/-?\d+(?:\.\d+)?/gu)!.map(Number))); }

test('multiple junctions drag and nudge together, retain spacing, undo once and cancel with Escape', async ({ page }) => {
  await openFixture(page);
  const markers = page.locator('.connection-junction'), dots = page.locator('.connection-junction-dot');
  await dots.nth(0).click(); await dots.nth(1).click({ modifiers: ['Shift'] });
  await expect(page.locator('.connection-junction.selected')).toHaveCount(2);
  const initial = await points(page), box = await dots.nth(0).boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2); await page.mouse.down();
  await page.mouse.move(box!.x + 120, box!.y + 70, { steps: 10 }); await page.mouse.up();
  const expectedX = initial[0][0] + 120 - box!.width / 2;
  const expectedY = initial[0][1] + 70 - box!.height / 2;
  await expect.poll(async () => { const p = (await points(page))[0]; return Math.max(Math.abs(p[0] - expectedX), Math.abs(p[1] - expectedY)); }).toBeLessThan(2);
  const moved = await points(page);
  expect(moved[1][0] - moved[0][0]).toBe(initial[1][0] - initial[0][0]); expect(moved[1][1] - moved[0][1]).toBe(initial[1][1] - initial[0][1]);
  await page.keyboard.press('Control+z'); await expect.poll(() => points(page)).toEqual(initial);
  await page.keyboard.press('Control+Shift+z'); await expect.poll(() => points(page)).toEqual(moved);
  await markers.nth(0).focus(); await markers.nth(0).press('Shift+ArrowRight');
  await expect.poll(async () => (await points(page))[1][0]).toBe(moved[1][0] + 10);
  await page.keyboard.press('Control+z'); await expect.poll(() => points(page)).toEqual(moved);
  const current = await dots.nth(0).boundingBox();
  await page.mouse.move(current!.x + current!.width / 2, current!.y + current!.height / 2); await page.mouse.down();
  await page.mouse.move(current!.x + 80, current!.y + 80, { steps: 8 }); await page.keyboard.press('Escape'); await page.mouse.up();
  await expect.poll(() => points(page)).toEqual(moved);
});

test('junction release coordinates commit even without a final pointermove, and immediate drags never snap back', async ({ page }) => {
  await openFixture(page);
  await expect(page.getByRole('region', { name: 'Echo-8 书库' })).toBeHidden();
  const marker = page.locator('.connection-junction[data-junction-id="j1"]');
  const initial = await points(page);
  for (let i = 0; i < 3; i += 1) {
    const box = await marker.locator('.connection-junction-dot').boundingBox();
    const from = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
    await marker.evaluate(element => element.addEventListener('pointerdown', event => element.setAttribute('data-test-pointer-id', String((event as PointerEvent).pointerId)), { once: true }));
    await page.mouse.move(from.x, from.y); await page.mouse.down();
    const pointerId = Number(await marker.getAttribute('data-test-pointer-id'));
    await marker.dispatchEvent('pointerup', { pointerId, clientX: from.x + 70, clientY: from.y + 50, button: 0, buttons: 0 });
    await page.mouse.up();
    await expect.poll(async () => (await points(page))[0]).toEqual([initial[0][0] + 70 * (i + 1), initial[0][1] + 50 * (i + 1)]);
  }
  await page.waitForTimeout(150);
  await expect.poll(async () => (await points(page))[0]).toEqual([610, 390]);
  for (let i = 2; i >= 0; i -= 1) {
    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await points(page))[0]).toEqual([initial[0][0] + 70 * i, initial[0][1] + 50 * i]);
  }
  await expect(page.getByText('中转点已变化，请重新移动', { exact: true })).toHaveCount(0);
});

for (const textBox of [false, true]) test(`moving one ${textBox ? 'text box' : 'node'} keeps junctions fixed during preview, commit and undo`, async ({ page }) => {
  await openFixture(page);
  const node = page.locator('.text-node-card').filter({ has: page.locator('strong[title="跟随a"]') });
  if (textBox) {
    await node.locator('header strong').click();
    await page.getByRole('button', { name: '文本框与文字节点相互转换', exact: true }).click();
    await expect(node).toHaveClass(/text-box/u);
  }
  const initial = await points(page), header = await node.locator(textBox ? '.text-box-title' : 'header strong').boundingBox();
  const position = () => node.evaluate(element => {
    const values = /translate(?:3d)?\(([-\d.]+)px,\s*([-\d.]+)px/u.exec((element as HTMLElement).style.transform)!;
    return [Number(values[1]), Number(values[2])];
  });
  const origin = await position();
  await page.mouse.move(header!.x + 30, header!.y + 10); await page.mouse.down();
  await page.mouse.move(header!.x + 230, header!.y + 110, { steps: 10 });
  await expect.poll(async () => (await position())[0]).toBeGreaterThan(origin[0] + 100);
  await expect.poll(() => points(page)).toEqual(initial);
  const preview = initial;
  await page.mouse.up(); await expect.poll(() => points(page)).toEqual(preview);
  await page.keyboard.press('Control+z'); await expect.poll(() => points(page)).toEqual(initial);
});

for (const textBox of [false, true]) for (const method of ['keyboard', 'toolbar', 'alt'] as const) test(`copying connected ${textBox ? 'boxes' : 'nodes'} through ${method} leaves routed lines and points behind`, async ({ page }) => {
  await openFixture(page);
  const nodes = page.locator('.text-node-card');
  const a = nodes.filter({ has: page.locator('strong[title="跟随a"]') });
  const b = nodes.filter({ has: page.locator('strong[title="跟随b"]') });
  await a.locator('header strong').click(); await b.locator('header strong').click({ modifiers: ['Shift'] });
  if (textBox) {
    await page.getByRole('button', { name: '文本框与文字节点相互转换', exact: true }).click();
    await expect(page.locator('.text-node-card.text-box')).toHaveCount(2);
  }
  const initial = await points(page);
  if (method === 'alt') {
    const title = await a.locator(textBox ? '.text-box-title' : 'header strong').boundingBox();
    await page.keyboard.down('Alt'); await page.mouse.move(title!.x + 30, title!.y + 10); await page.mouse.down();
    await page.mouse.move(title!.x + 150, title!.y + 150, { steps: 8 }); await page.mouse.up(); await page.keyboard.up('Alt');
  } else if (method === 'keyboard') {
    await page.keyboard.press('Control+c'); await page.keyboard.press('Control+v');
  } else {
    await page.locator('.clipboard-actions').getByRole('button', { name: /^复制/u }).click();
    await page.locator('.clipboard-actions').getByRole('button', { name: /^粘贴/u }).click();
  }
  await expect(nodes).toHaveCount(4);
  await expect(page.locator('.connection-hit-area')).toHaveCount(3); await expect.poll(() => points(page)).toEqual(initial);
  await page.keyboard.press('Control+z'); await expect(nodes).toHaveCount(2);
  await expect(page.locator('.connection-hit-area')).toHaveCount(3); await expect.poll(() => points(page)).toEqual(initial);
});

test('a junction can leave the culled viewport and return without losing its drag capture', async ({ page }) => {
  await openFixture(page);
  const marker = page.locator('.connection-junction[data-junction-id="j1"]');
  const box = await marker.locator('.connection-junction-dot').boundingBox();
  const initial = await points(page);
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2); await page.mouse.down();
  await page.mouse.move(-400, -400, { steps: 8 });
  await expect(marker).toHaveCount(0);
  await page.mouse.move(box!.x + box!.width / 2 + 70, box!.y + box!.height / 2 + 50, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await points(page))[0]).toEqual([initial[0][0] + 70, initial[0][1] + 50]);
  await page.keyboard.press('Control+z'); await expect.poll(() => points(page)).toEqual(initial);
  const restored = await marker.locator('.connection-junction-dot').boundingBox();
  await page.mouse.move(restored!.x + restored!.width / 2, restored!.y + restored!.height / 2); await page.mouse.down();
  await page.mouse.move(-400, -400, { steps: 8 }); await expect(marker).toHaveCount(0);
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect.poll(() => points(page)).toEqual(initial);
  await expect(page.locator('.connection-junction-layer')).toHaveCSS('outline-style', 'none');
});
