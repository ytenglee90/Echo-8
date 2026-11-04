import { expect, test, type Page } from '@playwright/test';
import { serializeProject } from '../src/plugins/import-export/codec.ts';
import { createContentStorage } from '../src/plugins/text-node/content-storage.ts';
import type { ProjectSource } from '../src/protocols/files.ts';

async function openGroups(page: Page, routedCopy = false) {
  await page.addInitScript(() => Object.defineProperty(window, 'showOpenFilePicker', { configurable: true, value: undefined }));
  await page.goto('/'); await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
  const namespaces: ProjectSource['document']['namespaces'] = { textNode: {}, textContent: {}, textContentChunk: {}, groups: {}, connections: {}, connectionJunction: {} };
  for (const [id, x, y] of [['a', 80, 80], ['b', 80, 330], ['c', 760, 80], ['d', 760, 330], ['e', 440, 530], ['f', 440, 330]] as const) {
    const content = createContentStorage(`body-${id}`, `正文${id}`, 1);
    namespaces.textContent[`body-${id}`] = content.content;
    for (const patch of content.chunkPatches) if (patch.op === 'set') namespaces.textContentChunk[patch.key] = patch.value;
    namespaces.textNode[id] = { id, contentId: `body-${id}`, title: `群组测试${id}`, x, y, width: 220, height: 130, ...(id === 'f' ? { presentation: 'text-box', width: 160, height: 64 } : {}), titleColor: '#303030', revision: 1, createdAt: 1, updatedAt: 1 };
  }
  for (const [id, memberIds] of [['g1', ['a', 'b']], ['g2', ['c', 'd']]] as const) namespaces.groups[id] = {
    id, memberIds, title: id, titleStyle: { fontSize: 13, fontWeight: 650 }, revision: 1, createdAt: 1, updatedAt: 1,
  };
  if (routedCopy) {
    namespaces.connectionJunction.j = { id: 'j', x: 570, y: 230, revision: 1, branchSide: 'incoming' };
    for (const id of ['a', 'b']) namespaces.connections[id] = { id, from: { nodeId: id, side: 'right' }, to: { nodeId: 'j', kind: 'junction', side: 'left' }, revision: 1, createdAt: 1 };
    namespaces.connections.trunk = { id: 'trunk', from: { nodeId: 'j', kind: 'junction', side: 'right' }, to: { nodeId: 'c', side: 'left' }, revision: 1, createdAt: 1 };
    namespaces.connections.internal = { id: 'internal', from: { nodeId: 'a', side: 'right' }, to: { nodeId: 'b', side: 'left' }, revision: 1, createdAt: 1 };
  }
  const blob = await serializeProject({ document: { revision: 1, namespaces }, plugins: [
    { id: 'text-node', version: '0.1.0', dataVersion: 2, namespaces: ['textNode', 'textContent', 'textContentChunk'], available: true },
    { id: 'groups', version: '0.1.0', dataVersion: 2, namespaces: ['groups'], available: true },
    { id: 'connections', version: '0.1.0', dataVersion: 8, namespaces: ['connections', 'connectionJunction'], available: true },
  ] });
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: '命令面板' });
  await palette.getByRole('textbox', { name: '搜索命令' }).fill('打开书籍');
  await palette.getByRole('option', { name: /^打开书籍/u }).click();
  const notice = page.getByRole('status').filter({ hasText: '当前书籍还有未保存修改' });
  const chooser = page.waitForEvent('filechooser');
  await notice.getByRole('button', { name: '不保存，继续选择书籍' }).click();
  await (await chooser).setFiles({ name: '群组连线.echo8', mimeType: blob.type, buffer: Buffer.from(await blob.arrayBuffer()) });
  await expect(notice).toHaveCount(0);
  await expect(page.locator('.group-frame')).toHaveCount(2);
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 }); await page.mouse.up();
}
async function port(page: Page, id: string, side: 'left' | 'right') {
  const group = page.locator(`.group-frame[data-group-id="${id}"]`);
  await group.focus();
  const box = await group.locator(`.group-connection-port.${side}`).boundingBox();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

test('invisible group ports retain dragging and connect to the upper-left title port inside another group', async ({ page }) => {
  await openGroups(page);
  const from = await port(page, 'g1', 'right');
  const control = page.locator('.group-frame[data-group-id="g1"] .group-connection-port.right');
  await expect(control).toHaveCSS('border-top-width', '0px'); await expect(control).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  const target = await page.getByRole('button', { name: '从群组测试c标题栏左侧连接', exact: true }).boundingBox();
  await drag(page, from, { x: target!.x + 2, y: target!.y + target!.height / 2 });
  await expect(page.locator('.connection-hit-area')).toHaveCount(1);
  await expect(page.locator('.connection-path:not(.draft)')).toHaveClass(/title-connection/u);
  const values = (await page.locator('.connection-hit-area').getAttribute('d'))!.match(/-?\d+(?:\.\d+)?/gu)!.map(Number);
  expect(values.slice(-2)).toEqual([760, 101]);
});

test('removing a member keeps the group connector on its remaining frame throughout preview and commit', async ({ page }) => {
  await openGroups(page);
  const member = page.locator('.text-node-card').filter({ has: page.locator('strong[title="群组测试e"]') });
  const header = await member.locator('header strong').boundingBox();
  await page.keyboard.down('Control');
  await drag(page, { x: header!.x + 30, y: header!.y + 10 }, { x: 190, y: 270 }); await page.keyboard.up('Control');
  const frame = page.locator('.group-frame[data-group-id="g1"]');
  await expect(frame).toHaveAttribute('aria-label', '群组，包含 3 个节点');
  await drag(page, await port(page, 'g1', 'right'), await port(page, 'g2', 'left'));
  const line = page.locator('.connection-hit-area'), initial = await line.getAttribute('d');
  const moved = await member.locator('header strong').boundingBox();
  await page.keyboard.down('Control'); await page.mouse.move(moved!.x + 30, moved!.y + 10); await page.mouse.down();
  await page.mouse.move(580, 570, { steps: 12 });
  await expect(frame).toHaveAttribute('aria-label', '群组，包含 2 个节点');
  const remaining = await frame.evaluate(element => {
    const style = (element as HTMLElement).style;
    return { x: parseFloat(style.left) + parseFloat(style.width), y: parseFloat(style.top) + parseFloat(style.height) / 2 };
  });
  await expect.poll(async () => (await line.getAttribute('d'))!.match(/-?\d+(?:\.\d+)?/gu)!.map(Number).slice(0, 2)).toEqual([remaining.x, remaining.y]);
  const preview = await line.getAttribute('d');
  await page.mouse.up(); await page.keyboard.up('Control');
  await expect(frame).toHaveAttribute('aria-label', '群组，包含 2 个节点'); await expect(line).toHaveAttribute('d', preview!);
  await page.keyboard.press('Control+z'); await expect(frame).toHaveAttribute('aria-label', '群组，包含 3 个节点');
  await expect(line).toHaveAttribute('d', initial!);
});

for (const textBox of [false, true]) test(`Alt copying a grouped ${textBox ? 'text box' : 'node'} keeps its original group frame and connections fixed throughout preview`, async ({ page }) => {
  await openGroups(page);
  await drag(page, await port(page, 'g1', 'right'), await port(page, 'g2', 'left'));
  const node = page.locator('.text-node-card').filter({ has: page.locator('strong[title="群组测试a"]') });
  await node.locator('header').click();
  if (textBox) {
    await page.getByRole('button', { name: '文本框与文字节点相互转换', exact: true }).click();
    await expect(node).toHaveClass(/text-box/u);
  }
  const frame = page.locator('.group-frame[data-group-id="g1"]');
  if (textBox) await expect(frame).toHaveCSS('width', '290px');
  const bounds = () => frame.evaluate(element => {
    const style = (element as HTMLElement).style;
    return { left: style.left, top: style.top, width: style.width, height: style.height };
  });
  const original = await bounds();
  const connection = page.locator('.connection-hit-area');
  const path = await connection.getAttribute('d');
  const title = await node.locator(textBox ? '.text-box-title' : 'header strong').boundingBox();
  await page.keyboard.down('Alt');
  await page.mouse.move(title!.x + 30, title!.y + 10); await page.mouse.down();
  await page.mouse.move(title!.x + 390, title!.y + 110, { steps: 10 });
  await expect(page.locator('.text-node-card.duplicate-origin')).toHaveCount(1);
  await expect.poll(bounds).toEqual(original);
  await expect(connection).toHaveAttribute('d', path!);
  await page.keyboard.up('Alt');
  await expect.poll(async () => (await bounds()).width).not.toBe(original.width);
  await page.keyboard.down('Alt');
  await expect.poll(bounds).toEqual(original);
  await page.mouse.up(); await page.keyboard.up('Alt');
  await expect(page.locator('.text-node-card:not(.duplicate-origin)')).toHaveCount(7);
  await expect(frame).toHaveAttribute('aria-label', '群组，包含 2 个节点');
  await expect.poll(bounds).toEqual(original);
  await expect(connection).toHaveAttribute('d', path!);
  await page.keyboard.press('Control+z');
  await expect(page.locator('.text-node-card:not(.duplicate-origin)')).toHaveCount(6);
  await expect.poll(bounds).toEqual(original);
});

test('Ctrl dragging selected nodes and text boxes adds or removes the whole batch, with cancellation and ordinary Ctrl clicks', async ({ page }) => {
  await openGroups(page);
  const node = page.locator('.text-node-card').filter({ has: page.locator('strong[title="群组测试e"]') });
  const box = page.locator('.text-node-card.text-box').filter({ has: page.locator('strong[title="群组测试f"]') });
  const frame = page.locator('.group-frame[data-group-id="g1"]');
  await node.locator('header').click();
  await box.locator('.text-box-title').click({ modifiers: ['Shift'] });
  await expect(page.locator('.text-node-card.selected')).toHaveCount(2);
  await box.locator('.text-box-title').click({ modifiers: ['Control'] });
  await expect(page.locator('.text-node-card.selected')).toHaveCount(1);
  await box.locator('.text-box-title').click({ modifiers: ['Control'] });
  await expect(page.locator('.text-node-card.selected')).toHaveCount(2);
  const title = await box.locator('.text-box-title').boundingBox();
  await page.keyboard.down('Control');
  await page.mouse.move(title!.x + 30, title!.y + 10); await page.mouse.down();
  await page.mouse.move(190, 270, { steps: 10 });
  await expect(frame).toHaveAttribute('aria-label', '群组，包含 4 个节点');
  await page.mouse.up(); await page.keyboard.up('Control');
  await expect(frame).toHaveAttribute('aria-label', '群组，包含 4 个节点');
  await expect(page.locator('.text-node-card.selected')).toHaveCount(2);
  await page.keyboard.press('Control+z');
  await expect(frame).toHaveAttribute('aria-label', '群组，包含 2 个节点');
  await page.keyboard.press('Control+Shift+z');
  await expect(frame).toHaveAttribute('aria-label', '群组，包含 4 个节点');
  const movedTitle = await box.locator('.text-box-title').boundingBox();
  await page.keyboard.down('Control');
  await page.mouse.move(movedTitle!.x + 30, movedTitle!.y + 10); await page.mouse.down();
  await page.mouse.move(560, 230, { steps: 10 });
  await expect(frame).toHaveAttribute('aria-label', '群组，包含 2 个节点');
  // Releasing the modifier before the pointer keeps membership and commits only movement.
  await page.keyboard.up('Control'); await page.mouse.up();
  await expect(frame).toHaveAttribute('aria-label', '群组，包含 4 个节点');
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await box.locator('.text-box-title').boundingBox())!.x).toBeCloseTo(movedTitle!.x);
  const resetTitle = await box.locator('.text-box-title').boundingBox();
  await page.keyboard.down('Control');
  await drag(page, { x: resetTitle!.x + 30, y: resetTitle!.y + 10 }, { x: 560, y: 230 });
  await page.keyboard.up('Control');
  await expect(frame).toHaveAttribute('aria-label', '群组，包含 2 个节点');
  await page.keyboard.press('Control+z');
  await expect(frame).toHaveAttribute('aria-label', '群组，包含 4 个节点');
});

