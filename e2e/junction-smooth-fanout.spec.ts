import { expect, test, type Page } from '@playwright/test';
import { serializeProject } from '../src/plugins/import-export/codec.ts';
import { createContentStorage } from '../src/plugins/text-node/content-storage.ts';
import type { ProjectSource } from '../src/protocols/files.ts';

test.use({ viewport: { width: 600, height: 960 } });
interface FanLayout { positions: readonly (readonly [number, number])[]; junction: readonly [number, number]; pairs: readonly (readonly [string, string])[]; title: boolean; boxes?: readonly number[]; groups?: readonly number[] }
const steepFan: FanLayout = { positions: [[208, 20], [208, 222], [208, 408], [208, 594]], junction: [64, 576],
  pairs: [['n3', 'j'], ['j', 'n0'], ['j', 'n1'], ['j', 'n2']], title: true };
async function openSteepFan(page: Page, layout = steepFan) {
  await page.addInitScript(() => Object.defineProperty(window, 'showOpenFilePicker', { configurable: true, value: undefined }));
  await page.goto('/'); await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
  const namespaces: ProjectSource['document']['namespaces'] = { textNode: {}, textContent: {}, textContentChunk: {}, groups: {}, connections: {}, connectionJunction: {} };
  for (let i = 0; i < layout.positions.length; i++) {
    const id = `n${i}`, body = createContentStorage(`body${i}`, '双击打开正文编辑器', 1);
    namespaces.textContent[`body${i}`] = body.content;
    for (const patch of body.chunkPatches) if (patch.op === 'set') namespaces.textContentChunk[patch.key] = patch.value;
    namespaces.textNode[id] = { id, contentId: `body${i}`, title: `节点 ${i + 1}`, x: layout.positions[i][0], y: layout.positions[i][1], width: 260, height: 146, ...(layout.boxes?.includes(i) ? { presentation: 'text-box' } : {}), titleColor: '#242527', revision: 1, createdAt: 1, updatedAt: 1 };
  }
  for (const i of layout.groups ?? []) {
    const id = `mate${i}`, body = createContentStorage(`body-${id}`, '', 1);
    namespaces.textContent[`body-${id}`] = body.content;
    namespaces.textNode[id] = { id, contentId: `body-${id}`, title: id, x: layout.positions[i][0] + 20, y: layout.positions[i][1] + 100, width: 200, height: 80, titleColor: '#242527', revision: 1, createdAt: 1, updatedAt: 1 };
    namespaces.groups[`g${i}`] = { id: `g${i}`, memberIds: [`n${i}`, id], title: `群组 ${i}`, titleStyle: { fontSize: 13, fontWeight: 650 }, revision: 1, createdAt: 1, updatedAt: 1 };
  }
  namespaces.connectionJunction.j = { id: 'j', x: layout.junction[0], y: layout.junction[1], revision: 1, branchSide: 'outgoing' };
  const endpoint = (id: string, from: boolean) => ({ nodeId: id, ...(id === 'j' ? { kind: 'junction', side: from ? 'right' : 'left' } : { side: layout.title ? 'title' : from ? 'right' : 'left' }) });
  for (let i = 0; i < layout.pairs.length; i++) {
    const [from, to] = layout.pairs[i], id = i === 0 ? 'trunk' : `branch${i - 1}`;
    namespaces.connections[id] = { id, from: endpoint(from, true), to: endpoint(to, false), titleRoute: layout.title, revision: 1, createdAt: 1 };
  }
  const blob = await serializeProject({ document: { revision: 1, namespaces }, plugins: [
    { id: 'text-node', version: '0.1.0', dataVersion: 2, namespaces: ['textNode', 'textContent', 'textContentChunk'], available: true },
    { id: 'connections', version: '0.1.0', dataVersion: 11, namespaces: ['connections', 'connectionJunction'], available: true },
    { id: 'groups', version: '0.1.0', dataVersion: 2, namespaces: ['groups'], available: true },
  ] });
  await page.getByRole('button', { name: '命令面板', exact: true }).click();
  const palette = page.getByRole('dialog', { name: '命令面板' }); await palette.getByRole('textbox', { name: '搜索命令' }).fill('打开书籍');
  await palette.getByRole('option', { name: /^打开书籍/u }).click();
  const notice = page.getByRole('status').filter({ hasText: '当前书籍还有未保存修改' }), chooser = page.waitForEvent('filechooser');
  await notice.getByRole('button', { name: '不保存，继续选择书籍' }).click();
  await (await chooser).setFiles({ name: '陡峭中转分支.echo8', mimeType: blob.type, buffer: Buffer.from(await blob.arrayBuffer()) });
  await expect(notice).toHaveCount(0); await expect(page.locator('.connection-hit-area')).toHaveCount(layout.pairs.length);
}
async function path(page: Page, id: string) { return (await page.locator(`.connection-hit-area[data-connection-id="${id}"]`).getAttribute('d'))!.match(/-?\d+(?:\.\d+)?/gu)!.map(Number); }
async function expectSmoothJoint(page: Page) {
  for (let i = 0; i < 3; i++) {
    const p = await path(page, `branch${i}`);
    expect(p[2]).toBeCloseTo(p[0], 2); expect(p[3]).toBeLessThan(p[1]);
    expect(p.at(-3)).toBe(p.at(-1));
  }
  const trunk = await path(page, 'trunk');
  expect(trunk.at(-4)).toBeCloseTo(trunk.at(-2)!, 2); expect(trunk.at(-3)).toBeGreaterThan(trunk.at(-1)!);
  expect(trunk[1]).toBe(trunk[3]);
  await expect(page.locator('.connection-arrow')).toHaveCount(3);
}
test('the reported short-wide, tall fan-out has a continuous trunk and shared junction tangents on both sides', async ({ page }, info) => {
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

test('point drags switch left/right live and attach to nodes, text boxes and groups without a release jump', async ({ page }, info) => {
  await page.setViewportSize({ width: 1434, height: 1100 });
  await openSteepFan(page, { positions: [[80, 100], [900, 100], [80, 340], [900, 340], [80, 580], [900, 580], [80, 850], [900, 20], [900, 850]],
    junction: [600, 480], pairs: [['n6', 'j'], ['j', 'n7'], ['j', 'n8']], title: false, boxes: [2, 3], groups: [4, 5] });
  const marker = page.locator('.connection-junction'), draft = page.locator('.connection-path.draft');
  const outwardX = async () => {
    const p = (await draft.getAttribute('d'))!.match(/-?\d+(?:\.\d+)?/gu)!.map(Number);
    return p[0] === 600 && p[1] === 480 ? p[2] - p[0] : p.at(-4)! - p.at(-2)!;
  };
  for (let i = 0; i < 6; i++) {
    await marker.focus();
    const plus = await marker.getByRole('button', { name: '从中转点拉出连接线', exact: true }).boundingBox(), dot = await marker.locator('.connection-junction-dot').boundingBox();
    await page.mouse.move(plus!.x + plus!.width / 2, plus!.y + plus!.height / 2); await page.mouse.down();
    for (const side of [-1, 1, i % 2 === 0 ? -1 : 1]) {
      await page.mouse.move(dot!.x + dot!.width / 2 + side * 90, dot!.y + dot!.height / 2 + 35, { steps: 5 });
      if (side < 0) await expect.poll(outwardX).toBeLessThan(0); else await expect.poll(outwardX).toBeGreaterThan(0);
    }
    const target = i < 4 ? page.locator('.text-node-card').filter({ has: page.locator(`strong[title="节点 ${i + 1}"]`) })
      : page.locator(`.group-frame[data-group-id="g${i}"] .group-connection-port.${i % 2 === 0 ? 'right' : 'left'}`);
    const box = await target.boundingBox();
    const x = i < 4 ? i % 2 === 0 ? box!.x + box!.width : box!.x : box!.x + box!.width / 2;
    const y = box!.y + box!.height / 2;
    await page.mouse.move(x, y, { steps: 8 });
    if (i % 2 === 0) await expect.poll(outwardX).toBeLessThan(0); else await expect.poll(outwardX).toBeGreaterThan(0);
    const preview = await draft.getAttribute('d');
    if (i === 0) await page.screenshot({ path: info.outputPath('left-input-preview.png') });
    await page.mouse.up(); await expect(draft).toHaveCount(0); await expect(page.locator('.connection-hit-area')).toHaveCount(4);
    const committed = page.locator('.connection-hit-area:not([data-connection-id="trunk"]):not([data-connection-id="branch0"]):not([data-connection-id="branch1"])').locator('..').locator('.connection-path');
    await expect(committed).toHaveAttribute('d', preview!);
    await expect(page.locator('.connection-arrow')).toHaveCount(i % 2 === 0 ? 2 : 3);
    await page.keyboard.press('Control+z'); await expect(page.locator('.connection-hit-area')).toHaveCount(3);
  }
  const paths = () => page.locator('.connection-hit-area').evaluateAll(elements => elements.map(element => element.getAttribute('d')));
  const original = await paths(); await marker.focus();
  const plus = await marker.getByRole('button', { name: '从中转点拉出连接线', exact: true }).boundingBox();
  const source = await page.locator('.text-node-card').filter({ has: page.locator('strong[title="节点 7"]') }).boundingBox();
  await page.mouse.move(plus!.x + plus!.width / 2, plus!.y + plus!.height / 2); await page.mouse.down();
  await page.mouse.move(source!.x + source!.width, source!.y + source!.height / 2, { steps: 8 });
  await expect.poll(paths).toEqual(original);
  await page.mouse.up(); await expect(draft).toHaveCount(0); await expect(page.locator('.connection-hit-area')).toHaveCount(3);
  expect(await paths()).toEqual(original);
});

test('the four reported solid and dashed layouts use broad curves with a shared junction direction', async ({ page }, info) => {
  await page.setViewportSize({ width: 1434, height: 900 });
  const layouts: FanLayout[] = [
    { positions: [[180, 125], [180, 350], [995, 508]], junction: [700, 612], pairs: [['n0', 'j'], ['n1', 'j'], ['j', 'n2']], title: false },
    { positions: [[84, 400], [843, 201], [843, 424]], junction: [630, 398], pairs: [['n0', 'j'], ['j', 'n1'], ['j', 'n2']], title: false },
    { positions: [[357, 90], [357, 313], [357, 607]], junction: [137, 262], pairs: [['n2', 'j'], ['j', 'n0'], ['j', 'n1']], title: true },
    { positions: [[90, 24], [90, 247], [734, 276]], junction: [579, 196], pairs: [['n2', 'j'], ['j', 'n0'], ['j', 'n1']], title: true },
  ];
  for (let i = 0; i < layouts.length; i++) {
    await openSteepFan(page, layouts[i]);
    const curves = await page.locator('.connection-hit-area').evaluateAll(elements => elements.map(element => element.getAttribute('d')!.match(/-?\d+(?:\.\d+)?/gu)!.map(Number)));
    const vectors = curves.map(p => p[0] === layouts[i].junction[0] && p[1] === layouts[i].junction[1]
      ? [p[2] - p[0], p[3] - p[1]] : [p.at(-2)! - p.at(-4)!, p.at(-1)! - p.at(-3)!]);
    for (const v of vectors) expect((v[0] * vectors[0][0] + v[1] * vectors[0][1]) / (Math.hypot(...v) * Math.hypot(...vectors[0]))).toBeCloseTo(1, 3);
    if (i === 0) {
      const outgoing = curves.find(p => p[0] === 700)!;
      expect(outgoing[1]).toBe(outgoing[3]);
      expect(Math.max(...outgoing.filter((_, index) => index % 2 === 1))).toBe(outgoing[1]);
    }
    await expect(page.getByText(/Illegal interaction transition/u)).toHaveCount(0);
    await page.mouse.move(10, 880); await page.screenshot({ path: info.outputPath(`fair-layout-${i + 1}.png`) });
  }
});
