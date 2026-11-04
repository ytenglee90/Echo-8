import { expect, test, type Page } from '@playwright/test';
import { serializeProject } from '../src/plugins/import-export/codec.ts';
import { createContentStorage } from '../src/plugins/text-node/content-storage.ts';
import type { ProjectSource } from '../src/protocols/files.ts';

async function openFixture(page: Page, existing = false, titleRoute = false, labels = false) {
  await page.addInitScript(() => Object.defineProperty(window, 'showOpenFilePicker', { configurable: true, value: undefined }));
  await page.goto('/'); await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
  const namespaces: ProjectSource['document']['namespaces'] = { textNode: {}, textContent: {}, textContentChunk: {}, connections: {}, connectionJunction: {} };
  for (const [id, x, y, box] of [['a', 80, 80, false], ['b', 80, 370, true], ['c', 780, 80, false], ['d', 780, 370, true]] as const) {
    const content = createContentStorage(`body-${id}`, `正文${id}`, 1);
    namespaces.textContent[`body-${id}`] = content.content;
    for (const patch of content.chunkPatches) if (patch.op === 'set') namespaces.textContentChunk[patch.key] = patch.value;
    namespaces.textNode[id] = { id, contentId: `body-${id}`, title: `演示${id}`, x, y, width: 280, height: box ? 100 : 180,
      presentation: box ? 'text-box' : 'card', cardSize: { width: 280, height: 180 }, textBoxSize: { width: 280, height: 180 },
      titleColor: '#ab3745', revision: 1, createdAt: 1, updatedAt: 1 };
  }
  namespaces.connectionJunction.j = { id: 'j', x: 430, y: 30, revision: 1 };
  namespaces.connections.incoming = { id: 'incoming', from: { nodeId: 'a', side: titleRoute ? 'title' : 'right' }, to: { nodeId: 'j', kind: 'junction', side: 'left' }, revision: 1, createdAt: 1 };
  if (existing) for (const [id, source, title] of [['dashed', 'b', true], ['solid', 'a', false]] as const) namespaces.connections[id] = {
    id, ...(labels ? { label: `标签${id}`, labelBackgroundColor: '#00ff00', lineColor: '#ab3745' } : {}), from: { nodeId: source, side: title ? 'title' : 'right' }, to: { nodeId: 'c', side: title ? 'title' : 'left' }, revision: 1, createdAt: 1,
  };
  const blob = await serializeProject({ document: { revision: 1, namespaces }, plugins: [
    { id: 'text-node', version: '0.1.0', dataVersion: 2, namespaces: ['textNode', 'textContent', 'textContentChunk'], available: true },
    { id: 'connections', version: '0.1.0', dataVersion: 8, namespaces: ['connections', 'connectionJunction'], available: true },
  ] });
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: '命令面板' });
  await palette.getByRole('textbox', { name: '搜索命令' }).fill('打开书籍');
  await palette.getByRole('option', { name: /^打开书籍/u }).click();
  const notice = page.getByRole('status').filter({ hasText: '当前书籍还有未保存修改' });
  const chooser = page.waitForEvent('filechooser');
  await notice.getByRole('button', { name: '不保存，继续选择书籍' }).click();
  await (await chooser).setFiles({ name: '连接属性.echo8', mimeType: blob.type, buffer: Buffer.from(await blob.arrayBuffer()) });
  await expect(notice).toHaveCount(0); await expect(page.locator('.connection-hit-area')).toHaveCount(existing ? 3 : 1);
}
const path = (page: Page, id: string) => page.locator(`.connection-hit-area[data-connection-id="${id}"]`);
async function coordinates(page: Page, id: string) { return (await path(page, id).getAttribute('d'))!.match(/-?\d+(?:\.\d+)?/gu)!.map(Number); }
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 10 }); await page.mouse.up();
}

