import { expect, test, type Page } from '@playwright/test';
import { serializeProject } from '../src/plugins/import-export/codec.ts';
import { createContentStorage } from '../src/plugins/text-node/content-storage.ts';
import type { ProjectSource } from '../src/protocols/files.ts';

async function openGroups(page: Page, routedCopy = false, routedTitle = false, soleGroup = false) {
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
    for (const id of ['a', 'b']) namespaces.connections[id] = { id, from: { nodeId: id, side: routedTitle ? 'title' : 'right' }, to: { nodeId: 'j', kind: 'junction', side: 'left' }, revision: 1, createdAt: 1 };
    namespaces.connections.trunk = { id: 'trunk', from: { nodeId: 'j', kind: 'junction', side: 'right' }, to: { nodeId: 'c', side: routedTitle ? 'title' : 'left' }, revision: 1, createdAt: 1 };
    namespaces.connections.internal = { id: 'internal', from: { nodeId: 'a', side: 'right' }, to: { nodeId: 'b', side: 'left' }, revision: 1, createdAt: 1 };
  }
  if (soleGroup) namespaces.connections = { sole: { id: 'sole', from: { nodeId: 'j', kind: 'junction', side: 'right' },
    to: { nodeId: 'g2', kind: 'group', side: 'left' }, titleRoute: true, revision: 1, createdAt: 1 } };
  const blob = await serializeProject({ document: { revision: 1, namespaces }, plugins: [
    { id: 'text-node', version: '0.1.0', dataVersion: 2, namespaces: ['textNode', 'textContent', 'textContentChunk'], available: true },
    { id: 'groups', version: '0.1.0', dataVersion: 2, namespaces: ['groups'], available: true },
    { id: 'connections', version: '0.1.0', dataVersion: 8, namespaces: ['connections', 'connectionJunction'], available: true },
  ] });
  await page.getByRole('button', { name: '命令面板', exact: true }).click();
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

async function mixedPositions(page: Page): Promise<Record<string, number[]>> {
  const nodes = await page.locator('.text-node-card').evaluateAll(elements => Object.fromEntries(elements.map(element => {
    const title = element.querySelector('strong[title]')!.getAttribute('title')!;
    const transform = new DOMMatrix(getComputedStyle(element).transform);
    return [title, [transform.m41, transform.m42]];
  })));
  const point = (await page.locator('.connection-junction').getAttribute('transform'))!.match(/-?\d+(?:\.\d+)?/gu)!.map(Number);
  return { ...nodes, point };
}

