import { expect, test, type Page } from '@playwright/test';
import { colorContrastRatio } from '../src/ui/canvas-contrast.ts';
import { serializeProject } from '../src/plugins/import-export/codec.ts';
import { createContentStorage } from '../src/plugins/text-node/content-storage.ts';
import type { ProjectSource } from '../src/protocols/files.ts';

test.use({ viewport: { width: 600, height: 960 } });
interface FanLayout { positions: readonly (readonly [number, number])[]; junction: readonly [number, number]; junctions?: readonly { id: string; x: number; y: number }[]; pairs: readonly (readonly [string, string])[]; title: boolean; boxes?: readonly number[]; groups?: readonly number[]; unrouted?: boolean }
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
  if (!layout.unrouted) namespaces.connectionJunction.j = { id: 'j', x: layout.junction[0], y: layout.junction[1], revision: 1, branchSide: 'outgoing' };
  for (const point of layout.junctions ?? []) namespaces.connectionJunction[point.id] = { ...point, revision: 1 };
  const endpoint = (id: string, from: boolean) => ({ nodeId: id, ...(id.startsWith('j') ? { kind: 'junction', side: from ? 'right' : 'left' } : id.startsWith('g') ? { kind: 'group', side: from ? 'right' : 'left' } : { side: layout.title ? 'title' : from ? 'right' : 'left' }) });
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
  await expect(notice).toHaveCount(0);
  if (layout.pairs.length > 600) await expect(page.locator('.connection-layer')).toHaveAttribute('data-render-mode','batched-svg');
  else await expect(page.locator('.connection-hit-area')).toHaveCount(layout.pairs.length);
}
async function path(page: Page, id: string) { return (await page.locator(`.connection-hit-area[data-connection-id="${id}"]`).getAttribute('d'))!.match(/-?\d+(?:\.\d+)?/gu)!.map(Number); }
async function expectSmoothJoint(page: Page) {
  for (let i = 0; i < 3; i++) {
    const p = await path(page, `branch${i}`);
    expect(p[3]).toBeCloseTo(p[1], 2);
    expect((p[2] - p[0]) * (p.at(-2)! - p[0])).toBeGreaterThan(0);
    expect(p.at(-3)).toBe(p.at(-1));
  }
  const trunk = await path(page, 'trunk');
  expect(trunk.at(-3)).toBeCloseTo(trunk.at(-1)!, 2);
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

test('split-delete-reconnect follows the complete user workflow with the junction on either side', async ({ page }, info) => {
  test.setTimeout(60_000); await page.setViewportSize({ width: 1400, height: 1000 });
  const cases = [
    { common: 80, branches: 900, replacement: 80, jx: 530, outgoing: false },
    { common: 900, branches: 80, replacement: 900, jx: 530, outgoing: true },
    { common: 900, branches: 350, replacement: 350, jx: 1200, outgoing: false },
    { common: 80, branches: 600, replacement: 600, jx: 150, outgoing: true },
  ];
  const screenPoint = (x: number, y: number) => page.locator('.connection-layer > g').evaluate((element, p) => {
    const result = new DOMPoint(p.x, p.y).matrixTransform((element as SVGGElement).getScreenCTM()!); return { x: result.x, y: result.y };
  }, { x, y });
  const expectForwardCurves = async () => {
    for (const p of await page.locator('.connection-hit-area').evaluateAll(elements => elements.map(element => element.getAttribute('d')!.match(/-?\d+(?:\.\d+)?/gu)!.map(Number)))) {
      const sign = p.at(-2)! >= p[0] ? 1 : -1;
      for (let i = 2; i < p.length; i += 2) expect((p[i] - p[i - 2]) * sign, 'control handles must not turn back across the horizontal span').toBeGreaterThanOrEqual(-.002);
    }
  };
  for (const [index, c] of cases.entries()) {
    await openSteepFan(page, { positions: [[c.common, 230], [c.branches, 80], [c.branches, 440], [c.replacement, 700]], junction: [c.jx, 430],
      pairs: c.outgoing ? [['n0', 'n1'], ['n0', 'n2']] : [['n1', 'n0'], ['n2', 'n0']], title: false, unrouted: true });
    const first = page.locator('.connection-hit-area[data-connection-id="trunk"]'); await first.focus(); await first.press('Enter');
    const second = page.locator('.connection-hit-area[data-connection-id="branch0"]');
    const exposed = await second.evaluate(element => {
      const curve = element as SVGPathElement, length = curve.getTotalLength(), matrix = curve.getScreenCTM()!;
      for (let i = 10; i < 90; i += 3) { const p = curve.getPointAtLength(length * i / 100), screen = new DOMPoint(p.x, p.y).matrixTransform(matrix);
        if (document.elementFromPoint(screen.x, screen.y) === curve) return { x: screen.x, y: screen.y }; }
      throw Error('No exposed original line');
    });
    await page.keyboard.down('Shift'); await page.mouse.click(exposed.x, exposed.y); await page.keyboard.up('Shift');
    await expect(page.locator('.connection-hit-area[aria-pressed="true"]')).toHaveCount(2);
    const point = await screenPoint(c.jx, 430); await page.mouse.click(point.x, point.y, { button: 'right' });
    const marker = page.locator('.connection-junction'); await expect(marker).toHaveCount(1); await expect(marker).not.toHaveAttribute('data-handle-angle');
    await expect(page.locator('.connection-hit-area')).toHaveCount(3);
    const commonLeg = page.locator('.connection-hit-area:not([data-connection-id="trunk"]):not([data-connection-id="branch0"])');
    await commonLeg.focus(); await commonLeg.press('Enter'); await page.keyboard.press('Delete');
    await expect(page.locator('.connection-hit-area')).toHaveCount(2); await expect(marker).toHaveCount(1);
    await marker.focus(); const plus = await marker.getByRole('button', { name: '从中转点拉出连接线', exact: true }).boundingBox();
    const target = await page.locator('.text-node-card').filter({ has: page.locator('strong[title="节点 4"]') }).boundingBox();
    await page.mouse.move(plus!.x + plus!.width / 2, plus!.y + plus!.height / 2); await page.mouse.down();
    await page.mouse.move(c.replacement < c.jx ? target!.x + target!.width : target!.x, target!.y + target!.height / 2, { steps: 10 });
    await page.screenshot({ path: info.outputPath(`workflow-${index}-preview.png`) });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expectForwardCurves(); const preview = await page.locator('.connection-path.draft').getAttribute('d'); await page.mouse.up();
    await expect(page.locator('.connection-hit-area')).toHaveCount(3); await expectForwardCurves();
    const replacement = page.locator('.connection-hit-area:not([data-connection-id="trunk"]):not([data-connection-id="branch0"])').locator('..').locator('.connection-path');
    await expect(replacement).toHaveAttribute('d', preview!); await expect(marker).not.toHaveAttribute('data-handle-angle');
    await page.mouse.move(10, 950); await page.screenshot({ path: info.outputPath(`workflow-${index}-committed.png`) });
    await page.keyboard.press('Control+z'); await expect(page.locator('.connection-hit-area')).toHaveCount(2);
    await page.keyboard.press('Control+Shift+z'); await expect(page.locator('.connection-hit-area')).toHaveCount(3); await expectForwardCurves();
  }
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
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
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
    for (const [index, v] of vectors.entries()) {
      expect(Math.abs((v[0] * vectors[0][0] + v[1] * vectors[0][1]) / (Math.hypot(...v) * Math.hypot(...vectors[0])))).toBeCloseTo(1, 3);
      const p = curves[index];
      expect(v[0] * (p.at(-2)! - p[0])).toBeGreaterThanOrEqual(-.002);
      expect(v[1] * (p.at(-1)! - p[1])).toBeGreaterThanOrEqual(-.002);
    }
    if (i === 0) {
      const outgoing = curves.find(p => p[0] === 700)!;
      expect(outgoing[1]).toBe(outgoing[3]);
      expect(Math.max(...outgoing.filter((_, index) => index % 2 === 1))).toBe(outgoing[1]);
    }
    await expect(page.getByText(/Illegal interaction transition/u)).toHaveCount(0);
    await page.mouse.move(10, 880); await page.screenshot({ path: info.outputPath(`fair-layout-${i + 1}.png`) });
  }
});