test('drag previews switch immediately between solid body targets and dashed title targets', async ({ page }) => {
  await openFixture(page);
  const from = await page.getByRole('button', { name: '从演示b右侧连接', exact: true }).boundingBox();
  const target = await page.getByRole('button', { name: '从演示c标题栏左侧连接', exact: true }).boundingBox();
  const body = await page.locator('.text-node-card').filter({ has: page.locator('strong[title="演示c"]') }).boundingBox();
  const draft = page.locator('.connection-path.draft');
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2); await page.mouse.down();
  await page.mouse.move(560, 300, { steps: 8 }); await expect(draft).toHaveCSS('stroke-dasharray', 'none');
  await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height / 2, { steps: 8 });
  await expect(draft).not.toHaveCSS('stroke-dasharray', 'none');
  await page.mouse.move(body!.x, body!.y + body!.height / 2, { steps: 8 });
  await expect(draft).toHaveCSS('stroke-dasharray', 'none');
  await page.mouse.up(); await expect(page.locator('.connection-path:not(.draft).title-connection')).toHaveCount(0);
});

for (const side of ['左', '右']) test(`text boxes connect to the ${side} title port and keep their own anchor centred`, async ({ page }) => {
  await openFixture(page);
  const from = await page.getByRole('button', { name: '从演示b右侧连接', exact: true }).boundingBox();
  const to = await page.getByRole('button', { name: `从演示c标题栏${side}侧连接`, exact: true }).boundingBox();
  await drag(page, { x: from!.x + from!.width / 2, y: from!.y + from!.height / 2 }, { x: to!.x + to!.width / 2, y: to!.y + to!.height / 2 });
  await expect(page.locator('.connection-hit-area')).toHaveCount(2);
  const edge = page.locator('.connection-hit-area:not([data-connection-id="incoming"])');
  const id = (await edge.getAttribute('data-connection-id'))!;
  const points = await coordinates(page, id);
  expect(points.slice(0, 2)).toEqual([360, 420]); expect(points.slice(-2)).toEqual([780, 101]);
  await expect(edge.locator('..').locator('.connection-path')).toHaveClass(/title-connection/u);
});

test('same-size node and text-box conversions automatically preserve solid/body and dashed/title attachment', async ({ page }) => {
  await openFixture(page, true);
  const target = page.locator('.text-node-card').filter({ has: page.locator('strong[title="演示c"]') });
  await expect.poll(async () => (await coordinates(page, 'dashed')).at(-1)).toBe(101);
  await expect.poll(async () => (await coordinates(page, 'solid')).at(-1)).toBe(170);
  await target.locator('header strong').click();
  const convert = page.getByRole('button', { name: '文本框与文字节点相互转换', exact: true });
  await convert.click(); await expect(target).toHaveClass(/text-box/u);
  await expect.poll(async () => (await coordinates(page, 'dashed')).at(-1)).toBe(170);
  await expect.poll(async () => (await coordinates(page, 'solid')).at(-1)).toBe(170);
  await convert.click(); await expect(target).not.toHaveClass(/text-box/u);
  await expect.poll(async () => (await coordinates(page, 'dashed')).at(-1)).toBe(101);
  await expect.poll(async () => (await coordinates(page, 'solid')).at(-1)).toBe(170);
  await expect(path(page, 'dashed').locator('..').locator('.connection-path')).toHaveClass(/title-connection/u);
  await expect(path(page, 'solid').locator('..').locator('.connection-path')).not.toHaveClass(/title-connection/u);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await coordinates(page, 'dashed')).at(-1)).toBe(170);
  await page.keyboard.press('Control+Shift+z');
  await expect.poll(async () => (await coordinates(page, 'dashed')).at(-1)).toBe(101);
});

