import { expect, test, type Page } from '@playwright/test';
import { serializeProject } from '../src/plugins/import-export/codec.ts';
import { createContentStorage } from '../src/plugins/text-node/content-storage.ts';
import type { ProjectSource } from '../src/protocols/files.ts';

test.use({ viewport: { width: 1320, height: 1100 } });
async function openFan(page: Page, pair = false) {
  await page.addInitScript(() => Object.defineProperty(window, 'showOpenFilePicker', { configurable: true, value: undefined }));
  await page.goto('/'); await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
  const namespaces: ProjectSource['document']['namespaces'] = { textNode: {}, textContent: {}, textContentChunk: {}, connections: {}, connectionJunction: {} };
  for (const [id, x, y] of [['s', 80, 600], ['n0', 880, 20], ['n1', 880, 240], ['n2', 880, 460], ['n3', 880, 680]] as const) {
    const content = createContentStorage(`body-${id}`, `正文${id}`, 1);
    namespaces.textContent[`body-${id}`] = content.content;
    for (const patch of content.chunkPatches) if (patch.op === 'set') namespaces.textContentChunk[patch.key] = patch.value;
    namespaces.textNode[id] = { id, contentId: `body-${id}`, title: `水平测试${id}`, x, y, width: 260, height: 160,
      titleColor: '#374151', revision: 1, createdAt: 1, updatedAt: 1 };
  }
  namespaces.connectionJunction.j = { id: 'j', x: 560, y: 820, revision: 1, branchSide: 'outgoing' };
  const edge = (id: string, from: unknown, to: unknown) => ({ id, from, to, revision: 1, createdAt: 1 });
  // Legacy records deliberately have reversed point side fields; projection must normalize without rewriting them.
  namespaces.connections.incoming = edge('incoming', { nodeId: 's', side: 'title' }, { nodeId: 'j', kind: 'junction', side: 'right' });
  for (const id of ['n0', 'n1', 'n2', 'n3']) namespaces.connections[id] = edge(id, { nodeId: 'j', kind: 'junction', side: 'left' }, { nodeId: id, side: 'title' });
  if (pair) namespaces.connections.pair = edge('pair', { nodeId: 's', side: 'title' }, { nodeId: 'n1', side: 'title' });
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
  await expect(notice).toHaveCount(0); await expect(page.getByRole('region', { name: 'Echo-8 书库' })).toBeHidden();
  await expect(page.locator('.connection-hit-area')).toHaveCount(pair ? 6 : 5);
}

const edgePath = (page: Page, id: string) => page.locator(`.connection-hit-area[data-connection-id="${id}"]`);
const read = async (page: Page, id: string) => (await edgePath(page, id).getAttribute('d'))!.match(/-?\d+(?:\.\d+)?/gu)!.map(Number);
async function checkFan(page: Page, y: number) {
  const incoming = await read(page, 'incoming');
  expect(incoming[6]).toBe(560); expect(incoming[7]).toBe(y);
  expect(incoming[4]).toBeLessThan(560); expect(incoming[5]).toBe(y);
  for (const id of ['n0', 'n1', 'n2', 'n3']) {
    const p = await read(page, id);
    expect(p.slice(0, 2)).toEqual([560, y]); expect(p[3]).toBe(y); expect(p[2]).toBeGreaterThan(560);
    expect(p[2]).toBeLessThanOrEqual(p[4]); expect(p[4]).toBeLessThan(p[6]); expect(p[5]).toBe(p[7]);
  }
  await expect(page.locator('[data-arrow-for="incoming"]')).toHaveCount(0);
}

test('bottom and middle fan-outs use horizontal ports throughout point dragging and undo', async ({ page }) => {
  await openFan(page); await checkFan(page, 820);
  await page.screenshot({ path: test.info().outputPath('fan-bottom.png') });
  const point = page.locator('.connection-junction'); const box = await point.locator('.connection-junction-dot').boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2); await page.mouse.down();
  await expect(point).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2 - 390, { steps: 12 });
  await expect.poll(async () => (await read(page, 'n0'))[1]).toBe(430); await checkFan(page, 430);
  await page.screenshot({ path: test.info().outputPath('fan-middle.png') });
  await page.mouse.up(); await checkFan(page, 430);
  await page.keyboard.press('Control+z'); await expect.poll(async () => (await read(page, 'n0'))[1]).toBe(820);
  await checkFan(page, 820);
});