for (const side of ['左', '右']) test(`title ${side} port stays chosen through preview and commit, then flips on node order reversal and undo`, async ({ page }) => {
  await openGroups(page);
  const source = page.locator('.text-node-card').filter({ has: page.locator('strong[title="群组测试a"]') });
  const target = page.locator('.text-node-card').filter({ has: page.locator('strong[title="群组测试c"]') });
  const from = await source.getByRole('button', { name: `从群组测试a标题栏${side}侧连接`, exact: true }).boundingBox();
  const to = await target.getByRole('button', { name: '从群组测试c标题栏左侧连接', exact: true }).boundingBox();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2); await page.mouse.down();
  await page.mouse.move(30, 580, { steps: 8 });
  await expect(page.locator('.connection-path.draft')).toHaveAttribute('d', side === '右' ? /^M 300 101 C /u : /^M 80 101 C /u);
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 8 });
  await expect(page.locator('.connection-path.draft')).toHaveAttribute('d', side === '右' ? /^M 300 101 C /u : /^M 80 101 C /u);
  await page.mouse.up();
  const path = page.locator('.connection-hit-area');
  await expect(path).toHaveCount(1);
  const read = async () => (await path.getAttribute('d'))!.match(/-?\d+(?:\.\d+)?/gu)!.map(Number);
  expect((await read()).slice(0, 2)).toEqual([side === '右' ? 300 : 80, 101]);
  expect((await read()).slice(-2)).toEqual([side === '右' ? 980 : 760, 101]);
  const header = await source.locator('header').boundingBox();
  await drag(page, { x: header!.x + 80, y: header!.y + 21 }, { x: header!.x + 860, y: header!.y + 21 });
  await expect.poll(async () => (await read())[6]).toBe(side === '右' ? 760 : 980);
  const moved = await read();
  expect(Math.sign(moved[2] - moved[0])).toBe(side === '右' ? -1 : 1);
  expect(moved[6]).toBe(side === '右' ? 760 : 980); expect(Math.sign(moved[4] - moved[6])).toBe(side === '右' ? -1 : 1);
  await expect(page.locator('.connection-path:not(.draft)')).not.toHaveCSS('stroke-dasharray', 'none');
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await read())[0]).toBe(side === '右' ? 300 : 80);
});

