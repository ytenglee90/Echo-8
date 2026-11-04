import { expect, test, type Page } from '@playwright/test';
import { serializeProject } from '../src/plugins/import-export/codec.ts';
import { createContentStorage } from '../src/plugins/text-node/content-storage.ts';
import type { ProjectSource } from '../src/protocols/files.ts';

test.use({ viewport: { width: 600, height: 960 } });
async function openSteepFan(page: Page) {
  await page.addInitScript(() => Object.defineProperty(window, 'showOpenFilePicker', { configurable: true, value: undefined }));
  await page.goto('/'); await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
  const namespaces: ProjectSource['document']['namespaces'] = { textNode: {}, textContent: {}, textContentChunk: {}, connections: {}, connectionJunction: {} };
  for (let i = 0; i < 4; i++) {
    const id = `n${i}`, body = createContentStorage(`body${i}`, '双击打开正文编辑器', 1);
    namespaces.textContent[`body${i}`] = body.content;
    for (const patch of body.chunkPatches) if (patch.op === 'set') namespaces.textContentChunk[patch.key] = patch.value;
    namespaces.textNode[id] = { id, contentId: `body${i}`, title: `节点 ${i + 1}`, x: 208, y: [20, 222, 408, 594][i], width: 260, height: 146, titleColor: '#242527', revision: 1, createdAt: 1, updatedAt: 1 };
  }
  namespaces.connectionJunction.j = { id: 'j', x: 64, y: 576, revision: 1, branchSide: 'outgoing' };
  for (let i = 0; i < 3; i++) namespaces.connections[`branch${i}`] = { id: `branch${i}`, from: { nodeId: 'j', kind: 'junction', side: 'right' }, to: { nodeId: `n${i}`, side: 'title' }, titleRoute: true, revision: 1, createdAt: 1 };
  namespaces.connections.trunk = { id: 'trunk', from: { nodeId: 'n3', side: 'title' }, to: { nodeId: 'j', kind: 'junction', side: 'left' }, titleRoute: true, revision: 1, createdAt: 1 };
  const blob = await serializeProject({ document: { revision: 1, namespaces }, plugins: [
    { id: 'text-node', version: '0.1.0', dataVersion: 2, namespaces: ['textNode', 'textContent', 'textContentChunk'], available: true },
    { id: 'connections', version: '0.1.0', dataVersion: 11, namespaces: ['connections', 'connectionJunction'], available: true },
  ] });
  await page.getByRole('button', { name: '命令面板', exact: true }).click();
  const palette = page.getByRole('dialog', { name: '命令面板' }); await palette.getByRole('textbox', { name: '搜索命令' }).fill('打开书籍');
  await palette.getByRole('option', { name: /^打开书籍/u }).click();
  const notice = page.getByRole('status').filter({ hasText: '当前书籍还有未保存修改' }), chooser = page.waitForEvent('filechooser');
  await notice.getByRole('button', { name: '不保存，继续选择书籍' }).click();
  await (await chooser).setFiles({ name: '陡峭中转分支.echo8', mimeType: blob.type, buffer: Buffer.from(await blob.arrayBuffer()) });
  await expect(notice).toHaveCount(0); await expect(page.locator('.connection-hit-area')).toHaveCount(4);
}
async function path(page: Page, id: string) { return (await page.locator(`.connection-hit-area[data-connection-id="${id}"]`).getAttribute('d'))!.match(/-?\d+(?:\.\d+)?/gu)!.map(Number); }
async function expectSmoothJoint(page: Page) {
  for (let i = 0; i < 3; i++) {
    const p = await path(page, `branch${i}`);
    expect(p[2]).toBeCloseTo(p[0], 2); expect(p[3]).toBeLessThan(p[1]);
    expect(p[4]).toBeCloseTo(p[0], 2);
  }
  const trunk = await path(page, 'trunk');
  expect(trunk.at(-4)).toBeCloseTo(trunk.at(-2)!, 2); expect(trunk.at(-3)).toBeGreaterThan(trunk.at(-1)!);
  expect(trunk.at(-6)).toBeCloseTo(trunk.at(-2)!, 2);
  await expect(page.locator('.connection-arrow')).toHaveCount(3);
}
test('the reported short-wide, tall fan-out has a continuous trunk and zero-curvature junction transitions on both sides', async ({ page }, info) => {
  await openSteepFan(page);
  await page.screenshot({ path: info.outputPath('steep-fan-left.png') });
  await expectSmoothJoint(page);
  const dot = page.locator('.connection-junction-dot'), box = await dot.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2); await page.mouse.down();
  await page.mouse.move(box!.x + box!.width / 2 + 476, box!.y + box!.height / 2 - 2, { steps: 12 });
  await expectSmoothJoint(page);
  const preview = await page.locator('.connection-hit-area').evaluateAll(elements => elements.map(element => element.getAttribute('d')));
  await page.mouse.up();
  await expect(page.locator('.connection-junction')).toHaveAttribute('transform', 'translate(540 574)');
  await expectSmoothJoint(page);
  await expect.poll(() => page.locator('.connection-hit-area').evaluateAll(elements => elements.map(element => element.getAttribute('d')))).toEqual(preview);
  await page.mouse.move(10, 950); await page.screenshot({ path: info.outputPath('steep-fan-right.png') });
  await page.keyboard.press('Control+z'); await expect(page.locator('.connection-junction')).toHaveAttribute('transform', 'translate(64 576)');
});