test('free point drags use the point centre even when all existing legs approach from the opposite side', async ({ page }, info) => {
  await page.setViewportSize({ width: 1000, height: 900 });
  for (const existingSide of [-1, 1]) {
    const x = existingSide < 0 ? 80 : 700;
    await openSteepFan(page, { positions: [[x, 30], [x, 700]], junction: [500, 380],
      pairs: [['n0', 'j'], ['n1', 'j']], title: false });
    const marker = page.locator('.connection-junction'); await marker.focus();
    const paths = () => page.locator('.connection-hit-area').evaluateAll(elements => elements.map(element => element.getAttribute('d')));
    const original = await paths();
    const dot = await marker.locator('.connection-junction-dot').boundingBox(), plus = await marker.getByRole('button', { name: '从中转点拉出连接线', exact: true }).boundingBox();
    await page.mouse.move(plus!.x + plus!.width / 2, plus!.y + plus!.height / 2); await page.mouse.down();
    for (const [dx, dy] of [[180, -160], [180, 170], [-160, 170], [-180, -170], [30, 200], [-30, -220]]) {
      await page.mouse.move(dot!.x + dot!.width / 2 + dx, dot!.y + dot!.height / 2 + dy, { steps: 8 });
      const draft = page.locator('.connection-path.draft');
      await expect.poll(async () => {
        const p = (await draft.getAttribute('d'))!.match(/-?\d+(?:\.\d+)?/gu)!.map(Number);
        return p[0] === 500 && p[1] === 380 ? p[2] - p[0] : p.at(-4)! - p.at(-2)!;
      })[dx > 0 ? 'toBeGreaterThan' : 'toBeLessThan'](0);
      await expect(draft.locator('..').locator('.connection-arrow')).toHaveCount(dx > 0 ? 1 : 0);
      expect(await paths()).toEqual(original);
      if (Math.abs(dx) === 180) await page.screenshot({ path: info.outputPath(`centre-${existingSide}-${dx}-${dy}.png`) });
    }
    await page.keyboard.press('Escape'); await page.mouse.up();
    await expect(page.locator('.connection-path.draft')).toHaveCount(0); await expect(page.locator('.connection-hit-area')).toHaveCount(2);
  }
});

