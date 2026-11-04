import { expect, test, type Page } from '@playwright/test';
import { serializeProject } from '../src/plugins/import-export/codec.ts';
import { createContentStorage } from '../src/plugins/text-node/content-storage.ts';
import type { ProjectSource } from '../src/protocols/files.ts';

async function openGraph(page: Page, outputs = false, title = false, rightHandLayout = false, three = false) {
  await page.addInitScript(() => Object.defineProperty(window, 'showOpenFilePicker', { configurable: true, value: undefined }));
  await page.goto('/');
  await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
  const namespaces: ProjectSource['document']['namespaces'] = { textNode: {}, textContent: {}, textContentChunk: {}, connections: {}, connectionJunction: {} };
  for (const [id, x, y] of (three ? [['a', 440, 20], ['b', 440, 220], ['d', 440, 420], ['c', 440, 700], ['e', 900, 20]] as const : [['a', 80, 80], ['b', 80, 340], ['c', 800, 210]] as const)) {
    const content = createContentStorage(`body-${id}`, `正文${id}`, 1);
    namespaces.textContent[`body-${id}`] = content.content;
    for (const patch of content.chunkPatches) if (patch.op === 'set') namespaces.textContentChunk[patch.key] = patch.value;
    namespaces.textNode[id] = { id, contentId: `body-${id}`, title: `节点${id}`, x: rightHandLayout && id !== 'c' ? x + 360 : x, y, width: 280, height: 158, titleColor: '#303030', revision: 1, createdAt: 1, updatedAt: 1 };
  }
  for (const [id, from, to] of (three ? [['edge-a', 'a', 'c'], ['edge-b', 'b', 'c'], ['edge-d', 'd', 'c']] : outputs ? [['edge-a', 'a', 'b'], ['edge-b', 'a', 'c']] : [['edge-a', 'a', 'c'], ['edge-b', 'b', 'c']])) {
    namespaces.connections[id] = { id, from: { nodeId: from, side: title ? 'title' : 'right' }, to: { nodeId: to, side: title ? 'title' : 'left' }, ...(three && title ? { titleOrigin: { side: 'right', sourceIsLeft: true } } : {}), label: id, labelWidth: 100, labelHeight: 40, revision: 1, createdAt: 1 };
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
  await expect(page.locator('.connection-hit-area')).toHaveCount(three ? 3 : 2);
  await expect(page.getByRole('region', { name: 'Echo-8 书库' })).toBeHidden();
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

for (const title of [false, true]) test(`three selected ${title ? 'title' : 'body'} links route by junction side and body arrows appear only at physical inputs`, async ({ page }) => {
  await page.setViewportSize({ width: 1320, height: 1100 });
  await openGraph(page, false, title, false, true);
  const first = page.locator('.connection-hit-area[data-connection-id="edge-a"]');
  await first.focus(); await first.press('Enter');
  await addVisibleConnection(page, 'edge-b'); await addVisibleConnection(page, 'edge-d');
  await expect(page.locator('.connection-hit-area[aria-pressed="true"]')).toHaveCount(3);
  await rightClickAt(page, 150, 600);
  const marker = page.locator('.connection-junction');
  await expect(marker).toHaveCount(1); await expect(page.locator('.connection-hit-area')).toHaveCount(4);
  const read = async (id: string) => (await page.locator(`.connection-hit-area[data-connection-id="${id}"]`).getAttribute('d'))!.match(/-?\d+(?:\.\d+)?/gu)!.map(Number);
  for (const id of ['edge-a', 'edge-b', 'edge-d']) {
    const p = await read(id); expect(p[0]).toBe(440); expect(p[2]).toBeLessThan(440); expect(p[6]).toBe(150); expect(p[4]).toBeGreaterThan(150);
    if (!title) await expect(page.locator(`[data-arrow-for="${id}"]`)).toHaveAttribute('data-arrow-end', 'from');
  }
  await expect(page.locator('.connection-arrow:not(.draft)')).toHaveCount(title ? 1 : 4);
  await page.screenshot({ path: test.info().outputPath(`${title ? 'title' : 'body'}-junction-left.png`) });
  const dot = await marker.locator('.connection-junction-dot').boundingBox();
  await page.mouse.move(dot!.x + dot!.width / 2, dot!.y + dot!.height / 2); await page.mouse.down();
  await expect(marker).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.move(dot!.x + dot!.width / 2 + 850, dot!.y + dot!.height / 2, { steps: 12 });
  await expect.poll(async () => (await read('edge-a'))[6]).toBe(1000);
  for (const id of ['edge-a', 'edge-b', 'edge-d']) {
    const p = await read(id); expect(p[0]).toBe(720); expect(p[2]).toBeGreaterThan(720); expect(p[4]).toBeLessThan(1000);
  }
  await expect(page.locator('.connection-arrow:not(.draft)')).toHaveCount(title ? 1 : 0);
  await page.mouse.up(); await page.screenshot({ path: test.info().outputPath(`${title ? 'title' : 'body'}-junction-right.png`) });
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await read('edge-a'))[6]).toBe(150);
  await expect(page.locator('.connection-arrow:not(.draft)')).toHaveCount(title ? 1 : 4);
  if (!title) {
    const arrow = page.locator('[data-arrow-for="edge-a"]');
    const original = await first.getAttribute('d');
    const start = await arrow.evaluate(e => { const b = e.getBoundingClientRect(); return { x: b.x + b.width * .7, y: b.y + b.height / 2 }; });
    const target = await pointOnScreen(page, 900, 99);
    await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(target.x, target.y, { steps: 12 });
    await expect(first).not.toHaveAttribute('d', original!);
    await expect.poll(async () => (await arrow.getAttribute('d'))!.match(/-?\d+(?:\.\d+)?/gu)!.map(Number).slice(2, 4)).toEqual([900, 99]);
    await page.mouse.up(); await expect(page.locator('.connection-layer')).not.toHaveAttribute('data-reconnecting-id');
    await expect.poll(async () => (await read('edge-a')).slice(0, 2)).toEqual([900, 99]);
    await expect(arrow).toHaveAttribute('data-arrow-end', 'from'); await expect(page.locator('.connection-hit-area')).toHaveCount(4);
    await page.keyboard.press('Control+z'); await expect(first).toHaveAttribute('d', original!);
  }
});