test('groups connect at side midpoints, can receive node/title links and update immediately after member resizing', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await openGroups(page);
  const from = await port(page, 'g1', 'right'), to = await port(page, 'g2', 'left');
  await drag(page, from, to);
  await expect(page.locator('.connection-hit-area')).toHaveCount(1);
  await expect(page.locator('.connection-path').first()).toHaveCSS('stroke-dasharray', 'none');
  const checkMidpoints = async () => {
    const layout = await page.locator('.connection-hit-area').first().evaluate(element => {
      const path = element as SVGPathElement;
      const from = path.getPointAtLength(0), to = path.getPointAtLength(path.getTotalLength());
      const matrix = path.getScreenCTM()!;
      const a = new DOMPoint(from.x, from.y).matrixTransform(matrix), b = new DOMPoint(to.x, to.y).matrixTransform(matrix);
      const left = document.querySelector('.group-frame[data-group-id="g1"]')!.getBoundingClientRect();
      const right = document.querySelector('.group-frame[data-group-id="g2"]')!.getBoundingClientRect();
      return { from: { x: a.x, y: a.y }, to: { x: b.x, y: b.y }, expectedFrom: { x: left.right, y: left.top + left.height / 2 }, expectedTo: { x: right.left, y: right.top + right.height / 2 } };
    });
    expect(Math.abs(layout.from.x - layout.expectedFrom.x)).toBeLessThan(1);
    expect(Math.abs(layout.from.y - layout.expectedFrom.y)).toBeLessThan(1);
    expect(Math.abs(layout.to.x - layout.expectedTo.x)).toBeLessThan(1);
    expect(Math.abs(layout.to.y - layout.expectedTo.y)).toBeLessThan(1);
  };
  await checkMidpoints();
  const member = page.getByRole('article', { name: /文本节点：群组测试b$/u });
  const handle = await member.getByRole('button', { name: /调整群组测试b的大小/u }).boundingBox();
  await drag(page, { x: handle!.x + handle!.width / 2, y: handle!.y + handle!.height / 2 }, { x: handle!.x + handle!.width / 2, y: handle!.y + handle!.height / 2 + 90 });
  await checkMidpoints();
  // Independent title source aimed at the group side: group stays centred, title stays a title.
  const title = await page.getByRole('button', { name: '从群组测试e标题栏左侧连接', exact: true }).boundingBox();
  await drag(page, { x: title!.x + title!.width / 2, y: title!.y + title!.height / 2 }, await port(page, 'g2', 'left'));
  await expect(page.locator('.connection-hit-area')).toHaveCount(2);
  await expect(page.locator('.connection-path.title-connection')).toHaveCount(1);
  await page.keyboard.press('Control+z'); await expect(page.locator('.connection-hit-area')).toHaveCount(1);
  await page.keyboard.press('Control+y'); await expect(page.locator('.connection-hit-area')).toHaveCount(2);
  await page.locator('.group-frame[data-group-id="g1"]').focus(); await page.keyboard.press('Enter');
  await page.keyboard.press('Delete');
  await expect(page.locator('.connection-hit-area')).toHaveCount(1);
  await page.keyboard.press('Control+z'); await expect(page.locator('.connection-hit-area')).toHaveCount(2);
  expect(errors).toEqual([]);
});