test('many-to-many paths remain smooth while each branch stays independently selectable and deletable', async ({ page }, info) => {
  await page.setViewportSize({ width: 1300, height: 900 });
  await openSteepFan(page, { positions: [[80, 100], [80, 500], [900, 100], [900, 500]], junction: [600, 400],
    pairs: [['n0', 'j'], ['n1', 'j'], ['j', 'n2'], ['j', 'n3']], title: false });
  const paths = () => page.locator('.connection-hit-area').evaluateAll(elements => Object.fromEntries(elements.map(element => [element.getAttribute('data-connection-id'), element.getAttribute('d')])));
  const original = await paths();
  for (const p of Object.values(original) as string[]) {
    const values = p.match(/-?\d+(?:\.\d+)?/gu)!.map(Number);
    let x = values[0], y = values[1], previous: number[] | undefined;
    for (let i = 2; i < values.length; i += 6) {
      const tangent = [values[i] - x, values[i + 1] - y];
      if (previous) expect((previous[0] * tangent[0] + previous[1] * tangent[1]) / (Math.hypot(...previous) * Math.hypot(...tangent))).toBeGreaterThan(.9999);
      previous = [values[i + 4] - values[i + 2], values[i + 5] - values[i + 3]]; x = values[i + 4]; y = values[i + 5];
    }
  }
  await page.screenshot({ path: info.outputPath('many-to-many.png') });
  const branch = page.locator('.connection-hit-area[data-connection-id="branch0"]'); await branch.focus(); await branch.press('Enter');
  await expect(page.locator('.connection-hit-area[aria-pressed="true"]')).toHaveCount(1);
  await page.keyboard.press('Delete'); await expect(page.locator('.connection-hit-area')).toHaveCount(3); await expect(page.locator('.connection-junction')).toHaveCount(1);
  const remaining = await paths(); expect(remaining.trunk).toBe(original.trunk); expect(remaining.branch1).toBe(original.branch1); expect(remaining.branch2).toBe(original.branch2);
  await page.keyboard.press('Control+z'); await expect.poll(paths).toEqual(original);
});