test('double clicking a junction preserves automatic routing and positions while new links still preview', async ({ page }) => {
  await openGroups(page, true);
  const marker = page.locator('.connection-junction'), dot = marker.locator('.connection-junction-dot');
  const before = await mixedPositions(page);
  const paths = () => page.locator('.connection-hit-area').evaluateAll(elements => Object.fromEntries(elements.map(element => [element.getAttribute('data-connection-id'), element.getAttribute('d')])));
  const original = await paths();
  await dot.dblclick();
  await expect(marker).not.toHaveAttribute('data-handle-angle');
  await expect.poll(paths).toEqual(original);
  expect(await mixedPositions(page)).toEqual(before);
  await dot.dblclick();
  await expect(marker).not.toHaveAttribute('data-handle-angle');
  await expect.poll(paths).toEqual(original);
  const plus = await marker.getByRole('button', { name: '从中转点拉出连接线', exact: true }).boundingBox();
  const target = await page.getByRole('button', { name: '从群组测试c左侧连接', exact: true }).boundingBox();
  await page.mouse.move(plus!.x + plus!.width / 2, plus!.y + plus!.height / 2); await page.mouse.down();
  await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height / 2, { steps: 8 });
  const draft = page.locator('.connection-path.draft');
  await expect.poll(async () => {
    const p = (await draft.getAttribute('d'))!.match(/-?\d+(?:\.\d+)?/gu)!.map(Number);
    const trunk = (await page.locator('.connection-hit-area[data-connection-id="trunk"]').getAttribute('d'))!.match(/-?\d+(?:\.\d+)?/gu)!.map(Number);
    const a = [p[2] - p[0], p[3] - p[1]], b = [trunk[2] - trunk[0], trunk[3] - trunk[1]];
    return (a[0] * b[0] + a[1] * b[1]) / (Math.hypot(...a) * Math.hypot(...b));
  }).toBeCloseTo(1, 3);
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(draft).toHaveCount(0); await expect(page.locator('.connection-hit-area')).toHaveCount(4);
  expect(await mixedPositions(page)).toEqual(before);
});
for (const start of ['point', 'node', 'box', 'group']) test(`mixed selection moves nodes, a box, a group and a junction together when dragging the ${start}`, async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1100 });
  await openGroups(page, true);
  const group = page.locator('.group-frame[data-group-id="g1"]');
  await group.click({ position: { x: 12, y: 16 } });
  const node = page.locator('.text-node-card').filter({ has: page.locator('strong[title="群组测试e"]') });
  const box = page.locator('.text-node-card').filter({ has: page.locator('strong[title="群组测试f"]') });
  await node.locator('header strong').click({ modifiers: ['Shift'] });
  await box.locator('.text-box-title').click({ modifiers: ['Shift'] });
  const dot = page.locator('.connection-junction-dot'); await dot.click({ modifiers: ['Shift'] });
  await expect(group).toHaveAttribute('aria-pressed', 'true');
  await expect(group).toHaveCSS('outline-style', 'none');
  await expect(group).toHaveCSS('box-shadow', 'none');
  expect(await group.evaluate(element => {
    const frame = getComputedStyle(element, '::after');
    return { top: frame.top, right: frame.right, bottom: frame.bottom, left: frame.left, width: frame.borderTopWidth };
  })).toEqual({ top: '0px', right: '0px', bottom: '0px', left: '0px', width: '3px' });
  await expect(page.locator('.text-node-card.selected')).toHaveCount(2);
  await expect(page.locator('.connection-junction.selected')).toHaveCount(1);
  const before = await mixedPositions(page);
  const handle = start === 'point' ? dot : start === 'group' ? group : start === 'box' ? box.locator('.text-box-title') : node.locator('header strong');
  const rect = await handle.boundingBox();
  const from = start === 'group' ? { x: rect!.x + 12, y: rect!.y + 16 } : { x: rect!.x + rect!.width / 2, y: rect!.y + rect!.height / 2 };
  const clickCount = start === 'point' ? 2 : 1;
  await page.mouse.move(from.x, from.y); await page.mouse.down({ clickCount });
  await page.mouse.move(from.x + 120, from.y + 80, { steps: 10 });
  const movedTogether = async () => {
    const current = await mixedPositions(page), dx = current.point[0] - before.point[0], dy = current.point[1] - before.point[1];
    if (Math.abs(dx) < 60) return false;
    return ['a', 'b', 'e', 'f'].every(id => Math.abs(current[`群组测试${id}`][0] - before[`群组测试${id}`][0] - dx) < 1.5 &&
      Math.abs(current[`群组测试${id}`][1] - before[`群组测试${id}`][1] - dy) < 1.5);
  };
  await expect.poll(movedTogether).toBe(true);
  const preview = await mixedPositions(page);
  const previewCurves = await page.locator('.connection-hit-area').evaluateAll(elements => Object.fromEntries(elements.map(e => [e.getAttribute('data-connection-id'), e.getAttribute('d')])));
  await page.mouse.up({ clickCount }); await expect.poll(() => mixedPositions(page)).toEqual(preview);
  const committedCurves = await page.evaluate(async () => {
    const samples: Record<string, string | null>[] = [];
    for (let i = 0; i < 24; i++) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      samples.push(Object.fromEntries([...document.querySelectorAll('.connection-hit-area')].map(e => [e.getAttribute('data-connection-id')!, e.getAttribute('d')])));
    }
    return samples;
  });
  for (const sample of committedCurves) expect(sample).toEqual(previewCurves);
  await expect(page.locator('.connection-junction')).not.toHaveAttribute('data-handle-angle');
  expect(preview['群组测试c']).toEqual(before['群组测试c']); expect(preview['群组测试d']).toEqual(before['群组测试d']);
  await page.keyboard.press('Control+z'); await expect.poll(() => mixedPositions(page)).toEqual(before);
  await page.keyboard.press('Control+Shift+z'); await expect.poll(() => mixedPositions(page)).toEqual(preview);
  await page.keyboard.press('Control+z'); await expect.poll(() => mixedPositions(page)).toEqual(before);
  const restored = await handle.boundingBox();
  const cancelFrom = start === 'group' ? { x: restored!.x + 12, y: restored!.y + 16 } : { x: restored!.x + restored!.width / 2, y: restored!.y + restored!.height / 2 };
  await page.mouse.move(cancelFrom.x, cancelFrom.y); await page.mouse.down(); await page.mouse.move(cancelFrom.x + 70, cancelFrom.y + 60, { steps: 6 });
  await page.keyboard.press('Escape'); await page.mouse.up(); await expect.poll(() => mixedPositions(page)).toEqual(before);
  if (start === 'point') {
    for (let i = 0; i < 3; i++) {
      const current = await dot.boundingBox(), center = { x: current!.x + current!.width / 2, y: current!.y + current!.height / 2 };
      const marker = page.locator('.connection-junction');
      await marker.evaluate(element => element.addEventListener('pointerdown', event => element.setAttribute('data-test-pointer', String((event as PointerEvent).pointerId)), { once: true }));
      await page.mouse.move(center.x, center.y); await page.mouse.down();
      await marker.dispatchEvent('pointerup', { pointerId: Number(await marker.getAttribute('data-test-pointer')), clientX: center.x + 70, clientY: center.y + 50, button: 0 });
      await page.mouse.up(); await expect.poll(movedTogether).toBe(true);
    }
    for (let i = 0; i < 3; i++) await page.keyboard.press('Control+z');
    await expect.poll(() => mixedPositions(page)).toEqual(before);
  }
});