for (const titleRoute of [false, true]) test(`${titleRoute ? 'dashed' : 'solid'} junction branches enter nodes and text boxes horizontally without a shaft-to-arrow corner`, async ({ page }) => {
  await openFixture(page, false, titleRoute);
  for (const id of ['c', 'd']) {
    const marker = page.locator('.connection-junction'); await marker.focus();
    const from = await marker.getByRole('button', { name: '从中转点拉出连接线', exact: true }).boundingBox();
    const target = await page.locator('.text-node-card').filter({ has: page.locator(`strong[title="演示${id}"]`) }).boundingBox();
    await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2); await page.mouse.down();
    await page.mouse.move(target!.x, target!.y + target!.height * (titleRoute && id === 'd' ? .25 : .5), { steps: 10 });
    if (titleRoute) await expect(page.locator('.connection-path.draft')).not.toHaveCSS('stroke-dasharray', 'none');
    else await expect(page.locator('.connection-path.draft')).toHaveCSS('stroke-dasharray', 'none');
    await page.mouse.up();
  }
  await expect(page.locator('.connection-arrow')).toHaveCount(2);
  await expect(page.locator('.connection-path.title-connection')).toHaveCount(titleRoute ? 3 : 0);
  const geometry = await page.locator('.connection-arrow').evaluateAll(arrows => arrows.map(arrow => {
    const values = (element: Element) => element.getAttribute('d')!.match(/-?\d+(?:\.\d+)?/gu)!.map(Number);
    return { arrow: values(arrow), shaft: values(arrow.parentElement!.querySelector('.connection-path')!) };
  }));
  for (const { arrow, shaft } of geometry) {
    expect(shaft[5]).toBe(shaft[7]); expect(arrow[0]).toBe(arrow[4]); expect(arrow[0]).toBe(shaft[6]);
    expect((arrow[1] + arrow[5]) / 2).toBe(shaft[7]);
  }
  await page.screenshot({ path: test.info().outputPath('horizontal-junction-branches.png') });
});

for (const upper of [true, false]) test(`junction-to-text-box uses target ${upper ? 'upper' : 'lower'} region and rejects the opposite component style`, async ({ page }) => {
  await openFixture(page, false, upper);
  const marker = page.locator('.connection-junction'); await marker.focus();
  const plus = await marker.getByRole('button', { name: '从中转点拉出连接线', exact: true }).boundingBox();
  const target = await page.locator('.text-node-card').filter({ has: page.locator('strong[title="演示d"]') }).boundingBox();
  await page.mouse.move(plus!.x + plus!.width / 2, plus!.y + plus!.height / 2); await page.mouse.down();
  const draft = page.locator('.connection-path.draft');
  for (const fraction of [.25, .75, upper ? .25 : .75]) {
    await page.mouse.move(target!.x + target!.width, target!.y + target!.height * fraction, { steps: 8 });
    if (fraction < .5) await expect(draft).toHaveClass(/title-connection/u); else await expect(draft).not.toHaveClass(/title-connection/u);
  }
  await page.mouse.up(); await expect(page.locator('.connection-hit-area')).toHaveCount(2);
  const edge = page.locator('.connection-hit-area:not([data-connection-id="incoming"])');
  const id = (await edge.getAttribute('data-connection-id'))!;
  expect((await coordinates(page, id)).slice(-2)).toEqual([780, 420]);
  const arrow = await page.locator(`[data-arrow-for="${id}"]`).boundingBox();
  await page.mouse.move(arrow!.x + arrow!.width / 3, arrow!.y + arrow!.height / 2); await page.mouse.down();
  await page.mouse.move(target!.x, target!.y + target!.height * (upper ? .75 : .25), { steps: 8 }); await page.mouse.up();
  await expect(page.getByText('虚线与实线不能共用同一个中转点，请分别添加中转点', { exact: true })).toBeVisible();
  await expect(page.locator('.connection-layer')).not.toHaveAttribute('data-reconnecting-id');
  const line = edge.locator('..').locator('.connection-path');
  if (upper) await expect(line).toHaveClass(/title-connection/u); else await expect(line).not.toHaveClass(/title-connection/u);
});