test('selecting then dragging a junction keeps the last preview after release without rotating its preference', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 900 });
  await openSteepFan(page, { positions: [[900, 100]], junction: [530, 400], pairs: [['j', 'n0']], title: false });
  const marker = page.locator('.connection-junction'), dot = marker.locator('.connection-junction-dot');
  const paths = () => page.locator('.connection-hit-area').evaluateAll(elements => elements.map(element => element.getAttribute('d')));
  await dot.click();
  for (const [dx, dy] of [[4, 0], [0, 4], [120, 80], [-150, -90], [10, 10], [1, 6]]) {
    const clickCount = dx === 4 ? 2 : 1;
    const box = await dot.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2); await page.mouse.down({ clickCount });
    await page.mouse.move(box!.x + box!.width / 2 + dx, box!.y + box!.height / 2 + dy, { steps: 8 });
    await expect(marker).not.toHaveAttribute('data-handle-angle');
    const preview = await paths(); await page.mouse.up({ clickCount });
    // Observe beyond the optimistic preview, through asynchronous owner projection.
    const settled = await page.evaluate(async () => {
      const samples: string[][] = [];
      for (let i = 0; i < 24; i++) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        samples.push([...document.querySelectorAll('.connection-hit-area')].map(e => e.getAttribute('d')!));
      }
      return samples;
    });
    for (const sample of settled) expect(sample).toEqual(preview);
    await expect(marker).not.toHaveAttribute('data-handle-angle');
    await expect.poll(paths).toEqual(preview);
  }
  const beforeRotation = await paths();
  await dot.dblclick();
  await expect(marker).not.toHaveAttribute('data-handle-angle');
  await expect.poll(paths).toEqual(beforeRotation);
});

test('a curve near a selected junction can be selected normally without starting direction adjustment', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 900 });
  await openSteepFan(page, { positions: [[900, 80], [900, 400]], junction: [530, 450], pairs: [['j', 'n0'], ['j', 'n1']], title: false });
  const dot = page.locator('.connection-junction-dot'), edge = page.locator('.connection-hit-area[data-connection-id="trunk"]');
  await dot.click();
  const paths = () => page.locator('.connection-hit-area').evaluateAll(elements => elements.map(e => e.getAttribute('d')));
  const before = await paths();
  const point = await edge.evaluate(element => {
    const curve = element as SVGPathElement, matrix = curve.getScreenCTM()!;
    for (let length = 20 / Math.abs(matrix.a); length < 45 / Math.abs(matrix.a); length += 2 / Math.abs(matrix.a)) {
      const p = curve.getPointAtLength(length), screen = new DOMPoint(p.x, p.y).matrixTransform(matrix);
      if (document.elementFromPoint(screen.x, screen.y) === curve) return { x: screen.x, y: screen.y };
    }
    throw new Error('No exposed curve near junction');
  });
  await page.mouse.click(point.x, point.y);
  await expect(edge).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(paths).toEqual(before);
});

for (const kind of ['node', 'box', 'junction', 'group', 'lasso'] as const) test(`edge panning follows a held ${kind} drag and stops on release`, async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 900 });
  await openSteepFan(page, { positions: [[300, 220], [700, 220]], junction: [580, 500], pairs: [['j', 'n1']], title: false,
    boxes: kind === 'box' ? [0] : [], groups: kind === 'group' ? [0] : [] });
  if (kind === 'box') { const zoom = page.getByRole('textbox', { name: /画布缩放/u }); await zoom.fill('40'); await zoom.press('Enter'); }
  const surface = page.locator('.canvas-surface'), rect = (await surface.boundingBox())!;
  const target = kind === 'junction' ? page.locator('.connection-junction-dot') : kind === 'group' ? page.locator('.group-frame').first() : page.getByRole('article', { name: new RegExp(`${kind === 'box' ? '文本框' : '文本节点'}：节点 1$`, 'u') });
  const start = kind === 'lasso' ? { x: rect.x + 40, y: rect.y + 80 } : await target.evaluate((element, kind) => {
    const box = element.getBoundingClientRect(); return kind === 'group' ? { x: box.left + 10, y: box.top + 10 } : { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  }, kind);
  const camera = () => page.locator('.group-world').evaluate(element => getComputedStyle(element).transform);
  const original = await camera();
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  const end = kind === 'group' ? { x: rect.x + 7, y: start.y } : kind === 'junction' ? { x: start.x, y: rect.y + 7 } : kind === 'lasso' ? { x: start.x, y: rect.y + rect.height - 7 } : { x: rect.x + rect.width - 7, y: start.y };
  await page.mouse.move(end.x, end.y, { steps: kind === 'node' || kind === 'group' ? 1 : 12 });
  await expect.poll(camera).not.toBe(original);
  const first = await camera();
  await expect.poll(camera).not.toBe(first);
  if (kind !== 'lasso') {
    const position = await target.boundingBox();
    await expect.poll(async () => { const current = (await target.boundingBox())!; return Math.hypot(current.x - position!.x, current.y - position!.y); }).toBeLessThan(3);
  } else await expect(page.locator('.selection-lasso')).toBeVisible();
  await page.mouse.up();
  await expect(page.locator('.selection-lasso')).toHaveCount(0);
  const stopped = await camera();
  // Observe multiple frames with no pointer movement after release.
  const frames = await page.locator('.group-world').evaluate(async element => {
    const values: string[] = []; for (let i = 0; i < 12; i++) { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); values.push(getComputedStyle(element).transform); } return values;
  });
  expect(frames.every(value => value === stopped)).toBe(true);
  await expect(page.getByText(/Illegal interaction transition/u)).toHaveCount(0);
});