test('reconnecting the only dashed group edge keeps its junction line type and updates in place', async ({ page }) => {
  await openGroups(page, true, true, true);
  const edge = page.locator('.connection-hit-area[data-connection-id="sole"]');
  const initial = await edge.getAttribute('d');
  const arrow = await page.locator('[data-arrow-for="sole"]').boundingBox();
  const target = await port(page, 'g1', 'right');
  await page.mouse.move(arrow!.x + arrow!.width / 2, arrow!.y + arrow!.height / 2); await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 10 });
  await expect(page.locator('.connection-layer')).toHaveAttribute('data-reconnecting-id', 'sole');
  await expect(edge).not.toHaveAttribute('d', initial!);
  await expect(page.locator('.connection-path.title-connection')).toHaveCount(1);
  await page.mouse.up();
  await expect(page.locator('.connection-layer')).not.toHaveAttribute('data-reconnecting-id');
  await expect(page.locator('.connection-hit-area')).toHaveCount(1);
  await expect(page.locator('.connection-path.title-connection')).toHaveCount(1);
  await page.keyboard.press('Control+z'); await expect(edge).toHaveAttribute('d', initial!);
});

for (const title of [false, true]) for (const kind of ['group', 'box']) test(`${kind} drags adopt the junction ${title ? 'dashed' : 'solid'} style during preview and commit in both directions`, async ({ page }) => {
  await openGroups(page, true, title);
  const marker = page.locator('.connection-junction');
  for (const reversed of [false, true]) {
    const point = await marker.locator('.connection-junction-dot').boundingBox();
    const pointPosition = { x: point!.x + point!.width / 2, y: point!.y + point!.height / 2 };
    let from, to;
    if (!reversed) {
      if (kind === 'group') from = await port(page, 'g1', 'right');
      else {
        const boxPort = await page.getByRole('button', { name: '从群组测试f右侧连接', exact: true }).boundingBox();
        from = { x: boxPort!.x + boxPort!.width / 2, y: boxPort!.y + boxPort!.height / 2 };
      }
      to = pointPosition;
    } else {
      await page.mouse.move(pointPosition.x, pointPosition.y);
      const plus = await marker.getByRole('button', { name: '从中转点拉出连接线', exact: true }).boundingBox();
      from = { x: plus!.x + plus!.width / 2, y: plus!.y + plus!.height / 2 };
      if (kind === 'group') to = await port(page, 'g1', 'right');
      else {
        const box = await page.locator('.text-node-card.text-box').boundingBox();
        to = { x: box!.x + box!.width - 4, y: box!.y + box!.height * (title ? .75 : .2) };
      }
    }
    await page.mouse.move(from.x, from.y); await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 10 });
    const draft = page.locator('.connection-path.draft');
    if (title) await expect(draft).toHaveClass(/title-connection/u);
    else await expect(draft).not.toHaveClass(/title-connection/u);
    if (kind === 'group' && !reversed) {
      const control = page.locator('.group-frame[data-group-id="g1"] .group-connection-port.right');
      await expect(control).toHaveCSS('outline-style', 'none'); await expect(control).toHaveCSS('box-shadow', 'none');
    }
    await page.mouse.up(); await expect(page.locator('.connection-hit-area')).toHaveCount(5);
    await expect(page.locator('.connection-path:not(.draft).title-connection')).toHaveCount(title ? 4 : 0);
    await page.keyboard.press('Control+z'); await expect(page.locator('.connection-hit-area')).toHaveCount(4);
  }
});