test('group output can reach an ordinary node or a node title, retaining the correct solid/dashed style', async ({ page }) => {
  await openGroups(page);
  const node = page.getByRole('article', { name: /文本节点：群组测试e$/u });
  const box = await node.boundingBox();
  await drag(page, await port(page, 'g1', 'right'), { x: box!.x + 5, y: box!.y + box!.height / 2 });
  await expect(page.locator('.connection-hit-area')).toHaveCount(1);
  await expect(page.locator('.connection-path').first()).toHaveCSS('stroke-dasharray', 'none');
  await page.keyboard.press('Control+z'); await expect(page.locator('.connection-hit-area')).toHaveCount(0);
  await drag(page, await port(page, 'g1', 'right'), { x: box!.x + 4, y: box!.y + 21 });
  await expect(page.locator('.connection-hit-area')).toHaveCount(1);
  await expect(page.locator('.connection-path.title-connection')).toHaveCount(1);
  await expect(page.locator('.connection-hit-area')).toHaveAttribute('d', /C/u);
});

for (const upper of [true, false]) test(`group-to-text-box uses target ${upper ? 'upper' : 'lower'} region and keeps its anchor centred`, async ({ page }) => {
  await openGroups(page);
  const from = await port(page, 'g1', 'right');
  const target = await page.locator('.text-node-card').filter({ has: page.locator('strong[title="群组测试f"]') }).boundingBox();
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  await page.mouse.move(target!.x + target!.width, target!.y + target!.height * (upper ? .25 : .75), { steps: 10 });
  const draft = page.locator('.connection-path.draft');
  if (upper) await expect(draft).toHaveClass(/title-connection/u); else await expect(draft).not.toHaveClass(/title-connection/u);
  const read = async (path: import('@playwright/test').Locator) => (await path.getAttribute('d'))!.match(/-?\d+(?:\.\d+)?/gu)!.map(Number);
  await expect.poll(async () => (await read(draft))[7]).toBe(362);
  await page.mouse.up(); await expect(page.locator('.connection-hit-area')).toHaveCount(1);
  await expect.poll(async () => (await read(page.locator('.connection-hit-area'))).slice(-2)).toEqual([440, 362]);
  const line = page.locator('.connection-path:not(.draft)');
  if (upper) await expect(line).toHaveClass(/title-connection/u); else await expect(line).not.toHaveClass(/title-connection/u);
  await page.keyboard.press('Control+z'); await expect(page.locator('.connection-hit-area')).toHaveCount(0);
});

