import { expect, type Page, type Download } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { WorkspacePlanStep } from '../src/protocols/workspace-actions.ts';
import { parseProject } from '../src/plugins/import-export/codec.ts';
import { isRecord } from '../src/core/contracts.ts';
import { installLocalLanguageAssets } from '../e2e/helpers/local-language-assets.ts';
import type { Fixture } from './fixture.ts';
import type { LanguageCase } from './corpus.ts';

export interface UIObservation {
  zoom: number; selected: string[]; editors: string[]; regions: string[]; assistantCount: number;
  hand: boolean; map: boolean; immersive: boolean; preview: string; reply: string; status: string;
  editorWidth: number; selectionText: string;
  activeEditor?: string;
  groupCenterError?: Record<string, number>;
}
export interface Observation {
  id: string; phrase: string; variant: number; verdict: string; reason: string; durationMs: number;
  before?: UIObservation; after?: UIObservation; queries?: Record<string, unknown>;
  document?: Record<string, Record<string, unknown>>; downloads: Array<{ name: string; text?: string; bytes: number; header: string }>;
  blockedRequests: string[]; pageErrors: string[]; timedOut?: boolean; harnessError?: string;
  localAssetFiles: string[];
  sent?: boolean;
  initialVerdict?: string;
}

export async function panel(page: Page) {
  const current = page.getByRole('region', { name: '工作区动作', exact: true });
  if (await current.isVisible()) return current;
  if (await page.getByRole('region', { name: 'Echo-8 书库' }).isVisible()) await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
  if (await page.locator('.immersive-editor').isVisible()) await page.keyboard.press('Escape');
  const palette = page.getByRole('dialog', { name: '命令面板' });
  if (!await palette.isVisible()) {
    const button = page.getByRole('button', { name: '命令面板', exact: true });
    if (await button.count()) { await button.focus(); await button.press('Enter'); }
    else await page.keyboard.press('Control+k');
  }
  await palette.getByRole('textbox', { name: '搜索命令' }).fill('查看本地工作区动作');
  await palette.getByRole('option', { name: /查看本地工作区动作/u }).click();
  await expect(current).toBeVisible(); return current;
}

export async function fixed(page: Page, steps: WorkspacePlanStep[], copy = false) {
  const view = await panel(page);
  const id = 'probe-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  await view.getByRole('textbox', { name: '固定计划', exact: true }).fill(JSON.stringify({ version: 1, id, steps }));
  const download = copy ? page.waitForEvent('download', { predicate: item => item.suggestedFilename().endsWith('.e8'), timeout: 6000 }) : undefined;
  await view.getByRole('button', { name: '运行固定计划', exact: true }).click();
  await expect.poll(async () => {
    if (!await view.isVisible()) return true;
    return view.getByRole('button', { name: '运行固定计划', exact: true }).isEnabled().catch(() => true);
  }, { timeout: 6000 }).toBe(true);
  if (!await view.isVisible()) await panel(page);
  await expect(view.getByLabel('计划回执')).toContainText(id);
  const results: Record<string, unknown> = {};
  for (const entry of await view.locator('.workspace-action-receipt').all()) {
    const key = (await entry.locator('strong').first().textContent())!.split(' · ')[0]!;
    const raw = await entry.locator('pre').textContent();
    results[key] = raw?.trim() ? JSON.parse(raw) : undefined;
  }
  if (!download) return { results };
  const artifact = await download;
  const data = await readFile((await artifact.path())!);
  return { results, project: (await parseProject(new Blob([data]))).document.namespaces };
}