async function addVisibleConnection(page: Page, id: string) {
  const hit = page.locator(`.connection-hit-area[data-connection-id="${id}"]`);
  const point = await hit.evaluate(element => {
    const path = element as SVGPathElement, length = path.getTotalLength(), matrix = path.getScreenCTM()!;
    for (let step = 5; step < 96; step += 3) {
      const point = path.getPointAtLength(length * step / 100);
      const screen = new DOMPoint(point.x, point.y).matrixTransform(matrix);
      if (document.elementFromPoint(screen.x, screen.y) === path) return { x: screen.x, y: screen.y };
    }
    throw new Error('No exposed connection segment');
  });
  await page.keyboard.down('Shift'); await page.mouse.click(point.x, point.y); await page.keyboard.up('Shift');
  await expect(hit).toHaveAttribute('aria-pressed', 'true');
}

async function expectLabelAtSegmentMiddle(page: Page, id: string) {
  const geometry = await page.locator(`.connection-hit-area[data-connection-id="${id}"]`).evaluate((path, edgeId) => {
    const curve = path as SVGPathElement;
    const middle = curve.getPointAtLength(curve.getTotalLength() / 2);
    const box = document.querySelector<SVGForeignObjectElement>(`.connection-label-foreign[data-connection-id="${edgeId}"]`)!;
    return { actualX: box.x.baseVal.value + box.width.baseVal.value / 2, actualY: box.y.baseVal.value + box.height.baseVal.value / 2,
      expectedX: middle.x, expectedY: middle.y };
  }, id);
  expect(Math.abs(geometry.actualX - geometry.expectedX)).toBeLessThan(1);
  expect(Math.abs(geometry.actualY - geometry.expectedY)).toBeLessThan(1);
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
  await addVisibleConnection(page, 'edge-b');
  await page.locator('.connection-hit-area').first().focus();
  await expect(page.locator('.connection-hit-area').first()).toHaveCSS('outline-style', 'none');
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
  await expect(page.locator('.connection-junction')).toHaveAttribute('transform', 'translate(540 520)');
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
  await addVisibleConnection(page, 'edge-b');
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

test('title dashes keep actual gaps and solid arrows, routed junctions face each counterpart horizontally and follow overview visibility', async ({ page }) => {
  await openGraph(page, false, true, true);
  const first = page.locator('.connection-hit-area[data-connection-id="edge-a"]');
  await first.focus(); await first.press('Enter');
  await addVisibleConnection(page, 'edge-b');
  await expect(page.locator('.connection-hit-area[aria-pressed="true"]')).toHaveCount(2);
  await rightClickAt(page, 260, 180);
  await expect(page.locator('.connection-junction')).toHaveCount(1);
  await expect(page.locator('.connection-arrow')).toHaveCount(1);
  const shaft = page.locator('.connection-hit-area[data-connection-id="edge-a"] + .connection-path');
  await expect(shaft).toHaveCSS('fill', 'none');
  await expect(shaft).toHaveAttribute('d', /^M[^Z]+C[^Z]+$/u);
  const pixels = await shaft.evaluate(async element => {
    const path = element as SVGPathElement, box = path.getBBox(), style = getComputedStyle(path);
    const padding = 8, width = Math.ceil(box.width + padding * 2), height = Math.ceil(box.height + padding * 2);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${box.x - padding} ${box.y - padding} ${width} ${height}"><path d="${path.getAttribute('d')}" fill="${style.fill}" stroke="black" stroke-width="${style.strokeWidth}" stroke-dasharray="${style.strokeDasharray}" stroke-linecap="${style.strokeLinecap}"/></svg>`;
    const image = new Image(); image.src = `data:image/svg+xml,${encodeURIComponent(svg)}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    let gaps = 0, ink = 0;
    for (let distance = 10; distance < path.getTotalLength() - 10; distance += 1) {
      const point = path.getPointAtLength(distance);
      const alpha = context.getImageData(Math.round(point.x - box.x + padding), Math.round(point.y - box.y + padding), 1, 1).data[3];
      if (alpha < 15) gaps += 1; else if (alpha > 100) ink += 1;
    }
    return { gaps, ink };
  });
  expect(pixels.gaps).toBeGreaterThan(10); expect(pixels.ink).toBeGreaterThan(20);
  await expect(page.locator('.connection-arrow')).toHaveCSS('stroke', 'none');
  await expect(page.locator('.connection-arrow')).toHaveCSS('stroke-dasharray', 'none');
  const joins = await page.locator('.connection-hit-area').evaluateAll(paths => paths.map(element => {
    const path = element as SVGPathElement, numbers = path.getAttribute('d')!.match(/-?\d+(?:\.\d+)?/gu)!.map(Number);
    return { from: { x: numbers[0], y: numbers[1] }, controlFrom: { x: numbers[2], y: numbers[3] }, controlTo: { x: numbers[4], y: numbers[5] }, to: { x: numbers[6], y: numbers[7] } };
  }));
  const trunk = joins.find(curve => Math.abs(curve.from.x - 260) < 1)!;
  const screenshotPath = test.info().outputPath('title-routing.png');
  await page.screenshot({ path: screenshotPath });
  await test.info().attach('title-junction-routing', { path: screenshotPath, contentType: 'image/png' });
  expect(trunk.controlFrom.x).toBeGreaterThan(260);
  for (const branch of joins.filter(curve => Math.abs(curve.to.x - 260) < 1)) {
    const a = { x: branch.to.x - branch.controlTo.x, y: branch.to.y - branch.controlTo.y };
    const b = { x: trunk.controlFrom.x - trunk.from.x, y: trunk.controlFrom.y - trunk.from.y };
    expect(Math.abs(a.x * b.y - a.y * b.x) / Math.hypot(a.x, a.y) / Math.hypot(b.x, b.y)).toBeLessThan(.001);
    expect(a.x).toBeLessThan(0); expect(branch.controlTo.x).toBeLessThanOrEqual(branch.from.x);
  }
  await page.locator('.canvas-surface').click({ position: { x: 10, y: 650 } });
  await page.mouse.move(1, 1);
  const zoom = page.locator('.canvas-zoom-status input');
  await zoom.fill('40'); await zoom.press('Enter');
  await expect(page.locator('.connection-path:not(.draft)')).toHaveCount(0);
  await expect(page.locator('.connection-junction')).toHaveCount(0);
  await zoom.fill('100'); await zoom.press('Enter');
  await expect(page.locator('.connection-junction')).toHaveCount(1);
});

test('a node can connect into a junction and its separate port can pull out a new connection without moving the point', async ({ page }) => {
  await openGraph(page);
  await label(page, 'edge-a').click();
  await rightClickAt(page, 540, 520);
  const marker = page.locator('.connection-junction');
  const original = await marker.getAttribute('transform');
  const point = await pointOnScreen(page, 540, 520);
  const inputPort = page.getByRole('button', { name: '从节点b右侧连接', exact: true });
  const portBox = await inputPort.boundingBox();
  await page.mouse.move(portBox!.x + portBox!.width / 2, portBox!.y + portBox!.height / 2);
  await page.mouse.down(); await page.mouse.move(point.x, point.y, { steps: 8 }); await page.mouse.up();
  await expect(page.locator('.connection-hit-area')).toHaveCount(4);
  await expect(marker).toHaveAttribute('transform', original!);
  await marker.locator('.connection-junction-dot').click();
  await expect(marker).toHaveCSS('outline-style', 'none');
  const outputPort = marker.getByRole('button', { name: '从中转点拉出连接线' });
  const outBox = await outputPort.boundingBox();
  const destination = await pointOnScreen(page, 220, 410);
  await page.mouse.move(outBox!.x + outBox!.width / 2, outBox!.y + outBox!.height / 2);
  await page.mouse.down(); await page.mouse.move(destination.x, destination.y, { steps: 8 });
  await expect(page.locator('.connection-path.draft')).toHaveCount(1);
  await page.mouse.up();
  await expect(page.locator('.connection-hit-area')).toHaveCount(5);
  await expect(marker).toHaveAttribute('transform', original!);
  await page.keyboard.press('Control+z');
  await expect(page.locator('.connection-hit-area')).toHaveCount(4);
  await page.keyboard.press('Control+y');
  await expect(page.locator('.connection-hit-area')).toHaveCount(5);
});