for (const id of ['solid', 'dashed']) test(`resizing ${id} labels repeatedly, cancelling and dragging nodes leaves interaction usable`, async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await openFixture(page, true, false, true);
  const label = page.locator(`.connection-label-foreign[data-connection-id="${id}"]`);
  const display = label.locator('.connection-label-display');
  const frame = page.locator(`[data-label-border-for="${id}"]`);
  const line = path(page, id).locator('..').locator('.connection-path');
  await expect(frame).toHaveCSS('fill', 'rgb(239, 239, 236)');
  const before = await label.boundingBox();
  for (const cancel of [false, true, false]) {
    const initial = await label.boundingBox();
    const handle = await label.getByRole('button', { name: '调整连接文字框大小' }).boundingBox();
    await page.mouse.move(handle!.x + 10, handle!.y + 10); await page.mouse.down();
    await page.mouse.move(handle!.x + 70, handle!.y + 30, { steps: 6 });
    if (cancel) await page.keyboard.press('Escape');
    await page.mouse.up();
    if (cancel) await expect.poll(async () => (await label.boundingBox())!.width).toBeCloseTo(initial!.width);
    else await expect.poll(async () => (await label.boundingBox())!.width).toBeGreaterThan(initial!.width + 50);
  }
  await expect.poll(async () => (await label.boundingBox())!.width).toBeGreaterThan(before!.width + 100);
  await display.hover();
  await expect(line).toHaveCSS('stroke', 'rgb(102, 102, 107)');
  await expect(frame).toHaveCSS('stroke', 'rgb(102, 102, 107)');
  expect(await frame.evaluate(e => getComputedStyle(e).strokeWidth)).toBe(await line.evaluate(e => getComputedStyle(e).strokeWidth));
  expect(await frame.evaluate(e => getComputedStyle(e).strokeDasharray)).toBe(await line.evaluate(e => getComputedStyle(e).strokeDasharray));
  if (id === 'dashed') await page.screenshot({ path: test.info().outputPath('dashed-label-final.png') });
  const node = page.locator('.text-node-card').filter({ has: page.locator('strong[title="演示a"]') });
  const header = await node.locator('header strong').boundingBox(), origin = await node.getAttribute('style');
  await drag(page, { x: header!.x + 30, y: header!.y + 10 }, { x: header!.x + 50, y: header!.y + 60 });
  await expect(node).not.toHaveAttribute('style', origin!);
  await expect(page.getByText(/Illegal interaction transition/u)).toHaveCount(0); expect(errors).toEqual([]);
});

test('dragging an arrow moves its existing shaft, arrow and label during preview, commits in place and cancels cleanly', async ({ page }) => {
  await openFixture(page, true, false, true);
  const arrow = page.locator('[data-arrow-for="solid"]'), edge = path(page, 'solid');
  const original = await edge.getAttribute('d');
  const label = page.locator('.connection-label-foreign[data-connection-id="solid"]');
  const labelBefore = await label.boundingBox();
  const start = await arrow.evaluate(e => { const b = e.getBoundingClientRect(); return { x: b.x + b.width / 3, y: b.y + b.height / 2 }; });
  const target = await page.locator('.text-node-card').filter({ has: page.locator('strong[title="演示d"]') }).boundingBox();
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(610, 350, { steps: 10 });
  await expect(edge).not.toHaveAttribute('d', original!);
  await expect(arrow).toHaveCount(1); await expect(page.locator('.connection-path.draft')).toHaveCount(0);
  await expect.poll(async () => (await label.boundingBox())!.y).not.toBe(labelBefore!.y);
  await page.mouse.move(target!.x, target!.y + target!.height / 2, { steps: 10 });
  await expect.poll(async () => (await coordinates(page, 'solid')).slice(-2)).toEqual([780, 420]);
  await page.screenshot({ path: test.info().outputPath('arrow-reconnect-preview.png') });
  await page.mouse.up();
  await expect(page.locator('.connection-layer')).not.toHaveAttribute('data-reconnecting-id');
  await expect.poll(async () => (await coordinates(page, 'solid')).slice(-2)).toEqual([780, 420]);
  await expect(page.locator('.connection-hit-area')).toHaveCount(3);
  await expect(page.locator('.connection-label-text').filter({ hasText: '标签solid' })).toHaveCount(1);
  await page.keyboard.press('Control+z');
  await expect(edge).toHaveAttribute('d', original!);
  const cancelStart = await arrow.evaluate(e => { const b = e.getBoundingClientRect(); return { x: b.x + b.width / 3, y: b.y + b.height / 2 }; });
  await page.mouse.move(cancelStart.x, cancelStart.y); await page.mouse.down();
  await page.mouse.move(610, 350, { steps: 10 }); await expect(edge).not.toHaveAttribute('d', original!);
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(edge).toHaveAttribute('d', original!); await expect(label).toHaveCount(1);
});

