import { expect, test, type Page } from '@playwright/test';
import type { DomainSnapshot } from '../src/core/contracts.ts';
import { createContentStorage } from '../src/plugins/text-node/content-storage.ts';
import { serializeProject } from '../src/plugins/import-export/codec.ts';
import type { ProjectSource } from '../src/protocols/files.ts';

const NODE_COUNT = 2_000;
const HUGE_TEXT_LENGTH = 20_000_000;
const OPEN_BUDGET_MS = 15_000;
const FULL_SELECTION_BUDGET_MS = 5_000;
const EDITOR_BUDGET_MS = 5_000;

test('a real browser opens, culls and edits the supported extreme canvas envelopes', async ({ page }) => {
  test.setTimeout(120_000);
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(message.text());
  });

  const project = await createExtremeProject();
  await openApplication(page);
  const openedAt = performance.now();
  await openProjectBlob(page, project);
  const hugeNode = page.getByRole('article', { name: '文本节点：浏览器极限节点 0000' });
  await expect(hugeNode).toBeVisible({ timeout: OPEN_BUDGET_MS });
  const openMs = performance.now() - openedAt;
  expect(openMs).toBeLessThan(OPEN_BUDGET_MS);

  const ordinaryVisibleCards = await page.getByRole('article', { name: /文本节点：/u }).count();
  expect(ordinaryVisibleCards).toBeLessThan(200);

  const selectedAt = performance.now();
  const canvas = page.getByLabel('Echo-8 无限画布');
  await canvas.click({ position: { x: 8, y: 8 } });
  await page.keyboard.press('Control+a');
  await expect(page.locator('[data-canvas-selection-count]')).toHaveAttribute(
    'data-canvas-selection-count',
    String(NODE_COUNT),
    {
      timeout: FULL_SELECTION_BUDGET_MS,
    },
  );
  await expect(page.locator('[data-canvas-selection-count]')).toContainText('已选择 2,000 个画布项目');
  const mountedAfterFullSelection = await page.getByRole('article', { name: /文本节点：/u }).count();
  expect(mountedAfterFullSelection).toBeLessThan(200);
  await expect(page.getByRole('article', { name: /已选中，文本节点：/u })).toHaveCount(
    mountedAfterFullSelection,
    {
      timeout: FULL_SELECTION_BUDGET_MS,
    },
  );
  expect(performance.now() - selectedAt).toBeLessThan(FULL_SELECTION_BUDGET_MS);

  await canvas.click({ position: { x: 8, y: 8 } });
  await expect(page.locator('[data-canvas-selection-count]')).toHaveAttribute('data-canvas-selection-count', '0');
  await expect(page.getByRole('article', { name: /已选中，文本节点：/u })).toHaveCount(0);
  await hugeNode.click();
  await expect(page.getByRole('article', { name: /已选中，文本节点：/u })).toHaveCount(1);
  const editorAt = performance.now();
  await hugeNode.dblclick();
  const editor = page.locator('.editor-writing-area').first();
  await expect(editor).toBeVisible({ timeout: EDITOR_BUDGET_MS });
  expect(performance.now() - editorAt).toBeLessThan(EDITOR_BUDGET_MS);
  await editor.focus();
  const inputAt = performance.now();
  await page.keyboard.insertText('可编辑');
  await expect(editor).toContainText('可编辑');
  expect(performance.now() - inputAt).toBeLessThan(EDITOR_BUDGET_MS);
  const editorMetrics = page.locator('.editor-metrics').first();
  await expect(editorMetrics).not.toContainText('统计中', { timeout: OPEN_BUDGET_MS });
  const editorCount = (await editorMetrics.textContent())?.match(/字数\s+([\d,]+)/u)?.[1];
  expect(editorCount).toBeTruthy();
  await expect(page.locator('.toolbar-statistics')).toContainText(`/ ${editorCount}`, {
    timeout: OPEN_BUDGET_MS,
  });
  expect(failures).toEqual([]);
});

async function openApplication(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showOpenFilePicker', {
      configurable: true,
      value: undefined,
    });
  });
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Echo-8 书库' })).toBeVisible();
  await page.getByRole('button', { name: '新建空白书籍' }).click();
  await expect(page.getByRole('article', { name: /文本节点：/u })).toHaveCount(2);
}

async function openProjectBlob(page: Page, project: Blob): Promise<void> {
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: '命令面板' });
  await expect(palette).toBeVisible();
  await palette.getByRole('textbox', { name: '搜索命令' }).fill('打开书籍');
  await palette.getByRole('option', { name: /^打开书籍/u }).click();
  const notice = page.getByRole('status').filter({ hasText: '当前书籍还有未保存修改' });
  await expect(notice).toBeVisible();
  const chooserPromise = page.waitForEvent('filechooser');
  await notice.getByRole('button', { name: '不保存，继续选择书籍' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: '浏览器极限测试.echo8',
    mimeType: project.type,
    buffer: Buffer.from(await project.arrayBuffer()),
  });
  await expect(notice).toHaveCount(0, { timeout: OPEN_BUDGET_MS });
}

async function createExtremeProject(): Promise<Blob> {
  const namespaces: DomainSnapshot['namespaces'] = {
    textNode: {},
    textContent: {},
    textContentChunk: {},
  };
  const hugeBody = repeatedText(
    'Browser performance paragraph 0123456789 '.padEnd(1_999, 'x') + '\n',
    HUGE_TEXT_LENGTH,
  );
  for (let index = 0; index < NODE_COUNT; index += 1) {
    const suffix = String(index).padStart(4, '0');
    const nodeId = `browser-node-${suffix}`;
    const contentId = `browser-content-${suffix}`;
    const body = index === 0 ? hugeBody : `浏览器压力正文 ${suffix}`;
    const storage = createContentStorage(contentId, body, 1);
    namespaces.textContent[contentId] = storage.content;
    for (const patch of storage.chunkPatches) {
      if (patch.op === 'set') namespaces.textContentChunk[patch.key] = patch.value;
    }
    namespaces.textNode[nodeId] = {
      id: nodeId,
      contentId,
      title: index === 0 ? '浏览器极限节点 0000' : `浏览器压力节点 ${suffix}`,
      x: 160 + (index % 50) * 360,
      y: 130 + Math.floor(index / 50) * 230,
      width: 280,
      height: 190,
      titleColor: index % 2 === 0 ? '#202124' : '#374151',
      revision: 1,
      createdAt: index + 1,
      updatedAt: index + 1,
    };
  }
  const source: ProjectSource = {
    document: { revision: 1, namespaces },
    history: { undo: [], redo: [] },
    plugins: [
      {
        id: 'text-node',
        version: '0.1.0',
        namespaces: ['textNode', 'textContent', 'textContentChunk'],
        available: true,
      },
    ],
  };
  return serializeProject(source);
}

function repeatedText(pattern: string, length: number): string {
  return pattern.repeat(Math.ceil(length / pattern.length)).slice(0, length);
}