test('cancelling an edge drag restores its camera and objects without a continuing pan', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 900 });
  await openSteepFan(page, { positions: [[300, 220]], junction: [580, 500], pairs: [], title: false });
  const node = page.getByRole('article', { name: /文本节点：节点 1$/u }), origin = (await node.boundingBox())!;
  const camera = () => page.locator('.group-world').evaluate(element => getComputedStyle(element).transform);
  const original = await camera(), surface = (await page.locator('.canvas-surface').boundingBox())!;
  await page.mouse.move(origin.x + 60, origin.y + 70); await page.mouse.down();
  await page.mouse.move(surface.x + 5, origin.y + 70);
  await expect.poll(camera).not.toBe(original);
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect.poll(camera).toBe(original);
  await expect.poll(async () => { const box = (await node.boundingBox())!; return Math.hypot(box.x - origin.x, box.y - origin.y); }).toBeLessThan(1);
});

test('Shift+L connects a node title or text box title to a selected junction and toggles it off', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 900 });
  for (const box of [false, true]) {
    await openSteepFan(page, { positions: [[180, 150], [800, 400]], junction: [550, 450], pairs: [['j', 'n1']], title: true, boxes: box ? [0] : [] });
    const node = page.getByRole('article', { name: new RegExp(`${box ? '文本框' : '文本节点'}：节点 1$`, 'u') }), dot = page.locator('.connection-junction-dot');
    await node.click(); await page.keyboard.down('Shift'); await dot.click(); await page.keyboard.up('Shift');
    await page.keyboard.press('Shift+l'); await expect(page.locator('.connection-hit-area')).toHaveCount(2);
    await expect(page.locator('.connection-path.title-connection')).toHaveCount(2);
    await page.keyboard.press('Shift+l'); await expect(page.locator('.connection-hit-area')).toHaveCount(1);
    await page.keyboard.press('Control+z'); await expect(page.locator('.connection-hit-area')).toHaveCount(2);
  }
});

test('global junction color previews, commits and undoes independently; all matching themes remain readable', async ({ page }, info) => {
  await page.setViewportSize({ width: 1450, height: 900 });
  await openSteepFan(page, { positions: [[250, 150], [800, 400]], junction: [580, 450], pairs: [['j', 'n1']], title: true, boxes: [0], groups: [1] });
  await page.getByRole('button', { name: '命令面板', exact: true }).click();
  const palette = page.getByRole('dialog', { name: '命令面板' });
  await palette.getByRole('textbox', { name: '搜索命令' }).fill('打开全局颜色设置'); await palette.getByRole('option', { name: /^打开全局颜色设置/u }).click();
  const panel = page.getByRole('region', { name: '全局颜色设置' }), dot = page.locator('.connection-junction-dot');
  const stroke = () => dot.evaluate(element => getComputedStyle(element).stroke);
  for (const label of ['B 暗调', 'C 护眼', 'A 明调']) {
    const preset = panel.getByRole('button', { name: new RegExp(`^${label}`, 'u') }); await preset.click(); await expect(preset).toHaveAttribute('aria-pressed', 'true');
    for (const colors of await page.locator('.text-node-card header').evaluateAll(elements => elements.map(element => {
      const style = getComputedStyle(element); return { ink: style.color, background: style.backgroundColor };
    }))) expect(colorContrastRatio(colors.ink, colors.background)).toBeGreaterThanOrEqual(4.5);
    await page.mouse.move(10, 850); await page.screenshot({ path: info.outputPath(`theme-${label[0]}.png`) });
    await expect(page.getByText(/操作没有完成|Illegal interaction transition/u)).toHaveCount(0);
  }
  const original = await stroke(); await panel.getByRole('button', { name: '中转点颜色', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '颜色选择器' });
  await picker.getByRole('spinbutton', { name: 'R 通道数值' }).fill('36');
  await picker.getByRole('spinbutton', { name: 'G 通道数值' }).fill('94');
  await picker.getByRole('spinbutton', { name: 'B 通道数值' }).fill('180');
  await expect.poll(stroke).toBe('rgb(36, 94, 180)');
  await page.keyboard.press('Enter'); await expect(picker).toHaveCount(0);
  await expect.poll(stroke).toBe('rgb(36, 94, 180)');
  await panel.getByRole('button', { name: '关闭全局颜色设置', exact: true }).click();
  await page.keyboard.press('Control+z'); await expect.poll(stroke).toBe(original);
});