export async function observeUI(page: Page): Promise<UIObservation> {
  return page.evaluate(() => {
    const visible = (element: Element) => Boolean((element as HTMLElement).offsetWidth || (element as HTMLElement).offsetHeight || element.getClientRects().length);
    const titles = (selector: string) => Array.from(document.querySelectorAll(selector)).map(element => element.querySelector('strong')?.textContent?.trim() ?? '');
    const editors = Array.from(document.querySelectorAll('.editor-dock input[aria-label="节点标题"]')).map(element => (element as HTMLInputElement).value);
    const ai = Array.from(document.querySelectorAll('section[aria-label="AI 助手"]')).filter(visible);
    const replies = document.querySelectorAll('.ai-chat-bubble.assistant > p');
    const status = document.querySelector('.ai-status')?.textContent ?? '';
    const dock = document.querySelector('.editor-dock');
    const activeEditor = dock?.querySelector<HTMLInputElement>('.editor-pane.active input[aria-label="节点标题"]')?.value;
    const view = document.querySelector('.canvas-surface')?.getBoundingClientRect();
    const groupCenterError = Object.fromEntries(Array.from(document.querySelectorAll<HTMLElement>('.group-frame[data-group-id]')).flatMap(group => {
      if (!view || !group.dataset.groupId) return [];
      const bounds = group.getBoundingClientRect();
      return [[group.dataset.groupId, Math.hypot(bounds.x + bounds.width / 2 - view.x - view.width / 2,
        bounds.y + bounds.height / 2 - view.y - view.height / 2)] as const];
    }));
    return {
      zoom: Number((document.querySelector('.canvas-zoom-status input') as HTMLInputElement | null)?.value ?? 0) / 100,
      selected: titles('.text-node-card.selected'), editors,
      regions: Array.from(document.querySelectorAll('[aria-label]')).filter(element => visible(element) && ['SECTION', 'ASIDE'].includes(element.tagName))
        .map(element => element.getAttribute('aria-label')!),
      assistantCount: ai.length,
      hand: document.querySelector('button[aria-label^="手抓工具"]')?.getAttribute('aria-pressed') === 'true',
      map: Array.from(document.querySelectorAll('[aria-label="画布小地图"]')).some(visible),
      immersive: Array.from(document.querySelectorAll('[aria-label="沉浸式写作"]')).some(visible),
      preview: Array.from(document.querySelectorAll('[aria-label="画布操作计划"]')).filter(visible).map(element => element.textContent).join('\n'),
      reply: Array.from(replies).at(-1)?.textContent ?? '', status,
      editorWidth: dock?.getBoundingClientRect().width ?? 0, selectionText: window.getSelection()?.toString() ?? '',
      activeEditor, groupCenterError,
    };
  });
}