for (const sourceUpper of [false, true]) for (const targetUpper of [false, true]) test(`box-to-box uses only the target ${targetUpper ? 'upper' : 'lower'} half when starting in the ${sourceUpper ? 'upper' : 'lower'} half and keeps centred anchors`, async ({ page }) => {
  await openFixture(page);
  const source = await page.getByRole('button', { name: '从演示b右侧连接', exact: true }).boundingBox();
  const target = await page.locator('.text-node-card').filter({ has: page.locator('strong[title="演示d"]') }).boundingBox();
  await page.mouse.move(source!.x + source!.width / 2, source!.y + source!.height * (sourceUpper ? .25 : .75)); await page.mouse.down();
  const draft = page.locator('.connection-path.draft');
  for (const fraction of [.25, .5, .75, targetUpper ? .25 : .75]) {
    const upper = fraction < .5;
    await page.mouse.move(target!.x, target!.y + target!.height * fraction, { steps: 6 });
    if (upper) await expect(draft).toHaveClass(/title-connection/u); else await expect(draft).not.toHaveClass(/title-connection/u);
    const points = (await draft.getAttribute('d'))!.match(/-?\d+(?:\.\d+)?/gu)!.map(Number);
    expect(points.slice(0, 2)).toEqual([360, 420]); expect(points[7]).toBe(420);
  }
  await page.mouse.up(); await expect(page.locator('.connection-hit-area')).toHaveCount(2);
  const edge = page.locator('.connection-hit-area:not([data-connection-id="incoming"])');
  expect((await coordinates(page, (await edge.getAttribute('data-connection-id'))!)).slice(-2)).toEqual([780, 420]);
  const rendered = edge.locator('..').locator('.connection-path');
  if (targetUpper) await expect(rendered).toHaveClass(/title-connection/u); else await expect(rendered).not.toHaveClass(/title-connection/u);
});

test('box-to-box arrow reconnection switches upper and lower target regions live without moving the centre anchor', async ({ page }) => {
  await openFixture(page);
  const source = await page.getByRole('button', { name: '从演示b右侧连接', exact: true }).boundingBox();
  const target = await page.locator('.text-node-card').filter({ has: page.locator('strong[title="演示d"]') }).boundingBox();
  await drag(page, { x: source!.x + source!.width / 2, y: source!.y + source!.height / 2 }, { x: target!.x, y: target!.y + 20 });
  const edge = page.locator('.connection-hit-area:not([data-connection-id="incoming"])');
  const id = (await edge.getAttribute('data-connection-id'))!;
  const rendered = () => edge.locator('..').locator('.connection-path');
  for (const upper of [false, true]) {
    const arrow = await page.locator(`[data-arrow-for="${id}"]`).boundingBox();
    await page.mouse.move(arrow!.x + arrow!.width / 3, arrow!.y + arrow!.height / 2); await page.mouse.down();
    await page.mouse.move(target!.x, target!.y + target!.height * (upper ? .25 : .75), { steps: 8 });
    if (upper) await expect(rendered()).toHaveClass(/title-connection/u); else await expect(rendered()).not.toHaveClass(/title-connection/u);
    expect((await coordinates(page, id)).slice(-2)).toEqual([780, 420]);
    await page.mouse.up(); await expect(page.locator('.connection-layer')).not.toHaveAttribute('data-reconnecting-id');
    if (upper) await expect(rendered()).toHaveClass(/title-connection/u); else await expect(rendered()).not.toHaveClass(/title-connection/u);
  }
  await expect(page.locator('.connection-hit-area')).toHaveCount(2);
});