test('outgoing drafts always leave right, including a pointer left of the point; incoming drafts always enter left', async ({ page }) => {
  await openFan(page);
  const point = page.locator('.connection-junction'); await point.focus();
  const port = await point.getByRole('button', { name: '从中转点拉出连接线', exact: true }).boundingBox();
  await page.mouse.move(port!.x + port!.width / 2, port!.y + port!.height / 2); await page.mouse.down();
  await page.mouse.move(430, 400, { steps: 10 });
  const draft = page.locator('.connection-path.draft');
  const p = (await draft.getAttribute('d'))!.match(/-?\d+(?:\.\d+)?/gu)!.map(Number);
  expect(p[2]).toBeGreaterThan(p[0]); expect(p[3]).toBe(p[1]);
  await page.keyboard.press('Escape'); await page.mouse.up(); await expect(draft).toHaveCount(0);
  const nodePort = await page.getByRole('button', { name: '从水平测试n3标题栏左侧连接', exact: true }).boundingBox();
  const dot = await point.locator('.connection-junction-dot').boundingBox();
  await page.mouse.move(nodePort!.x + nodePort!.width / 2, nodePort!.y + nodePort!.height / 2); await page.mouse.down();
  await page.mouse.move(dot!.x + dot!.width / 2, dot!.y + dot!.height / 2, { steps: 10 });
  const input = (await draft.getAttribute('d'))!.match(/-?\d+(?:\.\d+)?/gu)!.map(Number);
  expect(input[6]).toBe(560); expect(input[4]).toBeLessThan(560); expect(input[5]).toBe(input[7]);
  await expect(page.locator('.connection-arrow.draft')).toHaveCount(0);
  await page.mouse.up(); await expect(page.locator('.connection-hit-area')).toHaveCount(6);
});

test('title pairs use left-left when the source is left, and right-right after relative positions reverse', async ({ page }) => {
  await openFan(page, true);
  const pair = () => read(page, 'pair');
  expect((await pair())[0]).toBe(80); expect((await pair())[6]).toBe(880);
  expect((await pair())[2]).toBeLessThan(80); expect((await pair())[4]).toBeLessThan(880);
  await page.screenshot({ path: test.info().outputPath('title-left-left.png') });
  const node = page.locator('.text-node-card').filter({ has: page.locator('strong[title="水平测试n1"]') });
  const header = await node.locator('header strong').boundingBox();
  await page.mouse.move(header!.x + 20, header!.y + 10); await page.mouse.down();
  await page.mouse.move(header!.x + 20 - 860, header!.y + 10, { steps: 12 });
  await expect.poll(async () => (await pair())[0]).toBe(340);
  expect((await pair())[6]).toBe(280); expect((await pair())[2]).toBeGreaterThan(340); expect((await pair())[4]).toBeGreaterThan(280);
  await page.mouse.up(); await page.keyboard.press('Control+z');
  await expect.poll(async () => (await pair())[0]).toBe(80); expect((await pair())[6]).toBe(880);
});

test('a solid input cannot be attached to a dashed junction and rejection leaves the original graph intact', async ({ page }) => {
  await openFan(page);
  const source = await page.getByRole('button', { name: '从水平测试n3左侧连接', exact: true }).boundingBox();
  const dot = await page.locator('.connection-junction-dot').boundingBox();
  await page.mouse.move(source!.x + source!.width / 2, source!.y + source!.height / 2); await page.mouse.down();
  await page.mouse.move(dot!.x + dot!.width / 2, dot!.y + dot!.height / 2, { steps: 10 }); await page.mouse.up();
  await expect(page.getByText('虚线与实线不能共用同一个中转点，请分别添加中转点', { exact: true })).toBeVisible();
  await expect(page.locator('.connection-hit-area')).toHaveCount(5); await expect(page.locator('.connection-junction')).toHaveCount(1);
});