test('dragging a routed group leaves its point fixed during preview, commit and undo', async ({ page }) => {
  await openGroups(page, true);
  const marker = page.locator('.connection-junction'), initial = await marker.getAttribute('transform');
  const group = page.locator('.group-frame[data-group-id="g1"]'), box = await group.boundingBox();
  await page.mouse.move(box!.x + 12, box!.y + 16); await page.mouse.down();
  await page.mouse.move(box!.x + 112, box!.y + 116, { steps: 8 });
  await expect(marker).toHaveAttribute('transform', initial!);
  await page.mouse.up(); await expect(marker).toHaveAttribute('transform', initial!);
  await page.keyboard.press('Control+z'); await expect(marker).toHaveAttribute('transform', initial!);
});

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

for (const side of ['左', '右']) test(`title ${side} port stays chosen through preview and commit, then selects the current side beyond the alignment band and undo`, async ({ page }) => {
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
  await expect.poll(async () => (await read())[6]).toBe(980);
  const moved = await read();
  expect(Math.sign(moved[2] - moved[0])).toBe(1);
  expect(moved[6]).toBe(980); expect(Math.sign(moved[4] - moved[6])).toBe(1);
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

for (const zoom of [40, 100]) test(`group source and target ports retain expanded screen hit areas at ${zoom}% zoom`, async ({ page }) => {
  await openGroups(page);
  await expect(page.getByRole('region', { name: 'Echo-8 书库' })).toBeHidden();
  const input = page.locator('.canvas-zoom-status input');
  const setZoom = async (value: number) => {
    await input.fill(String(value)); await input.press('Enter');
    for (const world of ['.group-world', '.canvas-world']) await expect.poll(() => page.locator(world).first().evaluate(e => new DOMMatrix(getComputedStyle(e).transform).a)).toBe(value / 100);
  };
  await setZoom(zoom);
  const from = page.locator('.group-frame[data-group-id="g1"] .group-connection-port.right');
  const to = page.locator('.group-frame[data-group-id="g2"] .group-connection-port.left');
  await expect(from).toBeVisible(); await expect(to).toBeVisible();
  const a = await from.boundingBox(), b = await to.boundingBox();
  expect(a!.width).toBeCloseTo(48); expect(a!.height).toBeCloseTo(64);
  expect(b!.width).toBeCloseTo(48); expect(b!.height).toBeCloseTo(64);
  await drag(page, { x: a!.x + a!.width / 2 + 20, y: a!.y + a!.height / 2 + 24 }, { x: b!.x + b!.width / 2 - 20, y: b!.y + b!.height / 2 + 24 });
  await setZoom(100);
  await expect(page.locator('.connection-hit-area')).toHaveCount(1);
  await expect(page.locator('.connection-path:not(.draft)')).not.toHaveClass(/title-connection/u);
  await page.keyboard.press('Control+z'); await expect(page.locator('.connection-hit-area')).toHaveCount(0);
  await setZoom(zoom);
  const nodePort = await page.getByRole('button', { name: '从群组测试e右侧连接', exact: true }).boundingBox();
  const targetPort = await to.boundingBox();
  await drag(page, { x: nodePort!.x + nodePort!.width / 2, y: nodePort!.y + nodePort!.height / 2 },
    { x: targetPort!.x + targetPort!.width / 2 - 20, y: targetPort!.y + targetPort!.height / 2 + 24 });
  await setZoom(100);
  await expect(page.locator('.connection-hit-area')).toHaveCount(1);
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