for (const oversized of [false, true]) test(`focus with no selection includes every object and ${oversized ? 'centres oversized contents at the current zoom' : 'fits compact contents'}`, async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 900 });
  await openSteepFan(page, { positions: [[300, 220], [oversized ? 6000 : 700, 220]], junction: [580, 500], pairs: [], title: false });
  await page.keyboard.press('Escape'); await page.keyboard.press('Control+Shift+f');
  const surface = (await page.locator('.canvas-surface').boundingBox())!;
  const camera = () => page.locator('.group-world').evaluate(element => { const m = new DOMMatrix(getComputedStyle(element).transform); return { x: m.e, y: m.f, zoom: m.a }; });
  const centre = oversized ? 3280 : 630;
  await expect.poll(async () => { const c = await camera(); return (surface.width / 2 - c.x) / c.zoom; }).toBeCloseTo(centre, 1);
  if (oversized) expect((await camera()).zoom).toBe(1);
  else { await expect(page.getByRole('article')).toHaveCount(2); expect((await camera()).zoom).toBeGreaterThan(1); }
});

test('40% overview reveals only selected node, box or group relationships, including junctions, and ignores hover', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 900 });
  await openSteepFan(page, { positions: [[100,100],[900,100],[900,450],[100,800],[900,800],[1500,800]], junction: [600,300],
    junctions: [{ id: 'j2', x: 600, y: 1000 }, { id: 'j3', x: 1400, y: 1400 }],
    pairs: [['n0','j'],['j','n1'],['j','n2'],['g3','j2'],['j2','n4'],['n5','n4']], title: false, boxes: [1], groups: [3] });
  const zoom = page.getByRole('textbox', { name: /画布缩放/u }); await zoom.fill('40'); await zoom.press('Enter');
  const lines = page.locator('.connection-hit-area'), points = page.locator('.connection-junction');
  await expect(lines).toHaveCount(0); await expect(points).toHaveCount(0);
  const node = page.getByRole('article', { name: /文本节点：节点 1$/u }); await node.hover();
  await expect(lines).toHaveCount(0); await expect(points).toHaveCount(0);
  await node.click(); await expect(lines).toHaveCount(3); await expect(points).toHaveCount(1);
  await expect(points).toHaveAttribute('data-junction-id','j');
  await page.getByRole('article', { name: /文本框：节点 2$/u }).click(); await expect(lines).toHaveCount(3); await expect(points).toHaveCount(1);
  const group = page.locator('.group-frame[data-group-id="g3"]'); await group.click({ position: { x: 3, y: 3 } });
  await expect(lines).toHaveCount(2); await expect(points).toHaveCount(1); await expect(points).toHaveAttribute('data-junction-id','j2');
  await points.locator('.connection-junction-dot').click(); await expect(lines).toHaveCount(2); await expect(points).toHaveCount(1);
  const surface = (await page.locator('.canvas-surface').boundingBox())!;
  await page.mouse.click(surface.x + surface.width - 35, surface.y + surface.height - 35);
  await expect(lines).toHaveCount(0); await expect(points).toHaveCount(0);
  await zoom.fill('50'); await zoom.press('Enter'); await expect(lines).toHaveCount(6); await expect(points).toHaveCount(3);
});