async function setup(page: Page, item: LanguageCase, fixture: Fixture) {
  const ids = (names: string[]) => names.map(name => fixture.ids[name]!);
  const steps: WorkspacePlanStep[] = [{ id: 'select', action: 'selection.set', arguments: { ids: ids(['主角']) } }];
  if (['layout'].includes(item.setup ?? '')) steps[0]!.arguments = { ids: ids(['空白1', '空白2', '线索']) };
  if (item.setup === 'blanks') steps[0]!.arguments = { ids: ids(['空白1', '空白2']) };
  if (item.setup === 'blank1') steps[0]!.arguments = { ids: ids(['空白1']) };
  if (item.setup === 'junction') steps[0]!.arguments = { ids: [fixture.junctionId!] };
  if (item.setup === 'map') steps.push({ id: 'map', action: 'minimap.open' });
  if (item.setup === 'zoom60') steps.push({ id: 'zoom', action: 'viewport.set', arguments: { zoom: 0.6 } });
  if (item.setup === 'palette') steps.push({ id: 'palette', action: 'palette.open' });
  if (item.setup === 'resized') steps.push({ id: 'resize', action: 'node.resize', arguments: { target: { id: fixture.ids['主角']! }, width: 600, height: 400 } });
  if (item.setup === 'clipboard') steps.push({ id: 'copy', action: 'clipboard.copy' });
  if (item.setup === 'annotation') steps.push({ id: 'annotation', action: 'annotation.open', arguments: { id: fixture.annotationId } });
  if (item.setup === 'search') {
    steps.push({ id: 'search', action: 'search.open' });
    steps.push({ id: 'query', action: 'search.run', arguments: { query: '旧案', scope: 'canvas', matchCase: false, wholeWord: false } });
  }
  if (item.setup === 'checkpoint') steps.push({ id: 'checkpoint', action: 'recovery.create', arguments: { label: '验收点' } });
  if (item.setup === 'undo' || item.setup === 'redo') steps.push({ id: 'temporary', action: 'node.create', arguments: { title: '临时卡', text: '撤销专用', x: 1200, y: 800 } });
  if (item.setup === 'export') steps.push({ id: 'export', action: 'file.exportText', arguments: { target: { id: fixture.ids['第一章']! } } });
  if (item.setup === 'shortcut') steps.push({ id: 'shortcut', action: 'shortcuts.set', arguments: { targetOwner: 'canvas', targetId: 'canvas.focus-selection-shortcut', chord: 'mod+alt+9' } });
  await fixed(page, steps);
  if (item.setup === 'redo') await fixed(page, [{ id: 'undo', action: 'history.undo' }]);
  const view = await panel(page); await view.getByRole('button', { name: '关闭工作区动作', exact: true }).click();
  await page.keyboard.press('Control+Shift+a');
  if (item.setup === 'sessions') await page.getByRole('button', { name: '新开独立 AI 助手', exact: true }).click();
  if (['editors', 'two-editors', 'immersive'].includes(item.setup ?? '')) {
    const titles = item.setup === 'two-editors' ? ['第一章', '主角'] : ['第一章', '主角', '反派'];
    const panes = page.locator('.editor-dock input[aria-label="节点标题"]');
    for (const [index, title] of titles.entries()) {
      // The visible editor owns this gesture. Opening the action panel again would close the panes.
      const card = page.getByRole('article', { name: new RegExp('文本节点：' + title + '$', 'u') });
      await card.getByRole('paragraph').dispatchEvent('dblclick', { shiftKey: index > 0 });
      await expect(panes).toHaveCount(index + 1);
      await expect(panes.nth(index)).toHaveValue(title);
    }
    if (item.setup === 'immersive') {
      await page.locator('.editor-pane.active').getByRole('button', { name: '进入沉浸式写作', exact: true }).click();
      await expect(page.getByRole('region', { name: '沉浸式写作' })).toBeVisible();
    }
  }
  if (item.setup === 'library') await fixed(page, [{ id: 'library', action: 'library.show' }]);
}