test('Alt dragging an entire group displays its copied frame before committing, while the original stays fixed', async ({ page }) => {
  await openGroups(page);
  const group = page.locator('[data-group-id="g1"].group-frame');
  const original = await group.boundingBox();
  await page.keyboard.down('Alt'); await page.mouse.move(original!.x + 14, original!.y + 16); await page.mouse.down();
  await page.mouse.move(original!.x + 360, original!.y + 96, { steps: 10 });
  const ghost = page.locator('[data-group-copy-preview="g1"]');
  await expect(ghost).toBeVisible();
  expect((await group.boundingBox())!.x).toBe(original!.x);
  expect((await ghost.boundingBox())!.x).toBeGreaterThan(original!.x + 300);
  await page.mouse.up(); await page.keyboard.up('Alt');
  await expect(ghost).toHaveCount(0); await expect(page.locator('.group-frame')).toHaveCount(3);
  await page.keyboard.press('Control+z'); await expect(page.locator('.group-frame')).toHaveCount(2);
});

for (const method of ['keyboard', 'toolbar', 'alt']) test(`copying a routed group through ${method} leaves its junction and routed links behind`, async ({ page }) => {
  await openGroups(page, true);
  await expect(page.locator('.connection-hit-area')).toHaveCount(4); await expect(page.locator('.connection-junction')).toHaveCount(1);
  const original = await page.locator('.connection-junction').getAttribute('transform');
  const group = page.locator('.group-frame[data-group-id="g1"]'), box = await group.boundingBox();
  if (method === 'alt') {
    await page.keyboard.down('Alt'); await drag(page, { x: box!.x + 14, y: box!.y + 16 }, { x: box!.x + 360, y: box!.y + 96 }); await page.keyboard.up('Alt');
  } else {
    await group.click({ position: { x: 14, y: 16 } });
    await expect(group).toHaveAttribute('aria-pressed', 'true');
    if (method === 'keyboard') { await page.keyboard.press('Control+c'); await page.keyboard.press('Control+v'); }
    else {
      await page.locator('.clipboard-actions').getByRole('button', { name: /^复制/u }).click();
      await page.locator('.clipboard-actions').getByRole('button', { name: /^粘贴/u }).click();
    }
  }
  await expect(page.locator('.group-frame')).toHaveCount(3); await expect(page.locator('.text-node-card')).toHaveCount(8);
  await expect(page.locator('.connection-junction')).toHaveCount(1); await expect(page.locator('.connection-junction')).toHaveAttribute('transform', original!);
  await expect(page.locator('.connection-hit-area')).toHaveCount(5);
  await page.keyboard.press('Control+z'); await expect(page.locator('.group-frame')).toHaveCount(2);
  await expect(page.locator('.connection-hit-area')).toHaveCount(4);
});