test('repeated clicks cycle overlapping curves without opening text editing and retain multiselect and undo', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 900 });
  await openSteepFan(page, { positions: [[100,200],[900,200],[100,200]], junction: [550,500], pairs: [['n0','n1'],['n2','n1']], title: false, unrouted: true });
  const hit = await page.locator('.connection-hit-area').first().evaluate(element => {
    const curve = element as SVGPathElement, point = curve.getPointAtLength(curve.getTotalLength() * .5), matrix = curve.getScreenCTM()!;
    const screen = new DOMPoint(point.x,point.y).matrixTransform(matrix); return { x: screen.x, y: screen.y };
  });
  const selected = () => page.locator('.connection-hit-area[aria-pressed="true"]').getAttribute('data-connection-id');
  await page.mouse.click(hit.x,hit.y); const first = await selected(); expect(first).toBeTruthy();
  await page.mouse.down({ clickCount: 2 }); await page.mouse.up({ clickCount: 2 }); await expect.poll(selected).not.toBe(first);
  await expect(page.locator('.connection-layer textarea')).toHaveCount(0);
  await expect(page.locator('.connection-overlap-hint text')).toContainText('2/2');
  const highlighted = () => page.locator('.connection-path:not(.draft)').evaluateAll(paths => paths.filter(path => Number.parseFloat(getComputedStyle(path).strokeWidth) > 2).length);
  await expect.poll(highlighted).toBe(1);
  for (let index = 0; index < 8; index++) {
    await page.mouse.click(hit.x + index % 2, hit.y);
    await expect(page.locator('.connection-hit-area[aria-pressed="true"]')).toHaveCount(1);
    await expect.poll(highlighted).toBe(1);
  }
  await page.mouse.move(hit.x, hit.y); await page.mouse.down();
  await page.mouse.move(hit.x + 4, hit.y + 3, { steps: 3 }); await page.mouse.up();
  await expect(page.locator('.connection-hit-area[aria-pressed="true"]')).toHaveCount(1);
  await expect.poll(highlighted).toBe(1);
  await page.mouse.click(hit.x, hit.y);
  await page.keyboard.down('Shift'); await page.mouse.click(hit.x,hit.y); await page.keyboard.up('Shift');
  await expect(page.locator('.connection-hit-area[aria-pressed="true"]')).toHaveCount(2);
  await page.keyboard.press('Delete'); await expect(page.locator('.connection-hit-area')).toHaveCount(0);
  await page.keyboard.press('Control+z'); await expect(page.locator('.connection-hit-area')).toHaveCount(2);
});

test('overlap cycling also works in batched rendering and survives deleting one of 601 coincident curves', async ({ page }) => {
  test.setTimeout(60_000); await page.setViewportSize({width:1300,height:900});
  await openSteepFan(page,{ positions:[...Array.from({length:601},()=>[100,200] as const),[900,200]],junction:[500,500],
    pairs:Array.from({length:601},(_,i)=>[`n${i}`,'n601'] as const),title:false,unrouted:true });
  const surface=(await page.locator('.canvas-surface').boundingBox())!, x=surface.x+630,y=surface.y+273;
  const selected=()=>page.locator('.connection-arrow.selected[data-arrow-for]').getAttribute('data-arrow-for');
  await page.mouse.click(x,y); await expect.poll(selected).toBeTruthy(); const first=await selected();
  await page.mouse.click(x,y); await expect.poll(selected).not.toBe(first); const second=await selected();
  await expect(page.locator('.connection-overlap-hint text')).toContainText('2/601');
  await page.keyboard.press('Delete'); await expect(page.locator('.connection-layer')).toHaveAttribute('data-render-mode','interactive-svg');
  await expect(page.locator(`.connection-hit-area[data-connection-id="${second}"]`)).toHaveCount(0);
  await page.keyboard.press('Control+z'); await expect(page.locator('.connection-layer')).toHaveAttribute('data-render-mode','batched-svg');
});

test('overlapping junction clicks cycle points and a following drag moves the selected point only', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 900 });
  await openSteepFan(page, { positions: [[100,100]], junction: [550,400], junctions: [{ id:'j2',x:550,y:400 },{ id:'j3',x:550,y:400 }], pairs: [], title: false });
  const centre = await page.locator('.connection-junction-dot').first().boundingBox();
  const x=centre!.x+centre!.width/2, y=centre!.y+centre!.height/2;
  const selected = () => page.locator('.connection-junction[aria-pressed="true"]').getAttribute('data-junction-id');
  await page.mouse.click(x,y); await expect.poll(selected).toBe('j');
  await page.mouse.down({ clickCount: 2 }); await page.mouse.up({ clickCount: 2 }); await expect.poll(selected).toBe('j2');
  await expect(page.locator('.connection-overlap-hint text')).toContainText('2/3');
  const original = await page.locator('.connection-junction[data-junction-id="j2"]').getAttribute('transform');
  await page.mouse.move(x,y); await page.mouse.down(); await page.mouse.move(x+80,y+40,{steps:8}); await page.mouse.up();
  await expect(page.locator('.connection-junction[data-junction-id="j2"]')).not.toHaveAttribute('transform',original!);
  for (const id of ['j','j3']) await expect(page.locator(`.connection-junction[data-junction-id="${id}"]`)).toHaveAttribute('transform','translate(550 400)');
  await page.keyboard.press('Control+z'); await expect(page.locator('.connection-junction[data-junction-id="j2"]')).toHaveAttribute('transform',original!);
});