export async function exercise(page: Page, item: LanguageCase, phrase: string, variant: number, fixture: Fixture): Promise<Observation> {
  const started = Date.now(); const blockedRequests: string[] = []; const pageErrors: string[] = []; const downloads: Download[] = [];
  const localAssetFiles: string[] = [];
  const result: Observation = { id: item.id, phrase, variant, verdict: 'unverified', reason: '', durationMs: 0, downloads: [], blockedRequests, pageErrors, localAssetFiles };
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('download', download => downloads.push(download));
  await page.context().route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/cloud/status') return route.fulfill({ json: { configured: false, authenticated: false, accounts: [], installations: [] } });
    if (['http:', 'https:'].includes(url.protocol) && (url.origin !== 'http://localhost:3000' || url.pathname.startsWith('/api/'))) {
      blockedRequests.push(url.origin + url.pathname); return route.abort();
    }
    return route.continue();
  });
  await installLocalLanguageAssets(page, file => localAssetFiles.push(file));
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: undefined });
    Object.defineProperty(window, 'showOpenFilePicker', { configurable: true, value: undefined });
  });
  try {
    if (['editors', 'two-editors', 'immersive'].includes(item.setup ?? '')) await page.setViewportSize({ width: 1800, height: 900 });
    await page.goto('/');
    const library = page.getByRole('region', { name: 'Echo-8 书库' });
    await library.locator('input[type=file]').setInputFiles({ name: '自然语言隔离测试.e8', mimeType: 'application/octet-stream', buffer: fixture.bytes });
    await expect(library).toHaveCount(0);
    await setup(page, item, fixture);
    result.before = await observeUI(page);
    const composer = page.locator('.ai-composer textarea').last();
    await composer.fill(phrase, { timeout: 3000 }); await composer.press('Enter'); result.sent = true;
    try {
      await page.waitForFunction(() => {
        const fields = document.querySelectorAll('.ai-composer textarea');
        if (!fields.length) return true;
        const status = document.querySelector('.ai-status');
        const busy = status && /ai-status-(?:preparing|indexing|generating)/u.test(status.className);
        return !busy && Boolean(document.querySelector('.ai-chat-bubble.assistant, .ai-error, .ai-status-error, .ai-status-complete, [aria-label="画布操作计划"]'));
      }, undefined, { timeout: 8000 });
    } catch { result.timedOut = true; }
    if (item.oracle === 'editor-range') {
      // The editor applies a reveal on the next animation frame after receiving the request.
      await page.waitForFunction(() => Boolean(window.getSelection()?.toString()), undefined, { timeout: 1800 }).catch(() => {});
    }
    result.after = await observeUI(page);
    // Applying the owner's actual review is allowed only for utterances that request execution.
    if (!item.oracle.includes('preview') && !item.oracle.startsWith('combo-') && result.after.preview) {
      const apply = page.getByRole('button', { name: '应用整份计划', exact: true });
      if (await apply.isVisible()) { await apply.click(); await page.waitForTimeout(80); result.after = await observeUI(page); }
    }
    await page.waitForTimeout(100);
    for (const download of [...downloads]) {
      const file = await readFile((await download.path())!);
      result.downloads.push({ name: download.suggestedFilename(), bytes: file.length,
        header: file.subarray(0, 8).toString('hex'), ...(download.suggestedFilename().endsWith('.txt') ? { text: file.toString('utf8') } : {}) });
    }
    // Preserve the action observation before dismissing its modal for read-only probes.
    const colorPicker = page.getByRole('dialog', { name: '颜色选择器', exact: true });
    if (await colorPicker.isVisible()) await colorPicker.press('Escape');
    const probes: WorkspacePlanStep[] = [];
    const add = (id: string, action: string, args?: Record<string, unknown>) => probes.push({ id, action, arguments: args });
    if (['zoom60', 'zoom40', 'move', 'group-focus', 'focus-selection', 'view-restore'].includes(item.oracle)) add('camera', 'viewport.read');
    if (item.oracle.startsWith('clipboard')) add('clipboard', 'clipboard.read');
    if (['dark', 'eye-care', 'editor-color', 'reply-color'].includes(item.oracle)) add('appearance', 'appearance.read');
    if (['correction-off', 'completion-off'].includes(item.oracle)) add('correction', 'correction.settings');
    if (['autosave30'].includes(item.oracle)) add('preferences', 'persistence.preferences');
    if (item.oracle === 'checkpoint') add('checkpoints', 'recovery.list');
    if (['explicit-context', 'template', 'session-first'].includes(item.oracle)) add('assistant', 'assistant.state');
    if (item.id.startsWith('search.') && !item.oracle.startsWith('reply')) add('search', 'search.read');
    if (item.id.startsWith('shortcuts.')) add('shortcuts', 'shortcuts.read');
    if (item.oracle === 'font18' || item.oracle === 'bold4') {
      add('format', 'format.read', { target: { id: fixture.ids['第一章']! }, start: 0, length: 4 });
      add('outside', 'format.read', { target: { id: fixture.ids['第一章']! }, start: 8, length: 4 });
    }
    add('project', 'file.copy');
    const snapshot = await fixed(page, probes, true);
    result.queries = snapshot.results; result.document = snapshot.project;
  } catch (error) { result.harnessError = error instanceof Error ? error.message : String(error); }
  result.durationMs = Date.now() - started;
  return result;
}

export function records(document: Observation['document'], field: string): Record<string, unknown>[] {
  return Object.values(document?.[field] ?? {}).filter(isRecord);
}
export function body(document: Observation['document'], node: Record<string, unknown> | undefined): string {
  if (!node) return '';
  const content = document?.textContent?.[String(node.contentId)];
  if (!isRecord(content)) return '';
  return Array.isArray(content.chunkIds) ? content.chunkIds.map(id => {
    const chunk = document?.textContentChunk?.[String(id)]; return isRecord(chunk) ? String(chunk.text) : '';
  }).join('') : Array.isArray(content.chunks) ? content.chunks.join('') : '';
}