for (const level of [100,40,240]) test(`junction move and connect controls remain separated at ${level}% and their gap is inert`, async ({ page }) => {
  await page.setViewportSize({ width:1300,height:900 });
  await openSteepFan(page,{ positions:[[800,100]],junction:[530,400],pairs:[['j','n0']],title:false });
  await page.getByRole('article',{name:/文本节点：节点 1$/u}).click();
  const zoom=page.getByRole('textbox',{name:/画布缩放/u}); await zoom.fill(String(level)); await zoom.press('Enter');
  const marker=page.locator('.connection-junction'); await marker.locator('.connection-junction-dot').hover();
  const move=(await marker.locator('.connection-junction-hit').boundingBox())!, port=marker.locator('.connection-junction-port'), portHit=(await port.locator('.connection-junction-port-hit').boundingBox())!;
    expect(move.y-portHit.y-portHit.height).toBeCloseTo(6, 1);
  expect(move.width).toBeCloseTo(32,1); expect(portHit.width).toBeCloseTo(24,1);
  const original=await marker.getAttribute('transform'), x=move.x+move.width/2, gapY=(move.y+portHit.y+portHit.height)/2;
  await page.mouse.move(x,gapY); await expect(port).toHaveCSS('opacity','1');
  await page.mouse.down(); await page.mouse.move(x+10,gapY,{steps:3}); await page.mouse.up();
  await expect(marker).toHaveAttribute('transform',original!); await expect(page.locator('.connection-path.draft')).toHaveCount(0);
  await page.mouse.move(portHit.x+portHit.width/2,portHit.y+portHit.height/2); await page.mouse.down();
  await page.mouse.move(x+140,gapY+100,{steps:6}); await expect(page.locator('.connection-path.draft')).toHaveCount(1);
  await expect(marker).toHaveAttribute('transform',original!); await page.mouse.up();
  await expect(page.getByText(/Illegal interaction transition/u)).toHaveCount(0);
});

test('reference lines and snapping are configurable separately in the shortcut centre', async ({ page }) => {
  await openSteepFan(page);
  await page.getByRole('button', { name: '命令面板', exact: true }).click();
  const palette = page.getByRole('dialog', { name: '命令面板' });
  await palette.getByRole('textbox', { name: '搜索命令' }).fill('打开快捷键中心');
  await palette.getByRole('option', { name: /^打开快捷键中心/u }).click();
  const panel = page.getByRole('region', { name: '快捷键中心' }), search = panel.getByPlaceholder('搜索操作或分类…');
  for (const [label, chord, key] of [['智能参考线', 'Control+Shift+7', '7'], ['自动吸附', 'Control+Shift+8', '8']]) {
    await search.fill(label);
    const binding = panel.getByRole('textbox', { name: `修改打开或关闭${label}的快捷键` });
    await expect(binding).toHaveValue('未设置'); await binding.focus(); await page.keyboard.press(chord);
    await expect(binding).toHaveValue(new RegExp(`Ctrl.*Shift.*${key}`, 'u'));
  }
});

for (const title of [false, true]) test(`moving a ${title ? 'title' : 'body'} junction close to a node keeps arrow size, line width and dash spacing unchanged`, async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 900 });
  await openSteepFan(page, { positions: [[900, 300]], junction: [530, 373], pairs: [['j', 'n0']], title });
  const dot = page.locator('.connection-junction-dot'), arrow = page.locator('.connection-arrow'), line = page.locator('.connection-path');
  const dimensions = () => arrow.evaluate(element => { const box = element.getBoundingClientRect(); return [box.width, box.height]; });
  const style = () => line.evaluate(element => { const s = getComputedStyle(element); return [s.strokeWidth, s.strokeDasharray]; });
  await page.mouse.move(10, 850); const originalSize = await dimensions(), originalStyle = await style();
  for (const dx of [270, 70]) {
    const box = await dot.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2); await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 + dx, box!.y + box!.height / 2, { steps: 8 });
    expect(await dimensions()).toEqual(originalSize);
    await page.mouse.up(); await page.mouse.move(10, 850);
    await expect.poll(dimensions).toEqual(originalSize); expect(await style()).toEqual(originalStyle);
  }
});
