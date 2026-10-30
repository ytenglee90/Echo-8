import { expect, test, type Locator, type Page } from '@playwright/test';
import { serializeProject } from '../src/plugins/import-export/codec.ts';
import type { ProjectSource } from '../src/protocols/files.ts';

async function openApplication(page: Page): Promise<void> {
  await page.goto('/');
  const library = page.getByRole('region', { name: 'Echo-8 书库' });
  await expect(library).toBeVisible();
  await library.press('Escape');
  await expect(page.getByRole('article', { name: /文本节点：/u })).toHaveCount(2);
}

async function executeCommand(page: Page, label: string): Promise<void> {
  const commandButton = page.getByRole('button', { name: '命令面板' });
  await expect(commandButton).toBeVisible();
  await commandButton.focus();
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: '命令面板' });
  await expect(palette).toBeVisible();
  await palette.getByRole('textbox', { name: '搜索命令' }).fill(label);
  await palette.getByRole('option', { name: new RegExp(`^${label}`, 'u') }).click();
}

function connectionArrowScreenMetrics(element: Element): { length: number; width: number } {
  const path = element as SVGPathElement;
  const coordinates = path.getAttribute('d')?.match(/-?\d+(?:\.\d+)?/gu)?.map(Number) ?? [];
  const matrix = path.getScreenCTM();
  if (coordinates.length < 6 || !matrix) throw new Error('连接箭头尚未进入可见画布');
  const wingA = new DOMPoint(coordinates.at(-6)!, coordinates.at(-5)!).matrixTransform(matrix);
  const tip = new DOMPoint(coordinates.at(-4)!, coordinates.at(-3)!).matrixTransform(matrix);
  const wingB = new DOMPoint(coordinates.at(-2)!, coordinates.at(-1)!).matrixTransform(matrix);
  const base = { x: (wingA.x + wingB.x) / 2, y: (wingA.y + wingB.y) / 2 };
  return {
    length: Math.hypot(tip.x - base.x, tip.y - base.y),
    width: Math.hypot(wingA.x - wingB.x, wingA.y - wingB.y),
  };
}

async function selectedNodeOverlayStyle(node: Locator): Promise<{
  borderColor: string;
  borderRadius: string;
  borderWidth: string;
  inset: string;
  pointerEvents: string;
}> {
  return node.evaluate((element) => {
    const style = getComputedStyle(element, '::after');
    return {
      borderColor: style.borderTopColor,
      borderRadius: style.borderRadius,
      borderWidth: style.borderTopWidth,
      inset: `${style.top} ${style.right} ${style.bottom} ${style.left}`,
      pointerEvents: style.pointerEvents,
    };
  });
}

function connectionStrokeScreenWidth(element: Element): number {
  const path = element as SVGPathElement;
  const matrix = path.getScreenCTM();
  if (!matrix) throw new Error('连接线尚未进入可见画布');
  return Number.parseFloat(getComputedStyle(path).strokeWidth) * Math.hypot(matrix.a, matrix.b);
}

function connectionLabelScreenMetrics(element: Element): {
  borderWidth: number;
  fontSize: number;
  height: number;
  width: number;
} {
  if (!(element instanceof HTMLElement)) throw new Error('连接文字尚未进入可见画布');
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  const screenScale = rect.width / Math.max(1, element.offsetWidth);
  return {
    borderWidth: Number.parseFloat(style.borderTopWidth) * screenScale,
    fontSize: Number.parseFloat(style.fontSize) * screenScale,
    height: rect.height,
    width: rect.width,
  };
}

async function beginSyntheticComposition(target: Locator, value: string): Promise<void> {
  await target.evaluate((element, next) => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const prototype = element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, next);
    } else {
      element.textContent = next;
    }
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      composed: true,
      data: next,
      inputType: 'insertCompositionText',
      isComposing: true,
    }));
  }, value);
}

async function endSyntheticComposition(target: Locator, value: string): Promise<void> {
  await target.evaluate((element, next) => {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const prototype = element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, next);
    } else {
      element.textContent = next;
    }
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: next }));
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      composed: true,
      data: next,
      inputType: 'insertText',
    }));
  }, value);
}

interface AnnotationMotionProbe {
  before: number[];
  minimum: number[];
  latest: number[];
  frames: number;
}

async function startAnnotationMotionProbe(page: Page, selector: string, key: string): Promise<void> {
  await page.evaluate(({ markerSelector, probeKey }) => {
    const markers = [...document.querySelectorAll<HTMLElement>(markerSelector)];
    const before = markers.map((marker) => marker.getBoundingClientRect().x);
    const state: AnnotationMotionProbe & { until: number } = {
      before,
      minimum: [...before],
      latest: [...before],
      frames: 0,
      until: performance.now() + 1_000,
    };
    Reflect.set(globalThis, probeKey, state);
    const sample = () => {
      state.frames += 1;
      state.latest = markers.map((marker) => marker.getBoundingClientRect().x);
      state.minimum = state.minimum.map((value, index) => Math.min(value, state.latest[index] ?? value));
      if (performance.now() < state.until) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, { markerSelector: selector, probeKey: key });
}

async function readAnnotationMotionProbe(page: Page, key: string): Promise<AnnotationMotionProbe> {
  return page.evaluate((probeKey) => Reflect.get(globalThis, probeKey) as AnnotationMotionProbe, key);
}

async function selectEditorRange(editor: Locator, start: number, end = start): Promise<void> {
  await editor.evaluate((element, input) => {
    const root = element as HTMLElement;
    const locate = (offset: number) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let remaining = offset;
      let node = walker.nextNode();
      while (node) {
        const length = node.textContent?.length ?? 0;
        if (remaining <= length) return { node, offset: remaining };
        remaining -= length;
        node = walker.nextNode();
      }
      return { node: root, offset: root.childNodes.length };
    };
    root.focus({ preventScroll: true });
    const from = locate(input.start);
    const to = locate(input.end);
    const range = document.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    root.dispatchEvent(new Event('select', { bubbles: true }));
    root.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  }, { start, end });
}

type ClipboardEntries = Array<[string, string]>;

async function dispatchEditorClipboard(
  editor: Locator,
  type: 'copy' | 'cut' | 'paste',
  entries: ClipboardEntries = [],
): Promise<ClipboardEntries> {
  return editor.evaluate((element, input) => {
    const transfer = new DataTransfer();
    for (const [mime, value] of input.entries) transfer.setData(mime, value);
    const event = new Event(input.type, {
      bubbles: true,
      cancelable: true,
    });
    // Gecko ignores the ClipboardEventInit clipboardData value for synthetic
    // events; an own property keeps the same controlled event path testable.
    Object.defineProperty(event, 'clipboardData', { value: transfer });
    element.dispatchEvent(event);
    return Array.from(transfer.types, (mime) => [mime, transfer.getData(mime)] as [string, string]);
  }, { type, entries });
}

async function readEditorSelection(editor: Locator): Promise<{ start: number; end: number }> {
  return editor.evaluate((element) => {
    const root = element as HTMLElement;
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0) return { start: -1, end: -1 };
    const selected = selection.getRangeAt(0);
    const offset = (node: Node, position: number) => {
      const range = document.createRange();
      range.selectNodeContents(root);
      range.setEnd(node, position);
      return range.toString().length;
    };
    return {
      start: offset(selected.startContainer, selected.startOffset),
      end: offset(selected.endContainer, selected.endOffset),
    };
  });
}

async function dragEditorSelection(
  editor: Locator,
  start: number,
  end: number,
  target: number,
): Promise<void> {
  await editor.evaluate((element, input) => {
    const root = element as HTMLElement;
    root.focus({ preventScroll: true });
    const locate = (offset: number) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let remaining = offset;
      let node = walker.nextNode();
      while (node) {
        const length = node.textContent?.length ?? 0;
        if (remaining <= length) return { node, offset: remaining };
        remaining -= length;
        node = walker.nextNode();
      }
      return { node: root, offset: root.childNodes.length };
    };
    const sourceStart = locate(input.start);
    const sourceEnd = locate(input.end);
    const selection = document.getSelection();
    const sourceRange = document.createRange();
    sourceRange.setStart(sourceStart.node, sourceStart.offset);
    sourceRange.setEnd(sourceEnd.node, sourceEnd.offset);
    selection?.removeAllRanges();
    selection?.addRange(sourceRange);
    const transfer = new DataTransfer();
    root.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));

    const targetStart = locate(input.target);
    const targetEnd = locate(Math.min(root.textContent?.length ?? input.target, input.target + 1));
    const targetRange = document.createRange();
    targetRange.setStart(targetStart.node, targetStart.offset);
    targetRange.setEnd(targetEnd.node, targetEnd.offset);
    const rect = targetRange.getBoundingClientRect();
    const clientX = input.target === 0 ? rect.left - 1 : rect.left + Math.min(1, rect.width / 2);
    const clientY = rect.top + Math.max(1, rect.height / 2);
    root.dispatchEvent(new DragEvent('dragover', {
      bubbles: true, cancelable: true, dataTransfer: transfer, clientX, clientY,
    }));
    root.dispatchEvent(new DragEvent('drop', {
      bubbles: true, cancelable: true, dataTransfer: transfer, clientX, clientY,
    }));
    // Emulate engines which still mutate the source contenteditable after a
    // controlled drop. The editor must restore its projection and must not
    // publish this as a second durable edit.
    root.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true, cancelable: true, inputType: 'deleteByDrag',
    }));
    root.textContent = (root.textContent ?? '').slice(1);
    root.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteByDrag' }));
    root.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
  }, { start, end, target });
}

async function dragEditorSelectionOutside(
  editor: Locator,
  start: number,
  end: number,
  targetSelector: string,
): Promise<string | undefined> {
  return editor.evaluate(async (element, input) => {
    const root = element as HTMLElement;
    root.focus({ preventScroll: true });
    const target = document.querySelector<HTMLElement>(input.targetSelector);
    if (!target) throw new Error(`Missing drop target: ${input.targetSelector}`);
    const locate = (offset: number) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let remaining = offset;
      let node = walker.nextNode();
      while (node) {
        const length = node.textContent?.length ?? 0;
        if (remaining <= length) return { node, offset: remaining };
        remaining -= length;
        node = walker.nextNode();
      }
      return { node: root, offset: root.childNodes.length };
    };
    const sourceStart = locate(input.start);
    const sourceEnd = locate(input.end);
    const sourceRange = document.createRange();
    sourceRange.setStart(sourceStart.node, sourceStart.offset);
    sourceRange.setEnd(sourceEnd.node, sourceEnd.offset);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(sourceRange);
    const transfer = new DataTransfer();
    root.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    const rect = target.getBoundingClientRect();
    const clientX = rect.left + rect.width / 2;
    const clientY = rect.top + rect.height / 2;
    target.dispatchEvent(new DragEvent('dragenter', {
      bubbles: true, cancelable: true, dataTransfer: transfer, clientX, clientY,
    }));
    let dropHint: string | undefined;
    for (let frame = 0; frame < 6 && !dropHint; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      dropHint = target.querySelector<HTMLElement>('.canvas-document-drop-hint button')
        ?.getAttribute('aria-label') ?? undefined;
    }
    target.dispatchEvent(new DragEvent('dragover', {
      bubbles: true, cancelable: true, dataTransfer: transfer, clientX, clientY,
    }));
    target.dispatchEvent(new DragEvent('drop', {
      bubbles: true, cancelable: true, dataTransfer: transfer, clientX, clientY,
    }));
    const dropped = transfer.getData('text/plain');
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
      const valueSetter = Object.getOwnPropertyDescriptor(
        target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
        'value',
      )?.set;
      valueSetter?.call(target, dropped);
      target.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        data: dropped,
        inputType: 'insertFromDrop',
      }));
    }
    root.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true, cancelable: true, inputType: 'deleteByDrag',
    }));
    root.textContent = `${root.textContent?.slice(0, input.start) ?? ''}${root.textContent?.slice(input.end) ?? ''}`;
    root.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteByDrag' }));
    root.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
    return dropHint;
  }, { start, end, targetSelector });
}

test('book library switches books without the in-canvas unsaved confirmation', async ({ page }, testInfo) => {
  const targetBlob = await serializeProject({
    document: { revision: 0, namespaces: {} },
    history: { undo: [], redo: [] },
    plugins: [],
  } satisfies ProjectSource);
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showOpenFilePicker', { configurable: true, value: undefined });
    const runtimeWindow = window as typeof window & {
      __echo8BootMotion?: string;
      __echo8BootUnderline?: string;
    };
    const observeBoot = () => {
      const root = document.documentElement;
      if (!root) {
        requestAnimationFrame(observeBoot);
        return;
      }
      const inspect = () => {
        const mark = document.querySelector('.boot-screen .brand-loading-mark .echo-8-processing-mark');
        if (!(mark instanceof HTMLElement || mark instanceof SVGElement)) return;
        runtimeWindow.__echo8BootMotion = getComputedStyle(mark).animationName;
        const loadingMark = mark.closest('.brand-loading-mark');
        runtimeWindow.__echo8BootUnderline = loadingMark
          ? getComputedStyle(loadingMark, '::after').content
          : 'missing';
        observer.disconnect();
      };
      const observer = new MutationObserver(inspect);
      observer.observe(root, { childList: true, subtree: true });
      inspect();
    };
    observeBoot();
  });
  await page.goto('/');
  const library = page.getByRole('region', { name: 'Echo-8 书库' });
  const unsavedNotice = page.getByRole('status').filter({ hasText: '当前书籍还有未保存修改' });
  await expect(library).toBeVisible();
  expect(await page.evaluate(() => (
    window as typeof window & { __echo8BootMotion?: string }
  ).__echo8BootMotion)).toContain('echo-8-brand-breathe');
  expect(await page.evaluate(() => (
    window as typeof window & { __echo8BootUnderline?: string }
  ).__echo8BootUnderline)).toBe('none');
  await expect(library.getByRole('heading', { name: '今天想打开哪一本？' })).toHaveCount(0);
  const libraryMark = library.locator('.book-library-brand [data-icon="echo-8"]');
  await expect(libraryMark).toBeVisible();
  const libraryMarkVisual = await libraryMark.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      mask: style.getPropertyValue('mask-image') || style.getPropertyValue('-webkit-mask-image'),
      fill: style.backgroundColor,
      ink: style.color,
    };
  });
  expect(libraryMarkVisual).toMatchObject({
    fill: 'rgb(24, 24, 26)',
    ink: 'rgb(24, 24, 26)',
  });
  expect(libraryMarkVisual.mask).toContain('/favicon.svg');
  const libraryMarkBox = await libraryMark.boundingBox();
  expect(libraryMarkBox).not.toBeNull();
  expect(libraryMarkBox!.width / libraryMarkBox!.height).toBeGreaterThan(2.2);
  const libraryMarkAlpha = await libraryMark.evaluate(async () => {
    const image = new Image();
    image.src = '/favicon.svg';
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    context?.drawImage(image, 0, 0);
    return {
      outer: context?.getImageData(0, 0, 1, 1).data[3] ?? 255,
      body: context?.getImageData(30, 30, 1, 1).data[3] ?? 0,
      channel: context?.getImageData(100, 80, 1, 1).data[3] ?? 255,
    };
  });
  expect(libraryMarkAlpha).toMatchObject({ outer: 0, body: 255 });
  // Gecko's offscreen SVG decoder reports luminance-mask cutouts as opaque,
  // although the actual CSS mask remains transparent and is snapshot-tested.
  if (testInfo.project.name !== 'firefox') expect(libraryMarkAlpha.channel).toBe(0);
  await expect(library.locator('#cloud-books-title')).toHaveClass('sr-only');
  await expect(library.getByRole('button', { name: /新建空白书籍/u })).toBeVisible();
  await expect(library.getByRole('button', { name: /打开本地书籍/u })).toBeVisible();
  await expect(library.getByRole('button', { name: '继续当前浏览器中的画布' })).toHaveCount(0);
  await expect(library.locator('.book-library-action-card')).toHaveCount(2);
  if (testInfo.project.name === 'chromium') {
    await expect(page).toHaveScreenshot('book-library-home.png', {
      animations: 'disabled',
      caret: 'hide',
    });
  }
  await library.getByRole('button', { name: /新建空白书籍/u }).click();
  await expect(library).toHaveCount(0);
  await expect(unsavedNotice).toHaveCount(0);

  await executeCommand(page, '返回首页（书库）');
  await expect(library).toBeVisible();
  const chooserPromise = page.waitForEvent('filechooser');
  await library.getByRole('button', { name: /打开本地书籍/u }).click();
  const chooser = await chooserPromise;
  await expect(unsavedNotice).toHaveCount(0);
  const transitionSeen = page.evaluate(() => new Promise<string>((resolve) => {
    const inspect = () => {
      const mark = document.querySelector('.book-library-opening .brand-loading-mark .echo-8-processing-mark');
      if (!(mark instanceof HTMLElement || mark instanceof SVGElement)) return;
      observer.disconnect();
      resolve(getComputedStyle(mark).animationName);
    };
    const observer = new MutationObserver(inspect);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    inspect();
    setTimeout(() => {
      observer.disconnect();
      resolve('not-seen');
    }, 10_000);
  }));
  await chooser.setFiles({
    name: '从书库打开.echo8',
    mimeType: targetBlob.type,
    buffer: Buffer.from(await targetBlob.arrayBuffer()),
  });
  expect(await transitionSeen).toContain('echo-8-brand-breathe');
  await expect(library).toHaveCount(0, { timeout: 15_000 });
  await expect(unsavedNotice).toHaveCount(0);
});

test('starts with governed plugin views and no runtime isolation failure', async ({ page }) => {
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(message.text());
  });

  await openApplication(page);
  await expect(page.getByText('插件界面已隔离')).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Runtime Error' })).toHaveCount(0);
  await expect(page.getByLabel('画布注释')).toBeVisible();
  await page.waitForTimeout(250);
  expect(failures).toEqual([]);
});

test('the brand returns home while cloud sync stays in its governed panel', async ({ page }) => {
  await openApplication(page);
  const cloudStatus = page.getByRole('button', { name: '返回首页', exact: true });
  const cloudMark = cloudStatus.locator('[data-icon="echo-8"]');
  await expect(cloudMark).toBeVisible();
  await expect.poll(() => cloudMark.evaluate((element) => {
    const style = getComputedStyle(element);
    return style.getPropertyValue('mask-image') || style.getPropertyValue('-webkit-mask-image');
  })).toContain('/favicon.svg');
  await expect(cloudStatus.locator(':scope > :not([data-icon="echo-8"])')).toHaveCount(0);
  await expect(cloudStatus).toHaveClass(/is-unsynced/u);
  await expect(cloudStatus).toHaveCSS('width', '66px');
  await expect(cloudMark).toHaveCSS('width', '58px');
  const cloudMarkBox = await cloudMark.boundingBox();
  expect(cloudMarkBox).not.toBeNull();
  expect(cloudMarkBox!.width / cloudMarkBox!.height).toBeGreaterThan(2.2);
  expect(await cloudStatus.evaluate((element) => getComputedStyle(element, '::after').content)).toBe('none');
  const commandButton = page.getByRole('button', { name: '命令面板' });
  const [cloudStatusBox, commandButtonBox] = await Promise.all([
    cloudStatus.boundingBox(),
    commandButton.boundingBox(),
  ]);
  expect(cloudStatusBox).not.toBeNull();
  expect(commandButtonBox).not.toBeNull();
  expect(cloudStatusBox!.x).toBeLessThan(commandButtonBox!.x);
  const toolbar = page.getByRole('navigation', { name: '主工具栏' });
  await expect(toolbar.getByRole('button', { name: '返回首页', exact: true })).toHaveCount(1);
  await expect(toolbar.getByRole('button', { name: /^保存书籍/u })).toHaveCount(0);
  await expect(toolbar.getByRole('button', { name: '另存本地副本' })).toHaveCount(0);
  await expect(toolbar.getByRole('button', { name: '打开书籍' })).toHaveCount(0);
  await commandButton.click();
  const commandPalette = page.getByRole('dialog', { name: '命令面板' });
  await expect(commandPalette).toBeVisible();
  await expect(commandPalette.getByRole('group', { name: '书籍与同步' }).locator('strong')).toHaveText([
    '返回首页（书库）',
    '保存书籍',
    '另存本地副本',
    '打开书籍',
    '书籍与恢复设置',
    '立即保存当前云端书籍',
    '打开 Cloudflare 云同步',
  ]);
  await expect(commandPalette.getByRole('option', { name: /进入当前画布/u })).toHaveCount(0);
  await expect(commandPalette.getByRole('option', { name: /打开命令面板/u })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: 'Cloudflare 云同步' })).toHaveCount(0);
  await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
  await page.getByRole('button', { name: '新开独立 AI 助手', exact: true }).click();
  await page.getByRole('button', { name: '查找替换', exact: true }).click();
  await expect(page.getByRole('region', { name: 'AI 助手' })).toHaveCount(2);
  await expect(page.getByRole('region', { name: '查找与替换' })).toBeVisible();
  await cloudStatus.click();
  const library = page.getByRole('region', { name: 'Echo-8 书库' });
  await expect(library).toBeVisible();
  await expect(page.getByRole('region', { name: 'Cloudflare 云同步' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'AI 助手' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '查找与替换' })).toHaveCount(0);
  await library.press('Escape');
  await executeCommand(page, '打开 Cloudflare 云同步');
  const panel = page.getByRole('region', { name: 'Cloudflare 云同步' });
  await expect(panel).toBeVisible();
  await expect(panel.getByText('部署端还没有配置 OAuth')).toBeVisible();
  await expect(panel.getByText(/随书同步.*纠错与补全规则/u)).toBeVisible();
  await expect(panel.getByText(/保留本机.*本地语义模型/u)).toBeVisible();
  const canvasBox = await page.locator('.canvas-host').boundingBox();
  const panelBox = await panel.boundingBox();
  expect(canvasBox).not.toBeNull();
  expect(panelBox).not.toBeNull();
  expect(Math.abs(panelBox!.y - canvasBox!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(panelBox!.x - (canvasBox!.x + canvasBox!.width))).toBeLessThanOrEqual(1);
  expect(Math.abs(panelBox!.height - canvasBox!.height)).toBeLessThanOrEqual(1);
  expect(panelBox!.width).toBeGreaterThanOrEqual(340);
  expect(panelBox!.width).toBeLessThanOrEqual(420);
  await expect(panel.getByRole('button', { name: '返回书库' })).toHaveCount(0);
  await panel.getByRole('button', { name: '关闭云同步' }).click();
  await expect(panel).toHaveCount(0);
  await executeCommand(page, '打开 Cloudflare 云同步');
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: '关闭云同步' }).click();
});

test('refresh keeps book data and color preferences but closes every session-only panel', async ({ page }) => {
  await openApplication(page);
  const cards = page.locator('.text-node-card');
  await cards.nth(0).click({ position: { x: 80, y: 90 } });
  await cards.nth(1).click({ position: { x: 80, y: 90 }, modifiers: ['Shift'] });
  await page.getByRole('button', { name: /^连接两个节点/u }).click();
  await expect(page.locator('.connection-hit-area')).toHaveCount(1);

  await executeCommand(page, '打开全局颜色设置');
  const colorPanel = page.getByRole('region', { name: '全局颜色设置' });
  await colorPanel.getByRole('button', { name: /^B 暗调/u }).click();
  await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
  await page.getByRole('button', { name: '查找替换', exact: true }).click();
  await expect(colorPanel).toBeVisible();
  await expect(page.getByRole('region', { name: 'AI 助手' })).toBeVisible();
  await expect(page.getByRole('region', { name: '查找与替换' })).toBeVisible();
  await expect.poll(() => page.locator('.application-shell').evaluate((element) =>
    getComputedStyle(element).getPropertyValue('--toolbar').trim())).toBe('#141517');

  await page.waitForTimeout(700);
  await page.reload();
  const library = page.getByRole('region', { name: 'Echo-8 书库' });
  await expect(library).toBeVisible();
  await expect(page.getByRole('region', { name: '全局颜色设置' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'AI 助手' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '查找与替换' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '文本编辑区' })).toHaveCount(0);
  await expect.poll(() => page.locator('.application-shell').evaluate((element) =>
    getComputedStyle(element).getPropertyValue('--toolbar').trim())).toBe('#141517');

  await library.press('Escape');
  await expect(page.locator('.connection-hit-area')).toHaveCount(1);
  await expect(page.locator('.text-node-card.selected')).toHaveCount(0);
});

test('saving a read-only cloud book opens the takeover panel after the failure notice', async ({ page }) => {
  const project = {
    id: 'project-read-only-test',
    name: '只读云端书籍',
    createdAt: Date.now() - 10_000,
    updatedAt: Date.now() - 5_000,
    headRevision: 0,
  };
  await page.route('**/api/cloud/status', (route) => route.fulfill({
    json: {
      configured: true,
      authenticated: true,
      user: { id: 'user-read-only-test', name: 'reader@example.com' },
      accounts: [],
      installations: [{
        id: 'installation-read-only-test',
        accountId: 'account-read-only-test',
        accountName: '测试账户',
        workerUrl: 'http://localhost:3000',
        workerVersion: 3,
        latestWorkerVersion: 3,
        upgradeAvailable: false,
        status: 'ready',
      }],
    },
  }));
  await page.route('**/api/cloud/token', (route) => route.fulfill({
    json: {
      installationId: 'installation-read-only-test',
      workerUrl: 'http://localhost:3000',
      token: 'test-data-token',
      expiresAt: Date.now() + 10 * 60_000,
    },
  }));
  await page.route('**/v1/projects**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/v1/projects') {
      await route.fulfill({ json: { projects: [project] } });
      return;
    }
    if (request.method() === 'POST' && url.pathname === `/v1/projects/${project.id}/lease`) {
      await route.fulfill({
        status: 409,
        json: {
          error: 'lease-held',
          lease: { deviceId: 'other-device', expiresAt: Date.now() + 90_000 },
        },
      });
      return;
    }
    if (request.method() === 'GET' && url.pathname === `/v1/projects/${project.id}/bootstrap`) {
      await route.fulfill({ json: {
        project,
        checkpointRevision: 0,
        chunks: [],
        operations: [],
      } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: '测试接口不存在' } });
  });

  await page.goto('/');
  const library = page.getByRole('region', { name: 'Echo-8 书库' });
  await library.getByRole('button', { name: '打开书籍：只读云端书籍' }).click();
  await expect(library).toHaveCount(0);
  await page.getByRole('button', { name: '返回首页', exact: true }).click();
  await expect(library.getByText('权限：只读（可接管）', { exact: true })).toBeVisible();
  await library.press('Escape');
  await executeCommand(page, '书籍与恢复设置');
  const filePanel = page.getByRole('region', { name: '书籍与恢复' });
  await expect(filePanel).toBeVisible();
  await filePanel.getByRole('button', { name: '保存到云端' }).click();

  await expect(page.getByRole('alert').filter({ hasText: '当前云端书籍为只读，请先接管编辑权' })).toBeVisible();
  const panel = page.getByRole('region', { name: 'Cloudflare 云同步' });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: '接管编辑权' })).toBeVisible();
});

test('cloud book names can be edited inline in the library and sync panel', async ({ page }) => {
  let project = {
    id: 'project-rename-test',
    name: '初始书名',
    createdAt: Date.now() - 10_000,
    updatedAt: Date.now() - 5_000,
    headRevision: 0,
  };
  const renamedTo: string[] = [];
  let holdNextSync = false;
  let markHeldSyncStarted!: () => void;
  const heldSyncStarted = new Promise<void>((resolve) => { markHeldSyncStarted = resolve; });
  let releaseHeldSync!: () => void;
  const heldSyncRelease = new Promise<void>((resolve) => { releaseHeldSync = resolve; });
  await page.route('**/api/cloud/status', (route) => route.fulfill({
    json: {
      configured: true,
      authenticated: true,
      user: { id: 'user-rename-test', name: "reader@example.com's Account" },
      accounts: [],
      installations: [{
        id: 'installation-rename-test',
        accountId: 'account-rename-test',
        accountName: '测试账户',
        workerUrl: 'http://localhost:3000',
        workerVersion: 4,
        latestWorkerVersion: 4,
        upgradeAvailable: false,
        status: 'ready',
      }],
    },
  }));
  await page.route('**/api/cloud/token', (route) => route.fulfill({
    json: {
      installationId: 'installation-rename-test',
      workerUrl: 'http://localhost:3000',
      token: 'test-data-token',
      expiresAt: Date.now() + 10 * 60_000,
    },
  }));
  await page.route('**/v1/storage', (route) => route.fulfill({
    json: {
      storage: {
        storageMode: 'd1',
        usedBytes: 12_000_000,
        capacityBytes: 500_000_000,
        remainingBytes: 488_000_000,
        quotaBasis: 'd1-free-database-limit',
        measuredAt: Date.now(),
      },
    },
  }));
  await page.route('**/v1/projects**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/v1/projects') {
      await route.fulfill({ json: { projects: [project] } });
      return;
    }
    if (request.method() === 'PATCH' && url.pathname === `/v1/projects/${project.id}`) {
      const body = request.postDataJSON() as { name: string };
      project = { ...project, name: body.name, updatedAt: Date.now() };
      renamedTo.push(body.name);
      await route.fulfill({ json: { project } });
      return;
    }
    if (request.method() === 'POST' && url.pathname === `/v1/projects/${project.id}/lease`) {
      await route.fulfill({ json: {
        lease: {
          id: 'lease-rename-test',
          deviceId: 'device-rename-test',
          expiresAt: Date.now() + 90_000,
          owned: true,
        },
      } });
      return;
    }
    if (request.method() === 'GET' && url.pathname === `/v1/projects/${project.id}/bootstrap`) {
      await route.fulfill({ json: {
        project,
        checkpointRevision: 0,
        chunks: [],
        operations: [],
      } });
      return;
    }
    if (request.method() === 'POST' && url.pathname === `/v1/projects/${project.id}/chunks`) {
      await route.fulfill({ json: { stored: 2 } });
      return;
    }
    if (request.method() === 'POST' && url.pathname === `/v1/projects/${project.id}/sync`) {
      if (holdNextSync) {
        holdNextSync = false;
        markHeldSyncStarted();
        await heldSyncRelease;
      }
      await route.fulfill({ json: {
        accepted: 0,
        headRevision: project.headRevision,
        checkpointRevision: 0,
        lease: {
          id: 'lease-rename-test',
          deviceId: 'device-rename-test',
          expiresAt: Date.now() + 90_000,
          owned: true,
        },
      } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: '测试接口不存在' } });
  });

  await page.goto('/');
  const library = page.getByRole('region', { name: 'Echo-8 书库' });
  await expect(library.getByText('reader@example.com', { exact: true })).toBeVisible();
  await expect(library.getByText('已用 12 MB / 剩余 488 MB', { exact: true })).toBeVisible();
  await expect(library.getByText('权限：未打开云端书籍', { exact: true })).toBeVisible();
  await expect(library.getByText("reader@example.com's Account", { exact: true })).toHaveCount(0);
  const libraryRow = library.locator('.book-library-project-row').filter({ hasText: '初始书名' });
  const libraryIconBox = await libraryRow.locator('.book-library-project-icon').boundingBox();
  expect(libraryIconBox?.width).toBeGreaterThanOrEqual(44);
  await libraryRow.evaluate((element) => element.classList.add('active'));
  await expect(libraryRow).toHaveCSS('background-color', 'rgb(24, 24, 26)');
  await expect(libraryRow).toHaveCSS('color', 'rgb(245, 245, 243)');
  const libraryName = library.getByRole('button', { name: '重命名书籍：初始书名' });
  await expect(libraryName).toBeVisible();
  const [libraryRowBox, libraryNameBox] = await Promise.all([
    libraryRow.boundingBox(),
    libraryName.boundingBox(),
  ]);
  expect(libraryRowBox).not.toBeNull();
  expect(libraryNameBox).not.toBeNull();
  expect(libraryNameBox!.width).toBeLessThan(libraryRowBox!.width / 2);

  await library.evaluate((element) => {
    const shell = element.closest('.application-shell') as HTMLElement;
    shell.dataset.theme = 'dark';
    shell.style.setProperty('--surface', '#111214');
    shell.style.setProperty('--ink', '#f2f2f3');
  });
  await expect(libraryRow).toHaveCSS('background-color', 'rgb(242, 242, 243)');
  await expect(libraryRow).toHaveCSS('color', 'rgb(17, 18, 20)');
  const darkLibraryMark = library.locator('.book-library-brand [data-icon="echo-8"]');
  await expect(darkLibraryMark).toHaveCSS('background-color', 'rgb(242, 242, 243)');
  await libraryName.click();
  await expect(library).toBeVisible();
  await libraryName.dblclick();
  const libraryInput = library.getByRole('textbox', { name: '修改书籍名称：初始书名' });
  await libraryInput.fill('书库重命名');
  await libraryInput.press('Enter');
  await expect(library.getByRole('button', { name: '重命名书籍：书库重命名' })).toBeVisible();

  const renamedLibraryRow = library.locator('.book-library-project-row').filter({ hasText: '书库重命名' });
  await renamedLibraryRow.click({ position: { x: 8, y: 35 } });
  await expect(library).toHaveCount(0);
  await page.getByRole('button', { name: '返回首页', exact: true }).click();
  await expect(library.getByText('权限：可编辑', { exact: true })).toBeVisible();
  await library.press('Escape');
  const syncedStatus = page.locator('.cloud-sync-status');
  await expect(syncedStatus).toHaveAccessibleName('返回首页');
  await expect(syncedStatus).toHaveClass(/is-synced/u);
  const syncedMark = syncedStatus.locator('[data-icon="echo-8"]');
  await expect(syncedMark).toHaveCSS('width', '58px');
  await expect(syncedMark).toHaveCSS('filter', 'none');
  await expect(syncedMark).toHaveCSS('opacity', '1');
  const steadyMarkColor = await syncedMark.evaluate((element) => getComputedStyle(element).backgroundColor);
  const syncedVisual = await syncedStatus.evaluate((element) => {
    return {
      beforeContent: getComputedStyle(element, '::before').content,
    };
  });
  expect(syncedVisual.beforeContent).toBe('none');
  await executeCommand(page, '打开 Cloudflare 云同步');
  const panel = page.getByRole('region', { name: 'Cloudflare 云同步' });
  await expect(panel.getByRole('button', { name: '立即保存到云端' }).locator('[data-icon="sync"]')).toBeVisible();
  await expect(panel.getByRole('button', { name: '退出账户' }).locator('[data-icon="logout"]')).toBeVisible();
  await expect(panel.getByRole('button', { name: '刷新云端书籍' }).locator('[data-icon="reset"]')).toBeVisible();
  await expect(panel.getByRole('button', { name: '返回书库' })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '新建云端书籍' })).toHaveCount(0);
  holdNextSync = true;
  await panel.getByRole('button', { name: '立即保存到云端' }).click();
  await heldSyncStarted;
  await expect(syncedStatus).toHaveClass(/is-active/u);
  const processingMark = panel.locator('.cloud-sync-summary svg.echo-8-processing-mark[data-icon="echo-8"]');
  await expect(processingMark).toBeVisible();
  const processingBox = await processingMark.boundingBox();
  expect(processingBox).not.toBeNull();
  expect(processingBox!.width / processingBox!.height).toBeGreaterThan(2.2);
  const processingGaps = processingMark.locator('.echo-8-sync-gap');
  await expect(processingGaps).toHaveCount(3);
  const processingMotionBounds = await processingMark.evaluate((element) => {
    const bounds = element.querySelector<SVGRectElement>('.echo-8-motion-bounds');
    const paths = [...element.querySelectorAll<SVGPathElement>('.echo-8-sync-gap')];
    if (!bounds) return undefined;
    const left = bounds.x.baseVal.value;
    const right = left + bounds.width.baseVal.value;
    return {
      left,
      right,
      paths: paths.map((path) => {
        const box = path.getBBox();
        const shifts = path.getAnimations().flatMap((animation) => {
          if (!(animation.effect instanceof KeyframeEffect)) return [];
          return animation.effect.getKeyframes().map((frame) => {
            const transform = typeof frame.transform === 'string' ? frame.transform : 'none';
            return transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m41;
          });
        });
        return {
          left: box.x + Math.min(0, ...shifts),
          right: box.x + box.width + Math.max(0, ...shifts),
        };
      }),
    };
  });
  expect(processingMotionBounds).toBeDefined();
  expect(processingMotionBounds!.paths.every((path) => (
    path.left >= processingMotionBounds!.left && path.right <= processingMotionBounds!.right
  ))).toBe(true);
  const activeMark = syncedStatus.locator('svg.echo-8-sync-mark[data-icon="echo-8"]');
  await expect(activeMark).toBeVisible();
  await expect(activeMark).toHaveAttribute('viewBox', '0 0 594 263');
  const activeMarkBox = await activeMark.boundingBox();
  expect(activeMarkBox).not.toBeNull();
  expect(activeMarkBox!.width / activeMarkBox!.height).toBeGreaterThan(2.2);
  const movingGaps = activeMark.locator('.echo-8-sync-gap');
  await expect(movingGaps).toHaveCount(3);
  await expect(activeMark).toHaveCSS('filter', 'none');
  await expect(activeMark).toHaveCSS('opacity', '1');
  await expect(activeMark.locator('.echo-8-sync-body')).toHaveCSS('fill', steadyMarkColor);
  const gapAnimations = await movingGaps.evaluateAll((elements) => elements.map((element) => {
    const style = getComputedStyle(element);
    return {
      name: style.animationName,
      duration: style.animationDuration,
      direction: style.animationDirection,
    };
  }));
  expect(gapAnimations.every((animation) => animation.name === 'cloud-sync-gap-travel')).toBe(true);
  expect(gapAnimations.every((animation) => animation.direction === 'alternate')).toBe(true);
  expect(new Set(gapAnimations.map((animation) => animation.duration)).size).toBe(3);
  const travelKeyframes = await movingGaps.first().evaluate((element) => {
    const animation = element.getAnimations()[0];
    return animation?.effect instanceof KeyframeEffect
      ? animation.effect.getKeyframes().map((frame) => String(frame.transform))
      : [];
  });
  expect(travelKeyframes).toContain('translateX(-64px)');
  expect(travelKeyframes).toContain('translateX(64px)');
  await expect(activeMark.locator('.echo-8-sync-body')).toHaveCSS('animation-name', 'none');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(processingGaps.first()).toHaveCSS('animation-name', 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  releaseHeldSync();
  await expect(syncedStatus).not.toHaveClass(/is-active/u);
  await expect(syncedStatus.locator('svg.echo-8-sync-mark')).toHaveCount(0);
  await expect.poll(() => syncedStatus.locator('[data-icon="echo-8"]').evaluate((element) => {
    const style = getComputedStyle(element);
    return style.getPropertyValue('mask-image') || style.getPropertyValue('-webkit-mask-image');
  })).toContain('/favicon.svg');
  const panelName = panel.getByRole('button', { name: '重命名书籍：书库重命名' });
  await panelName.dblclick();
  const panelInput = panel.getByRole('textbox', { name: '修改书籍名称：书库重命名' });
  await panelInput.fill('侧栏重命名');
  await panelInput.press('Enter');
  const renamedPanelName = panel.getByRole('button', { name: '重命名书籍：侧栏重命名' });
  await expect(renamedPanelName).toBeVisible();
  await renamedPanelName.dblclick();
  const cancelledInput = panel.getByRole('textbox', { name: '修改书籍名称：侧栏重命名' });
  await cancelledInput.fill('不应保存的名称');
  await cancelledInput.press('Escape');
  await expect(renamedPanelName).toBeVisible();
  expect(renamedTo).toEqual(['书库重命名', '侧栏重命名']);
});

test('cloud books can be confirmed and deleted from the library and sync panel', async ({ page }) => {
  let projects = [
    {
      id: 'project-delete-library',
      name: '首页待删除',
      createdAt: Date.now() - 20_000,
      updatedAt: Date.now() - 10_000,
      headRevision: 3,
    },
    {
      id: 'project-delete-panel',
      name: '同步页待删除',
      createdAt: Date.now() - 15_000,
      updatedAt: Date.now() - 5_000,
      headRevision: 0,
    },
  ];
  const deletedIds: string[] = [];
  await page.route('**/api/cloud/status', (route) => route.fulfill({
    json: {
      configured: true,
      authenticated: true,
      user: { id: 'user-delete-test', name: '删除测试账户' },
      accounts: [],
      installations: [{
        id: 'installation-delete-test',
        accountId: 'account-delete-test',
        accountName: '删除测试账户',
        workerUrl: 'http://localhost:3000',
        workerVersion: 3,
        latestWorkerVersion: 3,
        upgradeAvailable: false,
        status: 'ready',
      }],
    },
  }));
  await page.route('**/api/cloud/token', (route) => route.fulfill({
    json: {
      installationId: 'installation-delete-test',
      workerUrl: 'http://localhost:3000',
      token: 'test-delete-token',
      expiresAt: Date.now() + 10 * 60_000,
    },
  }));
  await page.route('**/v1/projects**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === '/v1/projects') {
      await route.fulfill({ json: { projects } });
      return;
    }
    if (request.method() === 'POST' && url.pathname === '/v1/projects/project-delete-panel/lease') {
      await route.fulfill({ json: {
        lease: {
          id: 'lease-delete-panel',
          deviceId: 'device-delete-panel',
          expiresAt: Date.now() + 90_000,
          owned: true,
        },
      } });
      return;
    }
    if (request.method() === 'GET' && url.pathname === '/v1/projects/project-delete-panel/bootstrap') {
      const project = projects.find((item) => item.id === 'project-delete-panel');
      await route.fulfill({ json: {
        project,
        checkpointRevision: 0,
        chunks: [],
        operations: [],
      } });
      return;
    }
    if (request.method() === 'POST' && url.pathname === '/v1/projects/project-delete-panel/chunks') {
      await route.fulfill({ json: { stored: 2 } });
      return;
    }
    if (request.method() === 'POST' && url.pathname === '/v1/projects/project-delete-panel/sync') {
      await route.fulfill({ json: {
        accepted: 0,
        headRevision: 0,
        checkpointRevision: 0,
        lease: {
          id: 'lease-delete-panel',
          deviceId: 'device-delete-panel',
          expiresAt: Date.now() + 90_000,
          owned: true,
        },
      } });
      return;
    }
    const match = /^\/v1\/projects\/(project-delete-(?:library|panel))$/u.exec(url.pathname);
    if (request.method() === 'DELETE' && match) {
      deletedIds.push(match[1]);
      projects = projects.filter((project) => project.id !== match[1]);
      await route.fulfill({ json: { deleted: true } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: '测试接口不存在' } });
  });

  await page.goto('/');
  const library = page.getByRole('region', { name: 'Echo-8 书库' });
  const libraryDelete = library.getByRole('button', { name: '删除书籍：首页待删除' });
  await expect(libraryDelete).toBeVisible();
  await expect(libraryDelete.locator('[data-icon="trash"]')).toBeVisible();
  await libraryDelete.click();
  const firstDialog = page.getByRole('dialog', { name: '删除这本云端书籍？' });
  await expect(firstDialog).toContainText('首页待删除');
  await page.keyboard.press('Escape');
  await expect(firstDialog).toHaveCount(0);
  await expect(libraryDelete).toBeVisible();

  await libraryDelete.click();
  await page.getByRole('dialog', { name: '删除这本云端书籍？' })
    .getByRole('button', { name: '删除云端书籍' }).click();
  await expect(library.getByText('首页待删除')).toHaveCount(0);

  await library.locator('.book-library-project-row').filter({ hasText: '同步页待删除' })
    .getByRole('button', { name: '打开书籍：同步页待删除' }).click();
  await expect(library).toHaveCount(0);
  await executeCommand(page, '打开 Cloudflare 云同步');
  const panel = page.getByRole('region', { name: 'Cloudflare 云同步' });
  const panelDelete = panel.getByRole('button', { name: '删除书籍：同步页待删除' });
  await expect(panelDelete.locator('[data-icon="trash"]')).toBeVisible();
  await panelDelete.click();
  const secondDialog = page.getByRole('dialog', { name: '删除这本云端书籍？' });
  await expect(secondDialog).toContainText('同步页待删除');
  await expect(secondDialog).toContainText('当前画布会保留并改为未连接状态');
  await secondDialog.getByRole('button', { name: '删除云端书籍' }).click();
  await expect(panel.getByText('同步页待删除')).toHaveCount(0);
  await expect(panel.getByText('返回书库新建空白书籍')).toBeVisible();
  expect(deletedIds).toEqual(['project-delete-library', 'project-delete-panel']);
});

test('shell, canvas, editor and AI surfaces keep their visual contract', async ({ page }) => {
  await openApplication(page);
  const firstCard = page.getByRole('article', { name: /文本节点：/u }).first();
  await firstCard.getByRole('paragraph').dblclick({ position: { x: 90, y: 70 } });
  await expect(page.getByRole('region', { name: '文本编辑区' })).toBeVisible();
  await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
  await expect(page.getByRole('region', { name: 'AI 助手' })).toBeVisible();
  await page.mouse.move(1, 1);
  await expect(page).toHaveScreenshot('shell-editor-ai.png', {
    animations: 'disabled',
    caret: 'hide',
    mask: [page.locator('.status-bar'), page.locator('.ai-status')],
  });
});

test('a missing external correction file is exposed as a clickable canvas association item', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showOpenFilePicker', {
      configurable: true,
      value: undefined,
    });
  });
  await page.route('**/Echo-8-text-assist-rules.txt', (route) => route.fulfill({ status: 404 }));
  await openApplication(page);

  const association = page.getByRole('status').filter({ hasText: '纠错规则尚未导入' });
  await expect(association).toBeVisible();
  const associationBox = await association.boundingBox();
  const viewport = page.viewportSize();
  expect(associationBox).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(Math.abs(
    (associationBox?.x ?? 0) + (associationBox?.width ?? 0) / 2 - (viewport?.width ?? 0) / 2,
  )).toBeLessThanOrEqual(1);
  const chooserPromise = page.waitForEvent('filechooser');
  await association.getByRole('button').click();
  const chooser = await chooserPromise;
  await chooser.setFiles('public/Echo-8-text-assist-rules.txt');
  await expect(association).toHaveCount(0, { timeout: 15_000 });
  await page.reload();
  await expect(page.getByRole('article', { name: /文本节点：/u })).toHaveCount(2);
  await expect(page.getByRole('status').filter({ hasText: '纠错规则尚未导入' })).toHaveCount(0);
});

test('opening another canvas resolves unsaved work before opening the native file picker', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showOpenFilePicker', {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async () => ({
        name: '当前书籍.echo8',
        createWritable: async () => ({
          write: async () => undefined,
          close: async () => { Reflect.set(window, '__echo8NativeSaveClosed', true); },
        }),
      }),
    });
  });
  await openApplication(page);
  const targetSource: ProjectSource = {
    document: { revision: 0, namespaces: {} },
    history: { undo: [], redo: [] },
    plugins: [],
  };
  const targetBlob = await serializeProject(targetSource);
  await executeCommand(page, '打开书籍');
  const notice = page.getByRole('status').filter({ hasText: '当前书籍还有未保存修改' });
  await expect(notice).toBeVisible();
  await expect(page.getByRole('article', { name: /文本节点：/u })).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(notice).toHaveCount(0);
  await executeCommand(page, '打开书籍');
  await expect(notice).toBeVisible();
  await notice.getByRole('button', { name: '保存当前书籍' }).click();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, '__echo8NativeSaveClosed') === true))
    .toBe(true);
  const readyNotice = page.getByRole('status').filter({ hasText: '选择要打开的书籍' });
  await expect(readyNotice).toBeVisible();

  const chooserPromise = page.waitForEvent('filechooser');
  await readyNotice.getByRole('button', { name: '选择书籍文件' }).click();
  const chooser = await chooserPromise;
  await expect(readyNotice).toBeVisible();
  await chooser.setFiles({
    name: '另一张画布.echo8',
    mimeType: targetBlob.type,
    buffer: Buffer.from(await targetBlob.arrayBuffer()),
  });
  await expect(readyNotice).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByRole('article', { name: /文本节点：/u })).toHaveCount(0);

  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  await executeCommand(page, '打开书籍');
  const discardNotice = page.getByRole('status').filter({ hasText: '当前书籍还有未保存修改' });
  await expect(discardNotice).toBeVisible();
  const discardChooserPromise = page.waitForEvent('filechooser');
  await discardNotice.getByRole('button', { name: '不保存，继续选择书籍' }).click();
  const discardChooser = await discardChooserPromise;
  await expect(discardNotice).toBeVisible();
  await discardChooser.setFiles({
    name: '再次打开.echo8',
    mimeType: targetBlob.type,
    buffer: Buffer.from(await targetBlob.arrayBuffer()),
  });
  await expect(discardNotice).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByRole('article', { name: /文本节点：/u })).toHaveCount(0);
});

test('opening a native book keeps its handle for direct subsequent saves', async ({ page }) => {
  const targetSource: ProjectSource = {
    document: { revision: 0, namespaces: {} },
    history: { undo: [], redo: [] },
    plugins: [],
  };
  const targetBlob = await serializeProject(targetSource);
  await page.addInitScript(async ({ bytes, type }) => {
    const file = new File([new Uint8Array(bytes)], '可自动保存的书籍.echo8', { type });
    Reflect.set(window, '__echo8NativeBookOpened', false);
    Reflect.set(window, '__echo8NativeBookWrites', 0);
    const handle = {
      name: '可自动保存的书籍.echo8',
      async getFile() {
        Reflect.set(window, '__echo8NativeBookOpened', true);
        return file;
      },
      async createWritable() {
        return {
          async write() { return undefined; },
          async close() {
            const writes = Number(Reflect.get(window, '__echo8NativeBookWrites') ?? 0);
            Reflect.set(window, '__echo8NativeBookWrites', writes + 1);
          },
        };
      },
    };
    Object.defineProperty(window, 'showOpenFilePicker', {
      configurable: true,
      value: async () => [handle],
    });
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async () => { throw new Error('已打开书籍不应重新请求保存位置'); },
    });
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: async (options?: { startIn?: unknown }) => {
        Reflect.set(window, '__echo8MemoryStartedAtBook', options?.startIn === handle);
        return {
          name: '书籍所在文件夹',
          async getFileHandle(name: string) {
            return {
              name,
              async createWritable() {
                return {
                  async write() { return undefined; },
                  async close() { return undefined; },
                };
              },
            };
          },
        };
      },
    });
  }, {
    bytes: [...new Uint8Array(await targetBlob.arrayBuffer())],
    type: targetBlob.type,
  });
  await openApplication(page);

  await executeCommand(page, '打开书籍');
  const notice = page.getByRole('status').filter({ hasText: '当前书籍还有未保存修改' });
  await expect(notice).toBeVisible();
  await notice.getByRole('button', { name: '不保存，继续选择书籍' }).click();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, '__echo8NativeBookOpened') === true))
    .toBe(true);
  await expect(page.getByRole('article', { name: /文本节点：/u })).toHaveCount(0);

  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  await executeCommand(page, '保存书籍');
  await expect.poll(() => page.evaluate(() => Reflect.get(window, '__echo8NativeBookWrites'))).toBe(1);

  await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
  const assistantPanel = page.getByRole('region', { name: 'AI 助手' });
  await assistantPanel.getByRole('button', { name: '选择本轮记忆，前往记忆中心', exact: true }).click();
  const memoryActions = page.getByRole('group', { name: '记忆文件操作' });
  await expect(memoryActions).toContainText('默认：书籍所在文件夹（首次需确认）');
  await memoryActions.getByRole('button', { name: '选择保存路径' }).click();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, '__echo8MemoryStartedAtBook'))).toBe(true);
  await expect(memoryActions).toContainText('保存路径：书籍所在文件夹');
});

test('Ctrl+S saves the current book, reuses its native handle, and blocks browser page saving', async ({ page }) => {
  await page.addInitScript(() => {
    Reflect.set(window, '__echo8ProjectSavePickerCalls', 0);
    Reflect.set(window, '__echo8ProjectSaveWrites', 0);
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async () => {
        Reflect.set(
          window,
          '__echo8ProjectSavePickerCalls',
          Number(Reflect.get(window, '__echo8ProjectSavePickerCalls') ?? 0) + 1,
        );
        return {
          name: '快捷键保存.echo8',
          async createWritable() {
            return {
              async write() { return undefined; },
              async close() {
                Reflect.set(
                  window,
                  '__echo8ProjectSaveWrites',
                  Number(Reflect.get(window, '__echo8ProjectSaveWrites') ?? 0) + 1,
                );
              },
            };
          },
        };
      },
    });
  });
  await openApplication(page);
  await page.evaluate(() => {
    window.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 's') {
        Reflect.set(window, '__echo8ProjectSaveDefaultPrevented', event.defaultPrevented);
      }
    });
  });

  const firstCard = page.getByRole('article', { name: /文本节点：/u }).first();
  await firstCard.getByRole('paragraph').dblclick({ position: { x: 80, y: 80 } });
  const editor = page.locator('.editor-writing-area').first();
  await editor.focus();

  await page.keyboard.press('Control+s');
  await expect.poll(() => page.evaluate(() => Reflect.get(window, '__echo8ProjectSaveWrites'))).toBe(1);
  expect(await page.evaluate(() => Reflect.get(window, '__echo8ProjectSavePickerCalls'))).toBe(1);
  expect(await page.evaluate(() => Reflect.get(window, '__echo8ProjectSaveDefaultPrevented'))).toBe(true);

  await page.keyboard.press('Control+s');
  await expect.poll(() => page.evaluate(() => Reflect.get(window, '__echo8ProjectSaveWrites'))).toBe(2);
  expect(await page.evaluate(() => Reflect.get(window, '__echo8ProjectSavePickerCalls'))).toBe(1);
});

test('toolbar creation, global undo and redo remain routed and responsive', async ({ page }) => {
  await openApplication(page);
  const cards = page.getByRole('article', { name: /文本节点：/u });

  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  await expect(cards).toHaveCount(3);
  await page.keyboard.press('Control+z');
  await expect(cards).toHaveCount(2);
  await page.keyboard.press('Control+Shift+z');
  await expect(cards).toHaveCount(3);
  await cards.nth(2).click();
  await expect(cards.nth(2)).toHaveAttribute('aria-label', /^已选中，/u);
  await page.keyboard.press('Escape');
  await expect(cards.nth(2)).not.toHaveAttribute('aria-label', /^已选中，/u);
});

test('clicking one selected node collapses a multi-selection while dragging preserves it', async ({ page }) => {
  await openApplication(page);
  const cards = page.getByRole('article', { name: /文本节点：/u });
  const first = cards.nth(0);
  const second = cards.nth(1);

  await first.click({ position: { x: 70, y: 28 } });
  await second.click({ position: { x: 70, y: 28 }, modifiers: ['Control'] });
  await expect(page.locator('.text-node-card.selected')).toHaveCount(2);

  await first.click({ position: { x: 70, y: 28 } });
  await expect(page.locator('.text-node-card.selected')).toHaveCount(1);
  await expect(first).toHaveClass(/\bselected\b/u);
  await expect(second).not.toHaveClass(/\bselected\b/u);

  await second.click({ position: { x: 70, y: 28 }, modifiers: ['Control'] });
  await expect(page.locator('.text-node-card.selected')).toHaveCount(2);
  const [firstBefore, secondBefore, firstTitle] = await Promise.all([
    first.boundingBox(),
    second.boundingBox(),
    first.locator('strong').boundingBox(),
  ]);
  expect(firstBefore).not.toBeNull();
  expect(secondBefore).not.toBeNull();
  expect(firstTitle).not.toBeNull();

  const startX = firstTitle!.x + firstTitle!.width / 2;
  const startY = firstTitle!.y + firstTitle!.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 84, startY + 54, { steps: 6 });
  await page.mouse.up();

  await expect(page.locator('.text-node-card.selected')).toHaveCount(2);
  await expect.poll(async () => {
    const [firstAfter, secondAfter] = await Promise.all([first.boundingBox(), second.boundingBox()]);
    if (!firstAfter || !secondAfter) return Number.POSITIVE_INFINITY;
    const firstDelta = {
      x: firstAfter.x - firstBefore!.x,
      y: firstAfter.y - firstBefore!.y,
    };
    const secondDelta = {
      x: secondAfter.x - secondBefore!.x,
      y: secondAfter.y - secondBefore!.y,
    };
    return Math.max(
      Math.abs(firstDelta.x - secondDelta.x),
      Math.abs(firstDelta.y - secondDelta.y),
    );
  }).toBeLessThan(1);
});

test('dragging one selected node into AI inserts every selected node reference', async ({ page }) => {
  await openApplication(page);
  const cards = page.getByRole('article', { name: /文本节点：/u });
  const first = cards.nth(0);
  const second = cards.nth(1);
  await first.click({ position: { x: 70, y: 28 } });
  await second.click({ position: { x: 70, y: 28 }, modifiers: ['Control'] });
  await expect(page.locator('.text-node-card.selected')).toHaveCount(2);

  const [firstBefore, secondBefore] = await Promise.all([first.boundingBox(), second.boundingBox()]);
  expect(firstBefore).not.toBeNull();
  expect(secondBefore).not.toBeNull();
  await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
  const assistant = page.getByRole('region', { name: 'AI 助手' });
  const composer = assistant.getByPlaceholder(/直接描述任务/u);
  const [titleBox, composerBox] = await Promise.all([
    first.locator('strong').boundingBox(),
    composer.boundingBox(),
  ]);
  expect(titleBox).not.toBeNull();
  expect(composerBox).not.toBeNull();

  await page.mouse.move(titleBox!.x + titleBox!.width / 2, titleBox!.y + titleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    composerBox!.x + composerBox!.width / 2,
    composerBox!.y + composerBox!.height / 2,
    { steps: 12 },
  );
  await expect(assistant.locator('.ai-composer')).toHaveClass(/reference-drop-ready/u);
  await page.mouse.up();

  await expect.poll(() => composer.inputValue()).toContain('@[AI 助手使用指南]');
  const prompt = await composer.inputValue();
  expect(prompt).toContain('@[画布基本操作指南]');
  expect(prompt.match(/@\[/gu)).toHaveLength(2);
  await expect.poll(async () => {
    const [firstAfter, secondAfter] = await Promise.all([first.boundingBox(), second.boundingBox()]);
    if (!firstAfter || !secondAfter) return Number.POSITIVE_INFINITY;
    return Math.max(
      Math.abs(firstAfter.x - firstBefore!.x),
      Math.abs(firstAfter.y - firstBefore!.y),
      Math.abs(secondAfter.x - secondBefore!.x),
      Math.abs(secondAfter.y - secondBefore!.y),
    );
  }).toBeLessThan(1);
});

test('double-clicking a text node opens the editor without focusing the canvas', async ({ page }) => {
  await openApplication(page);
  const card = page.getByRole('article', { name: /文本节点：/u }).first();
  const world = page.locator('.canvas-world').first();
  const cameraBefore = await world.evaluate((element) => (element as HTMLElement).style.transform);

  await card.getByRole('paragraph').dblclick({ position: { x: 80, y: 80 } });
  await expect(page.getByRole('region', { name: '文本编辑区' })).toBeVisible();
  await page.waitForTimeout(150);
  await expect.poll(() => world.evaluate((element) =>
    (element as HTMLElement).style.transform)).toBe(cameraBefore);
});

test('ordinary and Shift double-clicks arbitrate editor panes and right-side panels', async ({ page }) => {
  await openApplication(page);
  const cards = page.locator('.text-node-card:not(.text-box)');
  const firstPreview = cards.nth(0).getByRole('paragraph');
  const secondPreview = cards.nth(1).getByRole('paragraph');
  const panes = page.locator('.editor-pane-list > .editor-pane');

  await firstPreview.dblclick({ position: { x: 80, y: 80 } });
  await expect(panes).toHaveCount(1);
  await secondPreview.dispatchEvent('dblclick', { shiftKey: true });
  await expect(panes).toHaveCount(2);

  await firstPreview.dispatchEvent('dblclick');
  await expect(panes).toHaveCount(1);

  await executeCommand(page, '打开全局颜色设置');
  await expect(page.getByRole('region', { name: '全局颜色设置' })).toBeVisible();
  await expect(page.getByRole('region', { name: '文本编辑区' })).toHaveCount(0);

  await firstPreview.dispatchEvent('dblclick');
  await expect(page.getByRole('region', { name: '文本编辑区' })).toBeVisible();
  await expect(page.getByRole('region', { name: '全局颜色设置' })).toHaveCount(0);
});

test('node resize shows edge guides and snaps the resized frame to nearby nodes', async ({ page }) => {
  await openApplication(page);
  const first = page.locator('.text-node-card').filter({
    has: page.locator('strong[title="AI 助手使用指南"]'),
  });
  const second = page.locator('.text-node-card').filter({
    has: page.locator('strong[title="画布基本操作指南"]'),
  });
  const resizeHandle = first.getByRole('button', { name: /调整AI 助手使用指南的大小/u });
  const handleBox = await resizeHandle.boundingBox();
  expect(handleBox).not.toBeNull();

  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    handleBox!.x + handleBox!.width / 2 + 32,
    handleBox!.y + handleBox!.height / 2 + 6,
    { steps: 6 },
  );
  await expect(page.locator('.canvas-snap-guide.vertical')).toHaveCount(1);
  await expect(page.locator('.canvas-snap-guide.horizontal')).toHaveCount(1);
  await page.mouse.up();
  await expect(page.locator('.canvas-snap-guide')).toHaveCount(0);

  const [firstBox, secondBox] = await Promise.all([first.boundingBox(), second.boundingBox()]);
  expect(firstBox).not.toBeNull();
  expect(secondBox).not.toBeNull();
  expect(Math.abs(firstBox!.x + firstBox!.width - secondBox!.x)).toBeLessThan(1);
  expect(Math.abs(firstBox!.y + firstBox!.height - (secondBox!.y + secondBox!.height))).toBeLessThan(1);
});

test('toolbar palette changes only the selected object and opens beside it', async ({ page }) => {
  await openApplication(page);
  const first = page.locator('.text-node-card').filter({
    has: page.locator('strong[title="AI 助手使用指南"]'),
  });
  const second = page.locator('.text-node-card').filter({
    has: page.locator('strong[title="画布基本操作指南"]'),
  });
  const firstHeader = first.locator('header');
  const secondHeader = second.locator('header');
  const [firstOriginal, secondOriginal] = await Promise.all([
    firstHeader.evaluate((element) => getComputedStyle(element).backgroundColor),
    secondHeader.evaluate((element) => getComputedStyle(element).backgroundColor),
  ]);
  await first.click();

  const appearanceGroup = page.getByRole('group', { name: '选中项工具', exact: true });
  const createGroup = page.getByRole('group', { name: '新建', exact: true });
  const clipboardGroup = page.getByRole('group', { name: '剪贴板', exact: true });
  const createTextButton = createGroup.getByRole('button', { name: '新建文本', exact: true });
  const annotationButton = createGroup.getByRole('button', { name: '添加注释', exact: true });
  const connectionButton = appearanceGroup.getByRole('button', { name: /^连接两个节点/u });
  const arrangeButton = appearanceGroup.getByRole('button', { name: /^自动排列/u });
  const conversionButton = appearanceGroup.getByRole('button', {
    name: '文本框与文字节点相互转换',
    exact: true,
  });
  const paletteButton = appearanceGroup.getByRole('button', { name: '修改选中项颜色', exact: true });
  const copyButton = clipboardGroup.getByRole('button', { name: /^复制/u });
  await expect(appearanceGroup.getByRole('button')).toHaveCount(4);
  await expect(createTextButton).toHaveClass(/\bprimary\b/u);
  await expect(conversionButton).toHaveClass(/\bprimary\b/u);
  await expect(annotationButton).not.toHaveClass(/\bprimary\b/u);
  const [createTextFill, conversionFill, annotationFill] = await Promise.all([
    createTextButton.evaluate((element) => getComputedStyle(element).backgroundColor),
    conversionButton.evaluate((element) => getComputedStyle(element).backgroundColor),
    annotationButton.evaluate((element) => getComputedStyle(element).backgroundColor),
  ]);
  expect(conversionFill).toBe(createTextFill);
  expect(annotationFill).not.toBe(createTextFill);
  expect(annotationFill).toBe('rgba(0, 0, 0, 0)');
  const [connectionBox, arrangeBox, conversionBox, paletteBox, copyBox] = await Promise.all([
    connectionButton.boundingBox(),
    arrangeButton.boundingBox(),
    conversionButton.boundingBox(),
    paletteButton.boundingBox(),
    copyButton.boundingBox(),
  ]);
  for (const box of [connectionBox, arrangeBox, conversionBox, paletteBox, copyBox]) {
    expect(box).not.toBeNull();
  }
  expect(connectionBox!.x).toBeLessThan(arrangeBox!.x);
  expect(arrangeBox!.x).toBeLessThan(conversionBox!.x);
  expect(conversionBox!.x).toBeLessThan(paletteBox!.x);
  expect(paletteBox!.x).toBeLessThan(copyBox!.x);
  await expect(appearanceGroup).toHaveCSS('border-left-width', '1px');
  await expect(clipboardGroup).toHaveCSS('border-left-width', '1px');

  await paletteButton.click();
  const picker = page.getByRole('dialog', { name: '颜色选择器' });
  await expect(picker).toBeVisible();
  const [pickerBox, selectedBox] = await Promise.all([picker.boundingBox(), first.boundingBox()]);
  expect(pickerBox).not.toBeNull();
  expect(selectedBox).not.toBeNull();
  expect(pickerBox!.x).toBeLessThan(selectedBox!.x + selectedBox!.width);
  expect(pickerBox!.x + pickerBox!.width).toBeGreaterThan(selectedBox!.x);

  await picker.getByRole('spinbutton', { name: 'R 通道数值' }).fill('18');
  await picker.getByRole('spinbutton', { name: 'G 通道数值' }).fill('52');
  await picker.getByRole('spinbutton', { name: 'B 通道数值' }).fill('86');
  await expect(firstHeader).toHaveCSS('background-color', 'rgb(18, 52, 86)');
  await expect(secondHeader).toHaveCSS('background-color', secondOriginal);
  await picker.getByRole('spinbutton', { name: 'B 通道数值' }).press('Enter');
  await expect(picker).toBeHidden();
  await expect(firstHeader).toHaveCSS('background-color', 'rgb(18, 52, 86)');
  await expect(secondHeader).toHaveCSS('background-color', secondOriginal);

  await page.keyboard.press('Control+z');
  await expect(firstHeader).toHaveCSS('background-color', firstOriginal);
  await expect(secondHeader).toHaveCSS('background-color', secondOriginal);
});

test('canvas cards convert to canvas-backed editable text boxes and remember both sizes', async ({ page }) => {
  await openApplication(page);
  const originalTitle = 'AI 助手使用指南';
  const card = page.getByRole('article', { name: `文本节点：${originalTitle}`, exact: true });
  const originalSize = await card.evaluate((element) => ({
    width: Number.parseFloat((element as HTMLElement).style.width),
    height: Number.parseFloat((element as HTMLElement).style.height),
  }));
  const sharedNodeRadius = await card.evaluate((element) => getComputedStyle(element).borderRadius);
  expect(sharedNodeRadius).toBe('18px');
  const titleColor = await card.locator('header').evaluate((element) => getComputedStyle(element).backgroundColor);
  const headerButtons = card.locator('header button');
  await expect(headerButtons).toHaveCount(0);
  const conversionButton = page.getByRole('group', { name: '选中项工具', exact: true }).getByRole('button', {
    name: '文本框与文字节点相互转换',
    exact: true,
  });

  await card.click();
  const selectedCard = page.getByRole('article', {
    name: `已选中，文本节点：${originalTitle}`,
    exact: true,
  });
  await expect(selectedCard).toHaveCSS('border-top-width', '1px');
  await expect(selectedCard.locator('header')).toHaveCSS('border-top-left-radius', '17px');
  await expect(selectedCard.locator('header')).toHaveCSS('border-top-right-radius', '17px');
  expect(await selectedNodeOverlayStyle(selectedCard)).toMatchObject({
    borderRadius: '20px',
    borderWidth: '4px',
    inset: '-2px -2px -2px -2px',
    pointerEvents: 'none',
  });
  await conversionButton.click();
  let textBox = page.getByRole('article', { name: new RegExp(`文本框：${originalTitle}$`, 'u') });
  await page.locator('.canvas-surface').click({ position: { x: 24, y: 24 } });
  await expect(textBox).toHaveClass(/\btext-box\b/u);
  await expect(textBox).not.toHaveClass(/\bcompact\b/u);
  const canvas = page.locator('.canvas-surface');
  const initialCanvasBackground = await canvas.evaluate((element) => getComputedStyle(element).backgroundColor);
  await expect(textBox).toHaveCSS('background-color', initialCanvasBackground);
  await expect(textBox).toHaveCSS('border-color', titleColor);
  await expect(textBox).toHaveCSS('border-top-width', '2px');
  await expect(textBox).toHaveCSS('border-radius', sharedNodeRadius);
  await expect(textBox.locator('.text-box-title')).toHaveCSS('color', titleColor);
  await expect(textBox.locator('.text-box-title')).toHaveCSS('font-size', '18px');
  await expect(textBox.getByRole('paragraph')).toHaveCount(0);
  await expect(textBox.getByRole('button', { name: `从${originalTitle}标题栏连接`, exact: true })).toHaveCount(0);
  await expect(textBox.getByRole('button', { name: `从${originalTitle}左侧连接`, exact: true })).toBeVisible();
  await expect(textBox.getByRole('button', { name: `从${originalTitle}右侧连接`, exact: true })).toBeVisible();
  await executeCommand(page, '打开全局颜色设置');
  const colorPanel = page.getByRole('region', { name: '全局颜色设置' });
  await colorPanel.getByRole('button', { name: '画布背景颜色', exact: true }).click();
  const canvasPicker = page.getByRole('dialog', { name: '颜色选择器' });
  await canvasPicker.getByRole('spinbutton', { name: 'R 通道数值' }).fill('42');
  await canvasPicker.getByRole('spinbutton', { name: 'G 通道数值' }).fill('58');
  const canvasBlue = canvasPicker.getByRole('spinbutton', { name: 'B 通道数值' });
  await canvasBlue.fill('74');
  await expect(canvas).toHaveCSS('background-color', 'rgb(42, 58, 74)');
  await expect(textBox).toHaveCSS('background-color', 'rgb(42, 58, 74)');
  const adjustedTextBoxColor = await textBox.locator('.text-box-title').evaluate((element) => {
    const parse = (color: string) => color.match(/[\d.]+/gu)?.slice(0, 3).map(Number) ?? [0, 0, 0];
    const luminance = (color: string) => {
      const channels = parse(color).map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.04045
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };
    const foreground = getComputedStyle(element).color;
    const background = getComputedStyle(element.closest('.text-node-card')!).backgroundColor;
    const lighter = Math.max(luminance(foreground), luminance(background));
    const darker = Math.min(luminance(foreground), luminance(background));
    return { foreground, ratio: (lighter + 0.05) / (darker + 0.05) };
  });
  expect(adjustedTextBoxColor.foreground).not.toBe(titleColor);
  expect(adjustedTextBoxColor.ratio).toBeGreaterThanOrEqual(4.5);
  await expect(textBox).toHaveCSS('border-color', adjustedTextBoxColor.foreground);
  await canvasBlue.press('Enter');
  await expect(canvasPicker).toHaveCount(0);
  await expect(textBox).toHaveCSS('background-color', 'rgb(42, 58, 74)');
  await page.keyboard.press('Escape');
  await expect(colorPanel).toHaveCount(0);
  await textBox.locator('.text-box-title').click();
  await expect(textBox).toHaveAttribute('aria-label', /^已选中，/u);
  expect(await textBox.evaluate((element) => {
    const style = getComputedStyle(element, '::after');
    const probe = element.ownerDocument.createElement('span');
    probe.style.color = style.getPropertyValue('--canvas-selection');
    element.ownerDocument.body.appendChild(probe);
    const selectionColor = getComputedStyle(probe).color;
    probe.remove();
    return style.borderTopColor === selectionColor;
  })).toBe(true);
  await expect(textBox).toHaveCSS('outline-style', 'none');
  await expect(textBox).toHaveCSS('border-top-width', '2px');
  expect(await selectedNodeOverlayStyle(textBox)).toMatchObject({
    borderRadius: '21px',
    borderWidth: '4px',
    inset: '-3px -3px -3px -3px',
    pointerEvents: 'none',
  });
  await expect(textBox).toHaveCSS('border-radius', sharedNodeRadius);
  expect(await textBox.evaluate((element) => {
    const frame = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      width: frame.width,
      height: frame.height,
      styledWidth: Number.parseFloat(style.width),
      styledHeight: Number.parseFloat(style.height),
    };
  })).toEqual({
    width: 240,
    height: 64,
    styledWidth: 240,
    styledHeight: 64,
  });
  await expect(textBox.getByRole('button', { name: /转换为文本/u })).toHaveCount(0);

  const titleFontSize = await textBox.locator('.text-box-title').evaluate((element) => getComputedStyle(element).fontSize);
  const zoom = page.getByRole('textbox', { name: /画布缩放/u });
  await zoom.fill('40');
  await zoom.press('Enter');
  await expect(textBox).not.toHaveClass(/\bcompact\b/u);
  await expect(textBox.locator('.text-box-title')).toHaveCSS('font-size', titleFontSize);
  await zoom.fill('100');
  await zoom.press('Enter');
  await page.keyboard.press('Control+Shift+f');

  await textBox.locator('.text-box-title').dblclick();
  const inlineTitle = page.getByRole('textbox', { name: `编辑${originalTitle}的文本框文字`, exact: true });
  await expect(inlineTitle).toHaveCSS('border-top-width', '0px');
  await expect(inlineTitle).toHaveCSS('outline-style', 'none');
  await expect(inlineTitle).toHaveCSS('box-shadow', 'none');
  await expect(inlineTitle).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  const editedTitle = '项目管理与跨团队协作安排及交付里程碑';
  await inlineTitle.fill(editedTitle);
  await page.locator('.canvas-surface').click({ position: { x: 24, y: 24 } });
  await expect(inlineTitle).toHaveCount(0);
  await expect(page.getByRole('region', { name: '文本编辑区' })).toHaveCount(0);
  textBox = page.getByRole('article', { name: new RegExp(`文本框：${editedTitle}$`, 'u') });
  await expect(textBox.locator('.text-box-title')).toHaveText(editedTitle);
  expect(await textBox.locator('.text-box-title').evaluate((element) => {
    const style = getComputedStyle(element);
    return style.whiteSpace === 'pre-wrap' && element.scrollHeight > Number.parseFloat(style.lineHeight);
  })).toBe(true);

  const initialTextBoxSize = await textBox.evaluate((element) => ({
    width: Number.parseFloat((element as HTMLElement).style.width),
    height: Number.parseFloat((element as HTMLElement).style.height),
  }));
  const resize = textBox.getByRole('button', { name: new RegExp(`调整${editedTitle}的大小`, 'u') });
  const resizeBox = await resize.boundingBox();
  expect(resizeBox).not.toBeNull();
  await page.mouse.move(resizeBox!.x + resizeBox!.width / 2, resizeBox!.y + resizeBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(resizeBox!.x + 92, resizeBox!.y + 42, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => textBox.evaluate((element) =>
    Number.parseFloat((element as HTMLElement).style.width))).toBeGreaterThan(initialTextBoxSize.width);
  await expect.poll(() => textBox.evaluate((element) =>
    Number.parseFloat((element as HTMLElement).style.height))).toBeGreaterThan(initialTextBoxSize.height);
  const resizedTextBoxSize = await textBox.evaluate((element) => ({
    width: Number.parseFloat((element as HTMLElement).style.width),
    height: Number.parseFloat((element as HTMLElement).style.height),
  }));
  expect(resizedTextBoxSize.width).toBeGreaterThan(initialTextBoxSize.width);
  expect(resizedTextBoxSize.height).toBeGreaterThan(initialTextBoxSize.height);

  await textBox.click();
  await conversionButton.click();
  const restoredCard = page.getByRole('article', { name: new RegExp(`文本节点：${editedTitle}$`, 'u') });
  await expect(restoredCard.getByRole('paragraph')).toBeVisible();
  await expect(restoredCard).toHaveCSS('border-radius', sharedNodeRadius);
  await expect(restoredCard).toHaveCSS('border-top-width', '1px');
  await expect(restoredCard).toHaveCSS('outline-style', 'none');
  await expect(restoredCard.locator('header')).toHaveCSS('border-top-left-radius', '17px');
  await expect(restoredCard.locator('header')).toHaveCSS('border-top-right-radius', '17px');
  await expect(restoredCard.locator('header')).toHaveCSS('background-color', titleColor);
  expect(await selectedNodeOverlayStyle(restoredCard)).toMatchObject({ borderWidth: '4px' });
  await expect(restoredCard.locator('header button')).toHaveCount(0);
  await expect.poll(() => restoredCard.evaluate((element) => ({
    width: Number.parseFloat((element as HTMLElement).style.width),
    height: Number.parseFloat((element as HTMLElement).style.height),
  }))).toEqual(originalSize);

  await restoredCard.click();
  await conversionButton.click();
  textBox = page.getByRole('article', { name: new RegExp(`文本框：${editedTitle}$`, 'u') });
  await expect.poll(() => textBox.evaluate((element) => ({
    width: Number.parseFloat((element as HTMLElement).style.width),
    height: Number.parseFloat((element as HTMLElement).style.height),
  }))).toEqual(resizedTextBoxSize);
});

test('shortcut center exposes and applies the text-box presentation shortcut', async ({ page }) => {
  await openApplication(page);
  await executeCommand(page, '打开快捷键中心');
  const panel = page.getByRole('region', { name: '快捷键中心' });
  const search = panel.getByPlaceholder('搜索操作或分类…');
  await search.fill('文本框与文字节点相互转换');
  const binding = panel.getByRole('textbox', { name: '修改文本框与文字节点相互转换的快捷键' });
  await expect(binding).toBeVisible();
  await expect(binding).toHaveValue('未设置');
  await binding.focus();
  await page.keyboard.press('Control+Shift+9');
  await expect(binding).toHaveValue(/Ctrl.*Shift.*9/u);
  await search.fill('标题到标题连接两个文字节点');
  const titleConnectionBinding = panel.getByRole('textbox', { name: '修改标题到标题连接两个文字节点的快捷键' });
  await expect(titleConnectionBinding).toHaveValue('Shift + L');
  await expect(panel.getByRole('heading', { name: /节点与连线/u })).toBeVisible();
  await panel.getByRole('button', { name: '关闭快捷键中心', exact: true }).click();

  const title = 'AI 助手使用指南';
  const card = page.getByRole('article', { name: `文本节点：${title}`, exact: true });
  await card.click();
  await page.keyboard.press('Control+Shift+9');
  await expect(page.getByRole('article', { name: new RegExp(`文本框：${title}$`, 'u') })).toBeVisible();
});

test('title-bar ports create persistent connections before the title dot', async ({ page }) => {
  await openApplication(page);
  const source = page.locator('.text-node-card').filter({
    has: page.locator('strong[title="AI 助手使用指南"]'),
  });
  const target = page.locator('.text-node-card').filter({
    has: page.locator('strong[title="画布基本操作指南"]'),
  });
  const sourceTitleBox = await source.locator('strong').boundingBox();
  expect(sourceTitleBox).not.toBeNull();
  const sourceBeforeMove = await source.evaluate((element) => {
    const match = /translate(?:3d)?\(([-\d.]+)px,\s*([-\d.]+)px/u.exec((element as HTMLElement).style.transform);
    return { x: Number(match?.[1]), y: Number(match?.[2]) };
  });
  await page.mouse.move(
    sourceTitleBox!.x + sourceTitleBox!.width / 2,
    sourceTitleBox!.y + sourceTitleBox!.height / 2,
  );
  await page.mouse.down();
  await expect(source).toHaveAttribute('aria-label', /^已选中，/u);
  await expect(source).toHaveCSS('outline-style', 'none');
  await expect(source).toHaveCSS('border-top-width', '1px');
  expect(await selectedNodeOverlayStyle(source)).toMatchObject({ borderWidth: '4px' });
  await page.mouse.move(
    sourceTitleBox!.x + sourceTitleBox!.width / 2 + 280,
    sourceTitleBox!.y + sourceTitleBox!.height / 2 + 140,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect.poll(() => source.evaluate((element) => {
    const match = /translate(?:3d)?\(([-\d.]+)px,\s*([-\d.]+)px/u.exec((element as HTMLElement).style.transform);
    return Number(match?.[1]);
  })).toBeGreaterThan(sourceBeforeMove.x + 200);
  const sourcePort = source.getByRole('button', { name: '从AI 助手使用指南标题栏连接', exact: true });
  await expect(sourcePort).toHaveCSS('outline-style', 'none');
  expect(await sourcePort.evaluate((element) => getComputedStyle(element, '::after').content)).toBe('none');
  const [sourcePortBox, targetBox] = await Promise.all([sourcePort.boundingBox(), target.boundingBox()]);
  expect(sourcePortBox).not.toBeNull();
  expect(targetBox).not.toBeNull();

  await page.mouse.move(
    sourcePortBox!.x + sourcePortBox!.width / 2,
    sourcePortBox!.y + sourcePortBox!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(targetBox!.x + 8, targetBox!.y + 21, { steps: 8 });
  await page.mouse.up();

  const connection = page.locator('.connection-hit-area');
  await expect(connection).toHaveCount(1);
  await expect(connection).toHaveCSS('stroke', 'rgba(0, 0, 0, 0)');
  await expect(source).toHaveCSS('box-shadow', 'none');
  const renderedConnection = page.locator('.connection-path').first();
  await expect(renderedConnection).not.toHaveAttribute('marker-end');
  await expect(renderedConnection).toHaveCSS('filter', 'none');
  await expect(page.locator('.connection-layer marker')).toHaveCount(0);
  expect(await renderedConnection.evaluate((element) => {
    const style = getComputedStyle(element);
    return style.fill !== 'none' && style.fill === style.stroke;
  })).toBe(true);
  const renderedCoordinates = (await renderedConnection.getAttribute('d'))
    ?.match(/-?\d+(?:\.\d+)?/gu)?.map(Number) ?? [];
  expect(renderedCoordinates).toHaveLength(20);
  expect((await renderedConnection.getAttribute('d'))?.match(/\bZ\b/gu)).toHaveLength(2);
  const arrowScreenHeight = Math.abs(renderedCoordinates.at(-5)! - renderedCoordinates.at(-1)!);
  expect(arrowScreenHeight).toBeGreaterThanOrEqual(13);
  expect(arrowScreenHeight).toBeLessThanOrEqual(15);
  const [sourcePosition, targetPosition, path] = await Promise.all([
    source.evaluate((element) => {
      const match = /translate(?:3d)?\(([-\d.]+)px,\s*([-\d.]+)px/u.exec((element as HTMLElement).style.transform);
      return { x: Number(match?.[1]), y: Number(match?.[2]) };
    }),
    target.evaluate((element) => {
      const match = /translate(?:3d)?\(([-\d.]+)px,\s*([-\d.]+)px/u.exec((element as HTMLElement).style.transform);
      return { x: Number(match?.[1]), y: Number(match?.[2]) };
    }),
    connection.getAttribute('d'),
  ]);
  const coordinates = path?.match(/-?\d+(?:\.\d+)?/gu)?.map(Number) ?? [];
  expect(coordinates).toHaveLength(8);
  expect(coordinates[0]).toBeCloseTo(sourcePosition.x, 4);
  expect(coordinates[1]).toBeCloseTo(sourcePosition.y + 21, 4);
  expect(coordinates.at(-2)).toBeCloseTo(targetPosition.x, 4);
  expect(coordinates.at(-1)).toBeCloseTo(targetPosition.y + 21, 4);
  expect(coordinates[3]).toBeCloseTo(coordinates[1], 4);
  expect(coordinates[5]).toBeCloseTo(coordinates[7], 4);
  expect(renderedCoordinates.at(-4)).toBeCloseTo(coordinates.at(-2)!, 4);
  expect(renderedCoordinates.at(-3)).toBeCloseTo(coordinates.at(-1)!, 4);
  const pathXCoordinates = coordinates.filter((_, index) => index % 2 === 0);
  expect(Math.min(...pathXCoordinates)).toBeLessThan(Math.min(coordinates[0], coordinates.at(-2)!) - 50);

  const connectionPoint = await connection.evaluate((element) => {
    const hitPath = element as SVGPathElement;
    const matrix = hitPath.getScreenCTM();
    if (!matrix) throw new Error('Connection path is not attached to the viewport');
    const length = hitPath.getTotalLength();
    const hitTargets: string[] = [];
    for (const fraction of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]) {
      const screenPoint = hitPath.getPointAtLength(length * fraction).matrixTransform(matrix);
      const target = document.elementFromPoint(screenPoint.x, screenPoint.y);
      if (target === hitPath) {
        return { x: screenPoint.x, y: screenPoint.y };
      }
      hitTargets.push(`${fraction}:${target?.tagName ?? 'none'}.${target?.getAttribute('class') ?? ''}`);
    }
    throw new Error(`No visible connection segment can receive a double click (${hitTargets.join(', ')})`);
  });
  await expect(renderedConnection).toHaveCSS('stroke-width', '1.5px');
  await page.mouse.move(connectionPoint.x, connectionPoint.y);
  await expect(renderedConnection).toHaveCSS('stroke-width', '1.5px');
  await page.mouse.dblclick(connectionPoint.x, connectionPoint.y);
  const labelInput = page.getByRole('textbox', { name: '连接文字', exact: true });
  await expect(labelInput).toBeVisible();
  await expect(connection).toHaveAttribute('aria-pressed', 'true');
  await expect(renderedConnection).toHaveCSS('stroke-width', '1.5px');
  const wrappingLabel = '因果关系说明会根据文字框宽度自动换行显示';
  await labelInput.fill(wrappingLabel);
  await labelInput.press('Enter');
  const label = page.locator('.connection-label-display');
  const labelText = label.locator('.connection-label-text');
  await expect(label).toHaveCSS('border-top-width', '1px');
  await expect(label).toHaveCSS('font-size', '12px');
  await expect(labelText).toHaveText(wrappingLabel);
  await expect(labelText).toHaveCSS('white-space', 'pre-wrap');
  expect(await labelText.evaluate((element) => {
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
  })).toBeGreaterThan(1);
  await expect.poll(() => Promise.all([
    label.evaluate((element) => getComputedStyle(element).color),
    renderedConnection.evaluate((element) => getComputedStyle(element).stroke),
  ]).then(([textColor, lineColor]) => textColor === lineColor)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(connection).toHaveAttribute('aria-pressed', 'false');
  await expect(renderedConnection).toHaveCSS('stroke-width', '1.5px');
  await expect.poll(() => Promise.all([
    label.evaluate((element) => getComputedStyle(element).color),
    renderedConnection.evaluate((element) => getComputedStyle(element).stroke),
  ]).then(([textColor, lineColor]) => textColor === lineColor)).toBe(true);
  const [labelBox, curveMiddle] = await Promise.all([
    label.boundingBox(),
    connection.evaluate((element) => {
      const hitPath = element as SVGPathElement;
      const point = hitPath.getPointAtLength(hitPath.getTotalLength() / 2);
      const matrix = hitPath.getScreenCTM();
      if (!matrix) throw new Error('Connection path is not attached to the viewport');
      const screenPoint = point.matrixTransform(matrix);
      return { x: screenPoint.x, y: screenPoint.y };
    }),
  ]);
  expect(labelBox).not.toBeNull();
  expect(Math.abs(labelBox!.x + labelBox!.width / 2 - curveMiddle.x)).toBeLessThan(24);
  expect(Math.abs(labelBox!.y + labelBox!.height / 2 - curveMiddle.y)).toBeLessThan(24);

  const zoomStatus = page.locator('.canvas-zoom-status input');
  await page.mouse.dblclick(
    labelBox!.x + labelBox!.width / 2,
    labelBox!.y + labelBox!.height / 2,
  );
  await expect(labelInput).toBeVisible();
  await expect(labelInput).toHaveValue(wrappingLabel);
  await labelInput.press('End');
  await labelInput.press('Control+Enter');
  await labelInput.pressSequentially('第二段');
  const multilineLabel = `${wrappingLabel}\n第二段`;
  await expect(labelInput).toHaveValue(multilineLabel);
  await labelInput.press('Enter');
  await expect(labelInput).toHaveCount(0);
  await expect.poll(() => labelText.textContent()).toBe(multilineLabel);

  const labelBoxBeforeResize = await label.boundingBox();
  expect(labelBoxBeforeResize).not.toBeNull();
  const labelResizeHandle = page.getByRole('button', { name: '调整连接文字框大小', exact: true });
  await expect(labelResizeHandle).toBeVisible();
  await expect(labelResizeHandle).toHaveCSS('cursor', 'nwse-resize');
  const labelResizeHandleBox = await labelResizeHandle.boundingBox();
  expect(labelResizeHandleBox).not.toBeNull();
  await page.mouse.move(
    labelResizeHandleBox!.x + labelResizeHandleBox!.width / 2,
    labelResizeHandleBox!.y + labelResizeHandleBox!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    labelResizeHandleBox!.x + labelResizeHandleBox!.width / 2 + 96,
    labelResizeHandleBox!.y + labelResizeHandleBox!.height / 2 + 54,
    { steps: 6 },
  );
  await page.mouse.up();
  await expect.poll(async () => (await label.boundingBox())?.width ?? 0)
    .toBeGreaterThan(labelBoxBeforeResize!.width + 80);
  await expect.poll(async () => (await label.boundingBox())?.height ?? 0)
    .toBeGreaterThan(labelBoxBeforeResize!.height + 40);

  const fixedLabelBox = await label.boundingBox();
  expect(fixedLabelBox).not.toBeNull();
  const sourceSelectionPoint = await source.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    for (let y = rect.top + 6; y < rect.bottom - 6; y += 6) {
      for (let x = rect.left + 6; x < rect.right - 6; x += 6) {
        const target = document.elementFromPoint(x, y);
        if (target?.closest('.text-node-card') === element &&
          !target.closest('.connection-edge, .node-resize-handle')) return { x, y };
      }
    }
    throw new Error('Moved source node has no directly clickable point');
  });
  await page.mouse.click(sourceSelectionPoint.x, sourceSelectionPoint.y);
  await expect(source).toHaveAttribute('aria-label', /^已选中，/u);
  const fixedConnectionVisuals = await Promise.all([
    renderedConnection.evaluate(connectionStrokeScreenWidth),
    label.evaluate(connectionLabelScreenMetrics),
    renderedConnection.evaluate(connectionArrowScreenMetrics),
  ]);
  await zoomStatus.fill('5');
  await zoomStatus.press('Enter');
  await expect(zoomStatus).toHaveAttribute('aria-label', /40%/u);
  await expect(page.locator('.connection-layer')).toHaveAttribute('data-detail-mode', 'overview-focus');
  expect(await selectedNodeOverlayStyle(source)).toMatchObject({ borderWidth: '10px' });
  expect(await source.evaluate((element) => getComputedStyle(element, '::before').content)).toBe('none');
  const zoomedOutDetailRatio = Math.sqrt(0.4);
  await expect.poll(async () => Math.abs(
    await renderedConnection.evaluate(connectionStrokeScreenWidth) /
      fixedConnectionVisuals[0] - zoomedOutDetailRatio,
  )).toBeLessThan(0.03);
  const zoomedConnectionVisuals = await Promise.all([
    renderedConnection.evaluate(connectionStrokeScreenWidth),
    label.evaluate(connectionLabelScreenMetrics),
    renderedConnection.evaluate(connectionArrowScreenMetrics),
  ]);
  expect(Math.abs(zoomedConnectionVisuals[0] / fixedConnectionVisuals[0] - zoomedOutDetailRatio))
    .toBeLessThan(0.03);
  expect(Math.abs(
    zoomedConnectionVisuals[1].fontSize / fixedConnectionVisuals[1].fontSize - zoomedOutDetailRatio,
  )).toBeLessThan(0.03);
  expect(Math.abs(
    zoomedConnectionVisuals[1].borderWidth / fixedConnectionVisuals[1].borderWidth - zoomedOutDetailRatio,
  )).toBeLessThan(0.04);
  expect(Math.abs(
    zoomedConnectionVisuals[1].width / fixedConnectionVisuals[1].width - zoomedOutDetailRatio,
  )).toBeLessThan(0.03);
  expect(Math.abs(
    zoomedConnectionVisuals[1].height / fixedConnectionVisuals[1].height - zoomedOutDetailRatio,
  )).toBeLessThan(0.03);
  expect(Math.abs(
    zoomedConnectionVisuals[2].length / fixedConnectionVisuals[2].length - zoomedOutDetailRatio,
  )).toBeLessThan(0.03);
  expect(Math.abs(
    zoomedConnectionVisuals[2].width / fixedConnectionVisuals[2].width - zoomedOutDetailRatio,
  )).toBeLessThan(0.03);
  const overviewLabelBox = await label.boundingBox();
  expect(overviewLabelBox).not.toBeNull();
  await page.mouse.move(
    overviewLabelBox!.x + overviewLabelBox!.width / 2,
    overviewLabelBox!.y + overviewLabelBox!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    overviewLabelBox!.x + overviewLabelBox!.width / 2 + 96,
    overviewLabelBox!.y + overviewLabelBox!.height / 2 + 72,
    { steps: 6 },
  );
  await expect(page.locator('.selection-lasso')).toBeVisible();
  await expect(page.locator('.connection-layer')).toHaveClass(/lasso-hit-disabled/u);
  await page.mouse.up();
  await expect(page.locator('.selection-lasso')).toHaveCount(0);
  await zoomStatus.fill('100');
  await zoomStatus.press('Enter');
  await expect(zoomStatus).toHaveAttribute('aria-label', /100%/u);
  await expect(label).toBeVisible();

  const initialZoomLabel = await zoomStatus.getAttribute('aria-label');
  await page.mouse.move(connectionPoint.x, connectionPoint.y);
  await page.mouse.wheel(0, -240);
  await expect.poll(() => zoomStatus.getAttribute('aria-label')).not.toBe(initialZoomLabel);
  await page.waitForTimeout(180);

  const undo = page.getByRole('button', { name: /^撤销/u });
  const redo = page.getByRole('button', { name: /^重做/u });
  await undo.click();
  await expect.poll(async () => (await label.boundingBox())?.width ?? 0)
    .toBeLessThan(fixedLabelBox!.width - 80);
  await expect.poll(() => labelText.textContent()).toBe(multilineLabel);
  await undo.click();
  await expect(labelText).toHaveText(wrappingLabel);
  await undo.click();
  await expect(label).toHaveCount(0);
  await expect(connection).toHaveCount(1);
  await redo.click();
  await expect(labelText).toHaveText(wrappingLabel);
  await redo.click();
  await expect.poll(() => labelText.textContent()).toBe(multilineLabel);
  await redo.click();
  await expect.poll(async () => (await label.boundingBox())?.width ?? 0)
    .toBeGreaterThan(labelBoxBeforeResize!.width + 80);
  await undo.click();
  await expect.poll(async () => (await label.boundingBox())?.width ?? 0)
    .toBeLessThan(fixedLabelBox!.width - 80);
  await undo.click();
  await expect(labelText).toHaveText(wrappingLabel);
  await undo.click();
  await expect(label).toHaveCount(0);
  await undo.click();
  await expect(connection).toHaveCount(0);
  await redo.click();
  await expect(connection).toHaveCount(1);
  await redo.click();
  await expect(labelText).toHaveText(wrappingLabel);
  await redo.click();
  await expect.poll(() => labelText.textContent()).toBe(multilineLabel);
  await redo.click();
  await expect.poll(async () => (await label.boundingBox())?.width ?? 0)
    .toBeGreaterThan(labelBoxBeforeResize!.width + 80);
});

test('overlapping ordinary endpoints keep their port directions and solid target arrow', async ({ page }) => {
  await openApplication(page);
  const sourceTitle = 'AI 助手使用指南';
  const targetTitle = '画布基本操作指南';
  const sourceCard = page.getByRole('article', { name: `文本节点：${sourceTitle}`, exact: true });
  const targetCard = page.getByRole('article', { name: `文本节点：${targetTitle}`, exact: true });
  await sourceCard.click();
  await targetCard.click({ modifiers: ['Control'] });
  await page.getByRole('group', { name: '选中项工具', exact: true }).getByRole('button', {
    name: '文本框与文字节点相互转换',
    exact: true,
  }).click();

  const source = page.getByRole('article', { name: new RegExp(`文本框：${sourceTitle}$`, 'u') });
  const target = page.getByRole('article', { name: new RegExp(`文本框：${targetTitle}$`, 'u') });
  await page.locator('.canvas-surface').click({ position: { x: 24, y: 24 } });
  const sourceTitleBox = await source.locator('.text-box-title').boundingBox();
  expect(sourceTitleBox).not.toBeNull();
  await page.mouse.move(
    sourceTitleBox!.x + sourceTitleBox!.width / 2,
    sourceTitleBox!.y + sourceTitleBox!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    sourceTitleBox!.x + sourceTitleBox!.width / 2 + 260,
    sourceTitleBox!.y + sourceTitleBox!.height / 2 - 90,
    { steps: 8 },
  );
  await page.mouse.up();

  const sourcePort = source.getByRole('button', { name: `从${sourceTitle}右侧连接`, exact: true });
  const [sourcePortBox, targetBox] = await Promise.all([sourcePort.boundingBox(), target.boundingBox()]);
  expect(sourcePortBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  await sourcePort.hover();
  await page.mouse.down();
  await target.hover({ position: { x: 2, y: targetBox!.height / 2 } });
  await page.mouse.up();

  const hitPath = page.locator('.connection-hit-area');
  await expect(hitPath).toHaveCount(1);
  const hitCoordinates = (await hitPath.getAttribute('d'))?.match(/-?\d+(?:\.\d+)?/gu)?.map(Number) ?? [];
  expect(hitCoordinates).toHaveLength(8);
  expect(hitCoordinates[0]).toBeGreaterThan(hitCoordinates[6]);
  expect(hitCoordinates[2]).toBeGreaterThan(hitCoordinates[0]);
  expect(hitCoordinates[4]).toBeLessThan(hitCoordinates[6]);

  const renderedPath = page.locator('.connection-path').first();
  const renderedCoordinates = (await renderedPath.getAttribute('d'))
    ?.match(/-?\d+(?:\.\d+)?/gu)?.map(Number) ?? [];
  expect(renderedCoordinates.at(-4)).toBeCloseTo(hitCoordinates[6], 4);
  expect(renderedCoordinates.at(-3)).toBeCloseTo(hitCoordinates[7], 4);
  expect(renderedCoordinates.at(-6)).toBeLessThan(renderedCoordinates.at(-4)!);
  expect(renderedCoordinates.at(-2)).toBeLessThan(renderedCoordinates.at(-4)!);
  expect(await renderedPath.evaluate((element) => getComputedStyle(element).fill !== 'none')).toBe(true);
});

test('editor text color stays in the editor while canvas previews keep their default ink', async ({ page }) => {
  await openApplication(page);
  const card = page.getByRole('article', { name: /文本节点：AI 助手使用指南$/u });
  const preview = card.getByRole('paragraph');
  const defaultPreviewColor = await preview.evaluate((element) => getComputedStyle(element).color);

  await preview.dblclick({ position: { x: 80, y: 80 } });
  const editor = page.locator('.editor-writing-area').first();
  await expect(editor).toBeVisible();
  await page.getByRole('button', { name: '文字颜色', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '颜色选择器' });
  const red = picker.getByRole('spinbutton', { name: 'R 通道数值' });
  const green = picker.getByRole('spinbutton', { name: 'G 通道数值' });
  const blue = picker.getByRole('spinbutton', { name: 'B 通道数值' });
  await red.fill('196');
  await expect(preview).toHaveCSS('color', defaultPreviewColor);
  await green.fill('42');
  await blue.fill('42');
  await blue.press('Enter');

  await expect(picker).toHaveCount(0);
  await expect(editor).toHaveCSS('color', 'rgb(196, 42, 42)');
  await expect(preview).toHaveCSS('color', defaultPreviewColor);
});

test('default editor writing ink automatically follows dark and light paper backgrounds', async ({ page }) => {
  await openApplication(page);
  const card = page.getByRole('article', { name: /文本节点：AI 助手使用指南$/u });

  await executeCommand(page, '打开全局颜色设置');
  let panel = page.getByRole('region', { name: '全局颜色设置' });
  await panel.getByRole('button', { name: /^B 暗调/u }).click();
  await page.keyboard.press('Escape');
  await card.getByRole('paragraph').dblclick({ position: { x: 80, y: 80 } });
  let editor = page.locator('.editor-writing-area').first();
  await expect(editor).toHaveCSS('background-color', 'rgb(32, 33, 37)');
  await expect(editor).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect(editor).toHaveCSS('caret-color', 'rgb(255, 255, 255)');

  await executeCommand(page, '打开全局颜色设置');
  panel = page.getByRole('region', { name: '全局颜色设置' });
  await panel.getByRole('button', { name: /^C 护眼/u }).click();
  await page.keyboard.press('Escape');
  await card.getByRole('paragraph').dblclick({ position: { x: 80, y: 80 } });
  editor = page.locator('.editor-writing-area').first();
  await expect(editor).toHaveCSS('background-color', 'rgb(240, 242, 232)');
  await expect(editor).toHaveCSS('color', 'rgb(24, 24, 26)');
  await expect(editor).toHaveCSS('caret-color', 'rgb(24, 24, 26)');
});

test('editor undo and redo reload the authoritative revision and remain editable', async ({ page }) => {
  await openApplication(page);
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  const card = page.getByRole('article', { name: '文本节点：未命名节点', exact: true });
  await card.getByRole('paragraph').dblclick({ position: { x: 80, y: 80 } });
  const editor = page.locator('.editor-writing-area').first();
  await editor.focus();
  await editor.pressSequentially('编辑器撤销测试');
  await expect(editor).toContainText('编辑器撤销测试');
  await page.keyboard.press('Control+z');
  await expect(editor).not.toContainText('编辑器撤销测试');
  await page.keyboard.press('Control+Shift+z');
  await expect(editor).toContainText('编辑器撤销测试');
  await page.keyboard.press('Control+z');
  await editor.focus();
  await editor.pressSequentially('撤销后继续输入');
  await expect(editor).toContainText('撤销后继续输入');
  await expect(page.locator('.editor-error')).toHaveCount(0);
});

test('canvas node, editor and selected-node counts use the same visible-character metric', async ({ page }) => {
  await openApplication(page);
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  const card = page.getByRole('article', { name: /文本节点：未命名节点$/u });
  await card.getByRole('paragraph').dblclick({ position: { x: 80, y: 80 } });
  const editor = page.locator('.editor-writing-area').first();
  await editor.focus();
  await editor.pressSequentially('你，好');
  await page.keyboard.insertText('👨‍👩‍👧‍👦');
  await editor.press('Enter');
  await editor.pressSequentially('A');
  await page.keyboard.insertText('字'.repeat(1000));

  await expect(page.locator('.editor-metrics')).toContainText('字数 1,005');
  await expect(page.locator('.editor-metrics').getByText('字数 1,005')).toHaveAttribute('title', /包含标点和组合 Emoji/u);
  await expect(card.locator('.node-count')).toHaveText('1,005');
  await expect(card.locator('.node-count')).toHaveAttribute('title', /包含标点和组合 Emoji/u);
  await expect(page.locator('.toolbar-statistics')).toHaveText('1 / 1,005');
  await expect(page.locator('.toolbar-statistics')).toHaveAttribute(
    'title',
    /包含标点和组合 Emoji，不含空格、制表符和换行/u,
  );
});

test('dragging selected editor text moves once and undo and redo replay it', async ({ page }) => {
  await openApplication(page);
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  const card = page.getByRole('article', { name: '文本节点：未命名节点', exact: true });
  await card.getByRole('paragraph').dblclick({ position: { x: 80, y: 80 } });
  const editor = page.locator('.editor-writing-area').first();
  await editor.focus();
  await editor.pressSequentially('甲乙丙丁');
  await expect(editor).toContainText('甲乙丙丁');

  await dragEditorSelection(editor, 1, 3, 0);
  await expect(editor).toHaveText('乙丙甲丁');
  await page.keyboard.press('Control+z');
  await expect(editor).toHaveText('甲乙丙丁');
  await page.keyboard.press('Control+y');
  await expect(editor).toHaveText('乙丙甲丁');
});

test('annotated editor text keeps its annotation through drag, copy, cut and paste', async ({ page, browserName }) => {
  await openApplication(page);
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  const card = page.getByRole('article', { name: '文本节点：未命名节点', exact: true });
  await card.getByRole('paragraph').dblclick({ position: { x: 80, y: 80 } });
  const editor = page.locator('.editor-writing-area').first();
  await editor.focus();
  await editor.pressSequentially('甲乙丙丁');
  await selectEditorRange(editor, 3);
  await page.getByRole('button', { name: '添加注释', exact: true }).click();
  await page.getByRole('textbox', { name: '注释正文' }).fill('随文字传递');
  await page.getByRole('button', { name: '关闭注释', exact: true }).click();
  await expect(page.locator('.editor-annotation-marker')).toHaveCount(1);
  await expect(page.locator('.editor-annotation-marker')).toHaveAttribute('data-annotation-offset', '3');

  await dragEditorSelection(editor, 1, 3, 0);
  await expect(editor).toHaveText('乙丙甲丁');
  const marker = page.locator('.editor-annotation-marker');
  await expect(marker).toHaveCount(1);
  await expect(marker).toHaveAttribute('data-annotation-offset', '2');
  await editor.press('End');
  await editor.pressSequentially('戊');
  await expect(editor).toHaveText('乙丙甲丁戊');

  await selectEditorRange(editor, 0, 2);
  const copied = browserName === 'chromium'
    ? (await page.keyboard.press('Control+c'), undefined)
    : await dispatchEditorClipboard(editor, 'copy');
  await selectEditorRange(editor, 5);
  if (copied) await dispatchEditorClipboard(editor, 'paste', copied);
  else await page.keyboard.press('Control+v');
  await expect(editor).toHaveText('乙丙甲丁戊乙丙');
  await expect(page.locator('.editor-annotation-marker')).toHaveCount(2);

  await selectEditorRange(editor, 0, 2);
  const cut = browserName === 'chromium'
    ? (await page.keyboard.press('Control+x'), undefined)
    : await dispatchEditorClipboard(editor, 'cut');
  await expect(editor).toHaveText('甲丁戊乙丙');
  await expect(page.locator('.editor-annotation-marker')).toHaveCount(1);
  await selectEditorRange(editor, 5);
  if (cut) await dispatchEditorClipboard(editor, 'paste', cut);
  else await page.keyboard.press('Control+v');
  await expect(editor).toHaveText('甲丁戊乙丙乙丙');
  await expect(page.locator('.editor-annotation-marker')).toHaveCount(2);
});

test('dragging selected editor text to another input copies without changing the source', async ({ page }) => {
  await openApplication(page);
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  const card = page.getByRole('article', { name: '文本节点：未命名节点', exact: true });
  await card.getByRole('paragraph').dblclick({ position: { x: 80, y: 80 } });
  const editor = page.locator('.editor-writing-area').first();
  await editor.focus();
  await editor.pressSequentially('甲乙丙丁');
  await page.getByRole('button', { name: '查找替换', exact: true }).click();
  const searchInput = page.locator('#search-query');
  await expect(searchInput).toBeVisible();

  await dragEditorSelectionOutside(editor, 1, 3, '#search-query');

  await expect(editor).toHaveText('甲乙丙丁');
  await expect(searchInput).toHaveValue('乙丙');
});

test('selected and whole-canvas replacement remain usable after undo', async ({ page }) => {
  await openApplication(page);
  await page.getByRole('button', { name: '查找替换', exact: true }).click();
  const panel = page.getByRole('region', { name: '查找与替换' });
  const searchInput = panel.getByRole('textbox', { name: '查找标题和正文' });
  const replacementInput = panel.getByRole('textbox', { name: '替换为' });
  await searchInput.fill('指南');
  await searchInput.press('Enter');
  const canvasGuideResult = panel.getByRole('option').filter({ hasText: '画布基本操作指南' });
  await expect(canvasGuideResult).toBeVisible();
  await canvasGuideResult.click();
  await expect(panel.getByRole('button', { name: '替换所选节点', exact: true })).toBeVisible();

  const bodyQuery = '新节点会出现在当前视图中间';
  await searchInput.fill(bodyQuery);
  await searchInput.press('Enter');
  const bodyResult = panel.getByRole('option').filter({ hasText: '画布基本操作指南' });
  await expect(bodyResult).toContainText('正文 1 处');
  await bodyResult.click();
  const nextButton = panel.getByRole('button', { name: '下一个', exact: true });
  await nextButton.click();
  const textEditor = page.getByRole('region', { name: '文本编辑区' });
  await expect(textEditor).toBeVisible();
  await expect(panel.getByRole('button', { name: '替换当前一处', exact: true })).toBeVisible();

  await bodyResult.click();
  await expect(textEditor).toBeVisible();
  await expect(panel.getByRole('button', { name: '替换所选节点', exact: true })).toBeVisible();

  await searchInput.fill('指南');
  await searchInput.press('Enter');
  await expect(canvasGuideResult).toBeVisible();
  await canvasGuideResult.click();
  await expect(textEditor).toBeVisible();
  await expect(panel.getByRole('button', { name: '替换所选节点', exact: true })).toBeVisible();

  await replacementInput.fill('手册');
  await panel.getByRole('button', { name: '替换所选节点', exact: true }).click();
  await expect(page.getByRole('article', { name: /文本节点：画布基本操作手册/u })).toBeVisible();
  await expect(page.getByRole('article', { name: /文本节点：AI 助手使用指南/u })).toBeVisible();

  await page.keyboard.press('Control+z');
  await expect(page.getByRole('article', { name: /文本节点：画布基本操作指南/u })).toBeVisible();
  await expect(canvasGuideResult).toBeVisible();
  const canvas = page.locator('.canvas-surface');
  const canvasBox = await canvas.boundingBox();
  expect(canvasBox).not.toBeNull();
  await page.mouse.click(canvasBox!.x + canvasBox!.width / 2, canvasBox!.y + canvasBox!.height - 24);
  await expect(textEditor).toBeVisible();
  await expect(panel.getByRole('button', { name: '替换全画布', exact: true })).toBeVisible();

  await replacementInput.fill('教程');
  await panel.getByRole('button', { name: '替换全画布', exact: true }).click();
  await expect(page.getByRole('article', { name: /文本节点：画布基本操作教程/u })).toBeVisible();
  await expect(page.getByRole('article', { name: /文本节点：AI 助手使用教程/u })).toBeVisible();

  await page.keyboard.press('Control+z');
  await expect(page.getByRole('article', { name: /文本节点：画布基本操作指南/u })).toBeVisible();
  await expect(page.getByRole('article', { name: /文本节点：AI 助手使用指南/u })).toBeVisible();
  await expect(panel.getByRole('option').filter({ hasText: '画布基本操作指南' })).toBeVisible();
  await replacementInput.fill('终稿');
  await panel.getByRole('button', { name: '替换全画布', exact: true }).click();
  await expect(page.getByRole('article', { name: /文本节点：画布基本操作终稿/u })).toBeVisible();
  await expect(page.getByRole('article', { name: /文本节点：AI 助手使用终稿/u })).toBeVisible();
});

test('selected and whole-canvas replacement refresh an already open editor', async ({ page }) => {
  await openApplication(page);
  await page.getByRole('button', { name: '查找替换', exact: true }).click();
  const panel = page.getByRole('region', { name: '查找与替换' });
  const searchInput = panel.getByRole('textbox', { name: '查找标题和正文' });
  const replacementInput = panel.getByRole('textbox', { name: '替换为' });
  await searchInput.fill('画布');
  await searchInput.press('Enter');
  const result = panel.getByRole('option').filter({ hasText: '画布基本操作指南' });
  await result.click();
  const nextButton = panel.getByRole('button', { name: '下一个', exact: true });
  await nextButton.click();
  await nextButton.click();
  const editor = page.locator('.editor-writing-area').first();
  await expect(editor).toBeVisible();
  await expect.poll(() => editor.evaluate(() => globalThis.getSelection()?.toString() ?? '')).toBe('画布');
  const initialRevision = Number(await editor.getAttribute('data-content-revision'));

  await result.click();
  await replacementInput.fill('画面');
  await panel.getByRole('button', { name: '替换所选节点', exact: true }).click();
  await expect(page.getByRole('article', { name: /文本节点：画面基本操作指南/u })).toBeVisible();
  await expect(editor).toContainText('画面');
  await expect(editor).not.toContainText('画布');
  await expect(editor).toHaveAttribute('data-content-revision', String(initialRevision + 1));

  await page.keyboard.press('Control+z');
  await expect(editor).toContainText('画布');
  await expect(editor).toHaveAttribute('data-content-revision', String(initialRevision));
  await expect(result).toContainText(/正文 [1-9]\d* 处/u);
  const canvas = page.locator('.canvas-surface');
  const canvasBox = await canvas.boundingBox();
  expect(canvasBox).not.toBeNull();
  await page.mouse.click(canvasBox!.x + canvasBox!.width / 2, canvasBox!.y + canvasBox!.height - 24);
  await expect(panel.getByRole('button', { name: '替换全画布', exact: true })).toBeVisible();

  await replacementInput.fill('场景');
  await panel.getByRole('button', { name: '替换全画布', exact: true }).click();
  const renamedCard = page.getByRole('article', { name: /文本节点：场景基本操作指南/u });
  await expect(renamedCard).toBeVisible();
  await expect(renamedCard.getByRole('paragraph')).not.toContainText('画布');
  await expect(editor).toHaveAttribute('data-content-revision', String(initialRevision + 1));
  await expect(editor).toContainText('场景');
  await expect(editor).not.toContainText('画布');
});

test('current replacement keeps next navigation after the replaced occurrence', async ({ page }) => {
  await openApplication(page);
  await page.getByRole('button', { name: '查找替换', exact: true }).click();
  const panel = page.getByRole('region', { name: '查找与替换' });
  const searchInput = panel.getByRole('textbox', { name: '查找标题和正文' });
  await searchInput.fill('画布');
  await searchInput.press('Enter');
  const result = panel.getByRole('option').filter({ hasText: '画布基本操作指南' });
  await result.click();
  const nextButton = panel.getByRole('button', { name: '下一个', exact: true });
  await nextButton.click();
  await nextButton.click();
  const editor = page.locator('.editor-writing-area').first();
  await expect(editor).toBeVisible();
  await expect.poll(() => editor.evaluate(() => globalThis.getSelection()?.toString() ?? '')).toBe('画布');
  const replacedRange = await readEditorSelection(editor);

  await panel.getByRole('textbox', { name: '替换为' }).fill('画面');
  await panel.getByRole('button', { name: '替换当前一处', exact: true }).click();
  await expect.poll(() => editor.evaluate(() => globalThis.getSelection()?.toString() ?? '')).toBe('画布');
  const automaticRange = await readEditorSelection(editor);
  expect(automaticRange.start).toBeGreaterThan(replacedRange.start);

  await nextButton.click();
  await expect.poll(() => editor.evaluate(() => globalThis.getSelection()?.toString() ?? '')).toBe('画布');
  const nextRange = await readEditorSelection(editor);
  expect(nextRange.start).toBeGreaterThan(automaticRange.start);
  await expect(page.locator('.node-title-search-hit')).toHaveCount(0);
});

test('current replacement keeps previous navigation before the replaced occurrence', async ({ page }) => {
  await openApplication(page);
  await page.getByRole('button', { name: '查找替换', exact: true }).click();
  const panel = page.getByRole('region', { name: '查找与替换' });
  const searchInput = panel.getByRole('textbox', { name: '查找标题和正文' });
  await searchInput.fill('画布');
  await searchInput.press('Enter');
  const result = panel.getByRole('option').filter({ hasText: '画布基本操作指南' });
  await result.click();
  const nextButton = panel.getByRole('button', { name: '下一个', exact: true });
  await nextButton.click();
  await nextButton.click();
  await nextButton.click();
  await nextButton.click();
  const editor = page.locator('.editor-writing-area').first();
  await expect(editor).toBeVisible();
  await expect.poll(() => editor.evaluate(() => globalThis.getSelection()?.toString() ?? '')).toBe('画布');

  await panel.getByRole('button', { name: '上一个', exact: true }).click();
  await expect.poll(() => editor.evaluate(() => globalThis.getSelection()?.toString() ?? '')).toBe('画布');
  const replacedRange = await readEditorSelection(editor);
  await panel.getByRole('textbox', { name: '替换为' }).fill('画面');
  await panel.getByRole('button', { name: '替换当前一处', exact: true }).click();
  await expect.poll(() => editor.evaluate(() => globalThis.getSelection()?.toString() ?? '')).toBe('画布');
  const previousRange = await readEditorSelection(editor);
  expect(previousRange.start).toBeLessThan(replacedRange.start);
  await expect(page.locator('.node-title-search-hit')).toHaveCount(0);
});

test('search navigation highlights title hits and opens the matching body editor', async ({ page }) => {
  await openApplication(page);
  await page.getByRole('button', { name: '查找替换', exact: true }).click();
  const panel = page.getByRole('region', { name: '查找与替换' });
  const searchInput = panel.getByRole('textbox', { name: '查找标题和正文' });
  await searchInput.fill('画布基本操作指南');
  await searchInput.press('Enter');
  await expect(searchInput).toHaveValue('画布基本操作指南');

  const result = panel.getByRole('option').filter({ hasText: '画布基本操作指南' });
  await expect(result).toBeVisible();
  await expect(result).toContainText('标题 1 处');
  await expect(panel.getByRole('button', { name: '替换全画布', exact: true })).toBeVisible();
  await expect.poll(async () => Math.round((await result.boundingBox())?.height ?? 0)).toBe(72);
  const panelHeight = Math.round((await panel.boundingBox())?.height ?? 0);
  await panel.getByRole('button', { name: '调整查找与替换大小', exact: true }).press('Shift+ArrowUp');
  await expect.poll(async () => Math.round((await panel.boundingBox())?.height ?? 0)).toBe(panelHeight - 40);
  await expect.poll(async () => Math.round((await result.boundingBox())?.height ?? 0)).toBe(72);
  await result.click();

  const card = page.getByRole('article', { name: '已选中，文本节点：画布基本操作指南', exact: true });
  await expect(card).toHaveClass(/selected/u);
  await expect(result).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByRole('button', { name: '替换所选节点', exact: true })).toBeVisible();

  await panel.getByRole('button', { name: '下一个', exact: true }).click();
  const titleMatch = card.locator('.node-title-search-hit');
  await expect(titleMatch).toHaveText('画布基本操作指南');
  await expect(titleMatch).toHaveCSS('background-color', 'rgb(10, 132, 255)');
  await expect(page.getByRole('region', { name: '文本编辑区' })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: '替换当前一处', exact: true })).toBeVisible();

  await panel.getByRole('textbox', { name: '替换为' }).fill('画布操作手册');
  await panel.getByRole('button', { name: '替换当前一处', exact: true }).click();
  const renamedCard = page.getByRole('article', { name: '已选中，文本节点：画布操作手册', exact: true });
  await expect(renamedCard).toBeVisible();
  await expect(panel.getByRole('option').filter({ hasText: '画布基本操作指南' })).toHaveCount(0);

  const bodyQuery = '新节点会出现在当前视图中间';
  await searchInput.fill(bodyQuery);
  await searchInput.press('Enter');
  await expect(panel.getByRole('option').filter({ hasText: '画布操作手册' })).toContainText('正文 1 处');
  await panel.getByRole('button', { name: '下一个', exact: true }).click();
  await expect(page.getByRole('region', { name: '文本编辑区' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '节点标题' })).toHaveValue('画布操作手册');
  const editor = page.locator('.editor-writing-area').first();
  await expect.poll(() => editor.evaluate(() => globalThis.getSelection()?.toString() ?? '')).toBe(bodyQuery);
});

test('dragging selected editor text to the canvas creates a copy without changing the source', async ({ page }) => {
  await openApplication(page);
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  const card = page.getByRole('article', { name: '文本节点：未命名节点', exact: true });
  await card.getByRole('paragraph').dblclick({ position: { x: 80, y: 80 } });
  const editor = page.locator('.editor-writing-area').first();
  await editor.focus();
  await editor.pressSequentially('甲乙丙丁');

  const dropHint = await dragEditorSelectionOutside(editor, 1, 3, '.canvas-surface');

  expect(dropHint).toContain('松开以创建继承所选文字的文本节点');
  await expect(editor).toHaveText('甲乙丙丁');
  const droppedCard = page.getByRole('article', { name: '文本节点：乙丙', exact: true });
  await expect(droppedCard).toBeVisible();
  await expect(droppedCard.getByRole('paragraph')).toHaveText('乙丙');
  await page.keyboard.press('Control+z');
  await expect(droppedCard).toHaveCount(0);
  await page.keyboard.press('Control+y');
  await expect(droppedCard).toBeVisible();
  await expect(droppedCard.getByRole('paragraph')).toHaveText('乙丙');
});

test('native fullscreen exit also closes immersive writing when the browser consumes Escape', async ({ page }) => {
  await page.addInitScript(() => {
    let fullscreen: Element | null = null;
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => fullscreen,
    });
    Object.defineProperty(Element.prototype, 'requestFullscreen', {
      configurable: true,
      value: async () => {
        fullscreen = document.documentElement;
        document.dispatchEvent(new Event('fullscreenchange'));
      },
    });
    Object.defineProperty(document, 'exitFullscreen', {
      configurable: true,
      value: async () => {
        fullscreen = null;
        document.dispatchEvent(new Event('fullscreenchange'));
      },
    });
    Reflect.set(globalThis, '__echo8DismissNativeFullscreen', () => {
      fullscreen = null;
      document.dispatchEvent(new Event('fullscreenchange'));
    });
  });
  await openApplication(page);
  const card = page.getByRole('article', { name: /文本节点：/u }).first();
  await card.getByRole('paragraph').dblclick({ position: { x: 80, y: 80 } });
  await page.getByRole('button', { name: '进入沉浸式写作', exact: true }).click();
  await expect(page.getByRole('region', { name: '沉浸式写作' })).toBeVisible();

  await page.evaluate(() => (Reflect.get(globalThis, '__echo8DismissNativeFullscreen') as () => void)());
  await expect(page.getByRole('region', { name: '沉浸式写作' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: '文本编辑区' })).toBeVisible();
});

test('editor opens beside floating tools, renames once and closes without a stuck command', async ({ page }) => {
  await openApplication(page);
  const visibleCard = page.getByRole('article', { name: /文本节点：/u }).last();

  await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
  await page.getByRole('button', { name: '查找替换', exact: true }).click();
  await expect(page.getByRole('region', { name: 'AI 助手' })).toBeVisible();
  await expect(page.getByRole('region', { name: '查找与替换' })).toBeVisible();

  // Both floating tools may overlap the centre of a card. Use the still-visible strip,
  // just as a user would, to prove that an editor can be opened without closing either tool.
  await visibleCard.getByRole('paragraph').dblclick({ position: { x: 100, y: 200 } });
  const title = page.getByRole('textbox', { name: '节点标题' });
  await expect(title).toBeVisible();
  await expect(page.getByRole('region', { name: 'AI 助手' })).toBeVisible();
  await expect(page.getByRole('region', { name: '查找与替换' })).toBeVisible();

  await title.fill('浏览器回归节点');
  await title.press('Tab');
  await expect(page.getByRole('article', { name: '文本节点：浏览器回归节点' })).toBeVisible();
  await page.getByRole('button', { name: '关闭编辑器' }).click();
  await expect(title).toHaveCount(0);
});

test('completion leaves the caret outside its node link and rapid format changes stay synchronized', async ({ page }) => {
  await openApplication(page);
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  const card = page.getByRole('article', { name: '文本节点：未命名节点', exact: true });
  await card.getByRole('paragraph').dblclick({ position: { x: 80, y: 80 } });
  const editor = page.locator('.editor-writing-area').first();
  await expect(editor).toBeVisible();
  await editor.focus();
  await editor.pressSequentially('画布基');
  const completion = page.getByRole('listbox', { name: '文字补全候选' });
  await expect(completion).toBeVisible({ timeout: 10_000 });
  await expect(completion.getByRole('option', { name: /画布基本操作指南/u }))
    .toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect.poll(() => editor.evaluate((root) => {
    const selection = getSelection();
    if (!selection?.focusNode || !root.contains(selection.focusNode)) return -1;
    const range = document.createRange();
    range.selectNodeContents(root);
    range.setEnd(selection.focusNode, selection.focusOffset);
    return range.toString().length;
  })).toBe('画布基本操作指南'.length);
  await editor.pressSequentially('继续');
  await expect(editor).toContainText('画布基本操作指南继续');
  await expect(editor.locator('.text-assist-reference')).toHaveText('画布基本操作指南');

  // Exercise the browser-native fallback used by IME and engines that do not
  // consistently honour plaintext-only beforeinput cancellation. Even when
  // the browser first appends text inside the decorated span, the editor must
  // synchronously project that text back outside the node-link range.
  const nativeFallback = await editor.evaluate((root) => {
    const reference = root.querySelector<HTMLElement>('.text-assist-reference');
    if (!reference) throw new Error('missing node reference decoration');
    reference.append('兼容');
    const range = document.createRange();
    range.selectNodeContents(reference);
    range.collapse(false);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    root.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      data: '兼容',
      inputType: 'insertCompositionText',
    }));
    return {
      reference: root.querySelector<HTMLElement>('.text-assist-reference')?.textContent,
      text: root.textContent,
    };
  });
  expect(nativeFallback.reference).toBe('画布基本操作指南');
  expect(nativeFallback.text).toBe('画布基本操作指南兼容继续');

  await editor.focus();
  await page.keyboard.press('Control+a');
  await page.getByLabel('字号').selectOption('20');
  await expect.poll(() => editor.locator('span').first().evaluate((element) => getComputedStyle(element).fontSize))
    .toBe('20px');
  await editor.focus();
  await editor.press('End');
  await editor.pressSequentially('快速输入');
  await page.getByLabel('字重').selectOption('600');
  await editor.focus();
  await editor.press('End');
  await editor.pressSequentially('保持稳定');
  await expect(page.locator('.editor-error')).toHaveCount(0);
  await expect(editor).toContainText('画布基本操作指南兼容继续快速输入保持稳定');
});

test('completion follows a multiline caret and Escape dismisses only the active candidate list', async ({ page }) => {
  await openApplication(page);
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  const card = page.getByRole('article', { name: '文本节点：未命名节点', exact: true });
  await card.getByRole('paragraph').dblclick({ position: { x: 80, y: 80 } });
  const editor = page.locator('.editor-writing-area').first();
  await editor.focus();
  for (let index = 0; index < 4; index += 1) {
    await editor.pressSequentially(`定位行${index + 1}`);
    await editor.press('Enter');
  }
  await editor.pressSequentially('画布基');
  const completion = page.getByRole('listbox', { name: '文字补全候选' });
  await expect(completion).toBeVisible({ timeout: 10_000 });
  const editorBox = await editor.boundingBox();
  const menuBox = await completion.boundingBox();
  expect(editorBox).not.toBeNull();
  expect(menuBox).not.toBeNull();
  expect((menuBox?.y ?? 0) - (editorBox?.y ?? 0)).toBeGreaterThan(70);
  expect((menuBox?.x ?? 0) - (editorBox?.x ?? 0)).toBeGreaterThan(30);

  await page.keyboard.press('Escape');
  await expect(completion).toHaveCount(0);
  await expect(editor).toBeVisible();
  await expect(editor).toBeFocused();
});

test('command palette and Escape close surfaces without leaking shortcuts into editors', async ({ page }) => {
  await openApplication(page);

  await page.keyboard.press('Control+k');
  const commandPalette = page.getByRole('dialog', { name: '命令面板' });
  await expect(commandPalette).toBeVisible();
  await expect(commandPalette.getByRole('group', { name: '书籍与同步' })).toBeVisible();
  await expect(commandPalette.getByRole('group', { name: '画布与节点' })).toBeVisible();
  await expect(commandPalette.getByRole('group', { name: '选择与排列' })).toBeVisible();
  await expect(commandPalette.getByRole('group', { name: 'AI' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(commandPalette).toHaveCount(0);

  await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
  await page.getByRole('button', { name: '查找替换', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: '查找与替换' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'AI 助手' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: 'AI 助手' })).toHaveCount(0);
});

test('command palette text follows the luminance of its own panel background', async ({ page }) => {
  await openApplication(page);
  await executeCommand(page, '打开全局颜色设置');
  const colorPanel = page.getByRole('region', { name: '全局颜色设置' });
  const darkPreset = colorPanel.getByRole('button', { name: /^B 暗调/u });
  await darkPreset.click();
  await expect(darkPreset).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');

  await page.keyboard.press('Control+k');
  let commandPalette = page.getByRole('dialog', { name: '命令面板' });
  await expect(commandPalette).toHaveCSS('background-color', 'rgb(27, 28, 31)');
  await expect(commandPalette).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect(commandPalette.getByRole('textbox', { name: '搜索命令' })).toHaveCSS(
    'color',
    'rgb(255, 255, 255)',
  );
  await expect(commandPalette.getByRole('option').first()).toHaveCSS('color', 'rgb(255, 255, 255)');
  await page.keyboard.press('Escape');

  await executeCommand(page, '打开全局颜色设置');
  const brightPreset = colorPanel.getByRole('button', { name: /^A 明调/u });
  await brightPreset.click();
  await expect(brightPreset).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');

  await page.keyboard.press('Control+k');
  commandPalette = page.getByRole('dialog', { name: '命令面板' });
  await expect(commandPalette).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(commandPalette).toHaveCSS('color', 'rgb(24, 24, 26)');
  await expect(commandPalette.getByRole('textbox', { name: '搜索命令' })).toHaveCSS(
    'color',
    'rgb(24, 24, 26)',
  );
});

test('governed panels, popup controls and notices follow the panel background luminance', async ({ page }) => {
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(message.text());
  });
  await openApplication(page);

  await executeCommand(page, '打开全局颜色设置');
  const colorPanel = page.getByRole('region', { name: '全局颜色设置' });
  const darkPreset = colorPanel.getByRole('button', { name: /^B 暗调/u });
  await darkPreset.click();
  await expect(darkPreset).toHaveAttribute('aria-pressed', 'true');
  await expect(colorPanel).toHaveCSS('background-color', 'rgb(27, 28, 31)');
  await expect(colorPanel).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect(colorPanel.getByRole('heading', { name: '全局颜色设置' })).toHaveCSS(
    'color',
    'rgb(255, 255, 255)',
  );

  await colorPanel.getByRole('button', { name: '画布背景颜色' }).click();
  const colorPicker = page.getByRole('dialog', { name: '颜色选择器' });
  await expect(colorPicker).toHaveCSS('background-color', 'rgb(27, 28, 31)');
  await expect(colorPicker).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect(colorPicker.getByRole('spinbutton', { name: 'R 通道数值' })).toHaveCSS(
    'color',
    'rgb(255, 255, 255)',
  );
  await page.keyboard.press('Escape');
  await expect(colorPicker).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(colorPanel).toHaveCount(0);

  const panels = [
    ['打开插件中心', '插件中心'],
    ['打开快捷键中心', '快捷键中心'],
    ['查看内核与诊断', '诊断中心'],
    ['打开全局颜色设置', '全局颜色设置'],
    ['书籍与恢复设置', '书籍与恢复'],
  ] as const;
  for (const [action, region] of panels) {
    await executeCommand(page, action);
    const panel = page.getByRole('region', { name: region });
    await expect(panel).toBeVisible();
    await expect(panel).toHaveCSS('background-color', 'rgb(27, 28, 31)');
    await expect(panel).toHaveCSS('color', 'rgb(255, 255, 255)');
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
  }

  await page.locator('.task-notice-layer').evaluate((layer) => {
    layer.insertAdjacentHTML(
      'beforeend',
      '<section class="task-notice-center e2e-task-notice-center"><article class="task-notice"><span class="task-notice-copy"><strong>后台提示</strong><small>提示详情</small></span></article></section>',
    );
  });
  const notice = page.locator('.e2e-task-notice-center .task-notice');
  await expect(notice).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect(notice.getByText('提示详情')).not.toHaveCSS('color', 'rgb(112, 112, 117)');
  await page.locator('.e2e-task-notice-center').evaluate((element) => element.remove());

  await executeCommand(page, '打开全局颜色设置');
  const brightPreset = colorPanel.getByRole('button', { name: /^A 明调/u });
  await brightPreset.click();
  await expect(brightPreset).toHaveAttribute('aria-pressed', 'true');
  await expect(colorPanel).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(colorPanel).toHaveCSS('color', 'rgb(24, 24, 26)');
  await page.keyboard.press('Escape');

  await page.waitForTimeout(100);
  await expect(page.getByText('插件界面已隔离')).toHaveCount(0);
  expect(failures).toEqual([]);
});

test('global color presets keep canvas strokes adaptive on bright, dark and eye-care backgrounds', async ({ page }) => {
  await openApplication(page);
  await executeCommand(page, '打开全局颜色设置');
  const panel = page.getByRole('region', { name: '全局颜色设置' });
  const canvas = page.locator('.canvas-surface');

  await expect(canvas).toHaveCSS('background-color', 'rgb(239, 239, 236)');
  await expect.poll(() => canvas.evaluate((element) =>
    getComputedStyle(element).getPropertyValue('--canvas-selection').trim()
  )).toBe('#66666b');
  const selectedCard = page.locator('.text-node-card').first();
  await selectedCard.click({ position: { x: 80, y: 28 } });
  await expect.poll(() => selectedNodeOverlayStyle(selectedCard)).toMatchObject({
    borderColor: 'rgb(102, 102, 107)',
    borderWidth: '4px',
  });
  await expect(selectedCard).toHaveCSS('border-top-width', '1px');

  await panel.getByRole('button', { name: /^B 暗调/u }).click();
  await expect(canvas).toHaveCSS('background-color', 'rgb(24, 25, 27)');
  await expect.poll(() => canvas.evaluate((element) => ({
    line: getComputedStyle(element).getPropertyValue('--canvas-line').trim(),
    selection: getComputedStyle(element).getPropertyValue('--canvas-selection').trim(),
  }))).toEqual({ line: '#666768', selection: '#ffffff' });
  await expect.poll(() => page.locator('.connection-layer, .group-layer').evaluateAll((elements) =>
    elements.map((element) => ({
      line: getComputedStyle(element).getPropertyValue('--canvas-line').trim(),
      selection: getComputedStyle(element).getPropertyValue('--canvas-selection').trim(),
    }))
  )).toEqual([
    { line: '#666768', selection: '#ffffff' },
    { line: '#666768', selection: '#ffffff' },
  ]);
  await page.locator('.connection-layer').evaluate((element) => {
    element.insertAdjacentHTML(
      'beforeend',
      '<path class="connection-path e2e-connection-ink" d="M 0 0 L 8 0"></path>'
        + '<path class="connection-path selected e2e-connection-selection-ink" d="M 0 0 L 8 0"></path>',
    );
  });
  await expect(page.locator('.e2e-connection-ink')).toHaveCSS('stroke', 'rgb(102, 103, 104)');
  await expect(page.locator('.e2e-connection-selection-ink')).toHaveCSS('stroke', 'rgb(255, 255, 255)');
  await page.locator('.e2e-connection-ink, .e2e-connection-selection-ink').evaluateAll((elements) =>
    elements.forEach((element) => element.remove()));

  const canvasBox = await canvas.boundingBox();
  expect(canvasBox).not.toBeNull();
  await page.mouse.move((canvasBox?.x ?? 0) + 16, (canvasBox?.y ?? 0) + 16);
  await page.mouse.down();
  await page.mouse.move((canvasBox?.x ?? 0) + 76, (canvasBox?.y ?? 0) + 66, { steps: 4 });
  await expect(page.locator('.selection-lasso')).toHaveCSS('border-color', 'rgb(255, 255, 255)');
  await page.mouse.up();

  await panel.getByRole('button', { name: /^C 护眼/u }).click();
  await expect(canvas).toHaveCSS('background-color', 'rgb(228, 232, 218)');
  await expect.poll(() => canvas.evaluate((element) =>
    getComputedStyle(element).getPropertyValue('--canvas-selection').trim()
  )).toBe('#66666b');
  await selectedCard.click({ position: { x: 80, y: 28 } });
  await expect.poll(() => selectedNodeOverlayStyle(selectedCard)).toMatchObject({
    borderColor: 'rgb(102, 102, 107)',
  });

  await panel.getByRole('button', { name: '重置全部颜色', exact: true }).click();
  await expect(canvas).toHaveCSS('background-color', 'rgb(239, 239, 236)');
  await expect.poll(() => page.locator('.top-bar').evaluate((element) =>
    getComputedStyle(element).getPropertyValue('--toolbar').trim()
  )).toBe('#fafaf9');
});

test('a custom-color connection keeps the exact picker color through selection and hover', async ({ page }) => {
  await openApplication(page);
  const cards = page.locator('.text-node-card');
  await cards.nth(0).click({ position: { x: 80, y: 90 } });
  await cards.nth(1).click({ position: { x: 80, y: 90 }, modifiers: ['Shift'] });
  await page.getByRole('button', { name: /^连接两个节点/u }).click();

  const hitArea = page.locator('.connection-hit-area').first();
  const renderedConnection = page.locator('.connection-path').first();
  await hitArea.click({ force: true });
  await page.getByRole('button', { name: '修改选中项颜色', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '颜色选择器' });
  await picker.getByRole('spinbutton', { name: 'R 通道数值' }).fill('255');
  await picker.getByRole('spinbutton', { name: 'G 通道数值' }).fill('238');
  const blue = picker.getByRole('spinbutton', { name: 'B 通道数值' });
  await blue.fill('0');
  await blue.press('Enter');

  await expect(renderedConnection).toHaveClass(/\bselected\b/u);
  await expect(renderedConnection).toHaveClass(/\bcustom-color\b/u);
  await expect(renderedConnection).toHaveCSS('filter', 'none');
  const selectedAppearance = await renderedConnection.evaluate((element) => {
    const style = getComputedStyle(element);
    return { fill: style.fill, stroke: style.stroke, width: style.strokeWidth };
  });
  expect(selectedAppearance.fill).toBe('rgb(255, 238, 0)');
  expect(selectedAppearance.stroke).toBe('rgb(255, 238, 0)');
  expect(Number.parseFloat(selectedAppearance.width)).toBeGreaterThan(1.5);

  await page.keyboard.press('Escape');
  await expect(renderedConnection).not.toHaveClass(/\bselected\b/u);
  await page.mouse.move(12, 12);
  await expect(renderedConnection).toHaveCSS('stroke', 'rgb(255, 238, 0)');
  await expect(renderedConnection).toHaveCSS('stroke-width', '1.5px');
  await hitArea.hover({ force: true });
  await expect.poll(() => renderedConnection.evaluate((element) => {
    const style = getComputedStyle(element);
    return { fill: style.fill, stroke: style.stroke, width: style.strokeWidth };
  })).toEqual(selectedAppearance);
});

test('global color settings preview, save, undo and redo the connection curve color', async ({ page }) => {
  await openApplication(page);
  const cards = page.locator('.text-node-card');
  await cards.nth(0).click({ position: { x: 80, y: 90 } });
  await cards.nth(1).click({ position: { x: 80, y: 90 }, modifiers: ['Shift'] });
  const connect = page.getByRole('button', { name: /^连接两个节点/u });
  await expect(connect).toBeEnabled();
  await connect.click();

  const connection = page.locator('.connection-hit-area');
  const renderedConnection = page.locator('.connection-path').first();
  await expect(connection).toHaveCount(1);
  await page.locator('.canvas-surface').click({ position: { x: 12, y: 12 } });
  const originalStroke = await renderedConnection.evaluate((element) => getComputedStyle(element).stroke);

  await executeCommand(page, '打开全局颜色设置');
  const panel = page.getByRole('region', { name: '全局颜色设置' });
  const connectionColorButton = panel.getByRole('button', { name: '连接曲线颜色', exact: true });
  await expect(connectionColorButton).toBeVisible();
  await connectionColorButton.click();
  const picker = page.getByRole('dialog', { name: '颜色选择器' });
  await picker.getByRole('spinbutton', { name: 'R 通道数值' }).fill('36');
  await picker.getByRole('spinbutton', { name: 'G 通道数值' }).fill('94');
  const blue = picker.getByRole('spinbutton', { name: 'B 通道数值' });
  await blue.fill('180');
  await expect(renderedConnection).toHaveCSS('stroke', 'rgb(36, 94, 180)');
  await blue.press('Enter');
  await expect(picker).toHaveCount(0);
  await expect(renderedConnection).toHaveCSS('stroke', 'rgb(36, 94, 180)');

  const undo = page.getByRole('button', { name: /^撤销/u });
  const redo = page.getByRole('button', { name: /^重做/u });
  await undo.click();
  await expect(renderedConnection).toHaveCSS('stroke', originalStroke);
  await redo.click();
  await expect(renderedConnection).toHaveCSS('stroke', 'rgb(36, 94, 180)');
});

test('a selected canvas node creates a visible annotation marker and editor', async ({ page }) => {
  await openApplication(page);
  const card = page.getByRole('article', { name: /文本节点：/u }).first();
  await card.click({ position: { x: 80, y: 28 } });
  await expect(card).toHaveCSS('box-shadow', 'none');
  await expect(card).toHaveCSS('outline-style', 'none');
  await expect(card).toHaveCSS('border-top-style', 'solid');
  await expect(card).toHaveCSS('border-top-width', '1px');
  expect(await selectedNodeOverlayStyle(card)).toMatchObject({ borderWidth: '4px' });
  await page.getByRole('button', { name: '添加注释', exact: true }).click();
  const annotationPanel = page.getByRole('region', { name: '注释' });
  const annotationMarker = page.getByRole('button', { name: /^双击打开注释/u });
  await expect(annotationPanel).toBeVisible();
  await expect(annotationPanel).toHaveCSS('box-shadow', 'none');
  await expect(annotationMarker).toBeVisible();
  await expect(annotationMarker).toHaveCSS('box-shadow', 'none');
  const markerBoxAt100 = await annotationMarker.boundingBox();
  const iconBoxAt100 = await annotationMarker.locator('svg').boundingBox();
  expect(markerBoxAt100).not.toBeNull();
  expect(iconBoxAt100).not.toBeNull();
  const zoom = page.locator('.canvas-zoom-status input');
  await zoom.fill('40');
  await zoom.press('Enter');
  await expect(zoom).toHaveAttribute('aria-label', /40%/u);
  const zoomedOutDetailRatio = Math.sqrt(0.4);
  await expect.poll(async () => {
    const box = await annotationMarker.boundingBox();
    return Math.abs((box?.width ?? 0) / markerBoxAt100!.width - zoomedOutDetailRatio);
  }).toBeLessThan(0.03);
  const markerBoxAt40 = await annotationMarker.boundingBox();
  const iconBoxAt40 = await annotationMarker.locator('svg').boundingBox();
  expect(markerBoxAt40).not.toBeNull();
  expect(iconBoxAt40).not.toBeNull();
  expect(Math.abs(markerBoxAt40!.width / markerBoxAt100!.width - zoomedOutDetailRatio)).toBeLessThan(0.03);
  expect(Math.abs(markerBoxAt40!.height / markerBoxAt100!.height - zoomedOutDetailRatio)).toBeLessThan(0.03);
  expect(Math.abs(iconBoxAt40!.width / iconBoxAt100!.width - zoomedOutDetailRatio)).toBeLessThan(0.03);
  expect(Math.abs(iconBoxAt40!.height / iconBoxAt100!.height - zoomedOutDetailRatio)).toBeLessThan(0.03);
});

test('an editor caret creates a visible inline annotation without losing the selection', async ({ page }) => {
  await openApplication(page);
  const card = page.getByRole('article', { name: /文本节点：/u }).first();
  await card.getByRole('paragraph').dblclick({ position: { x: 80, y: 90 } });
  const editor = page.locator('.editor-writing-area').first();
  await expect(editor).toBeVisible();
  await editor.press('ArrowRight');
  await page.getByRole('button', { name: '添加注释', exact: true }).click();
  const annotationPopup = page.getByRole('region', { name: '注释' });
  await expect(annotationPopup).toBeVisible();
  const popupBox = await annotationPopup.boundingBox();
  const editorBox = await editor.boundingBox();
  expect(popupBox).not.toBeNull();
  expect(editorBox).not.toBeNull();
  expect(popupBox?.x ?? 0).toBeGreaterThanOrEqual((editorBox?.x ?? 0) - 12);
  expect(popupBox?.y ?? 0).toBeGreaterThanOrEqual((editorBox?.y ?? 0) - 12);
  const annotationMarker = page.locator('.editor-annotation-marker');
  await expect(annotationMarker).toBeVisible();
  await expect(annotationMarker).toHaveCSS('box-shadow', 'none');
  await expect(page.locator('.annotation-canvas-marker')).toHaveCount(0);
});

test('unfinished IME text stays inside its active control until composition commits', async ({ page }) => {
  await openApplication(page);
  const card = page.getByRole('article', { name: /文本节点：/u }).first();
  const cardPreview = card.getByRole('paragraph');
  const originalPreview = await cardPreview.innerText();
  await cardPreview.dblclick({ position: { x: 80, y: 90 } });
  const editor = page.locator('.editor-writing-area').first();
  const originalBody = await editor.innerText();

  await beginSyntheticComposition(editor, `weishuru-${originalBody}`);
  await page.waitForTimeout(100);
  await expect(cardPreview).toHaveText(originalPreview);

  await endSyntheticComposition(editor, `中文-${originalBody}`);
  await expect(cardPreview).toContainText('中文');

  await editor.focus();
  await editor.press('End');
  await page.getByRole('button', { name: '添加注释', exact: true }).click();
  const annotation = page.getByRole('textbox', { name: '注释正文' });
  const annotationStatus = page.locator('.annotation-save-state');
  await beginSyntheticComposition(annotation, 'zhushi-pinyin');
  await page.waitForTimeout(850);
  await expect(annotationStatus).not.toHaveText('已保存');
  await endSyntheticComposition(annotation, '最终注释');
  await expect(annotationStatus).toHaveText('已保存', { timeout: 2_000 });
  await page.getByRole('button', { name: '关闭注释', exact: true }).click();

  await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
  const composer = page.locator('.ai-composer textarea');
  await beginSyntheticComposition(composer, 'weishuru');
  await expect(composer).toHaveValue('weishuru');
  await page.getByRole('button', { name: '关闭AI 助手', exact: true }).click();
  await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
  await expect(page.locator('.ai-composer textarea')).toHaveValue('');
});

test('immersive writing can create and reopen inline annotations without leaving the session', async ({ page }) => {
  await openApplication(page);
  const card = page.getByRole('article', { name: /文本节点：/u }).first();
  await card.getByRole('paragraph').dblclick({ position: { x: 80, y: 90 } });
  const ordinaryEditor = page.locator('.editor-writing-area').first();
  await ordinaryEditor.focus();
  await ordinaryEditor.press('ArrowRight');
  await page.getByRole('button', { name: '添加注释', exact: true }).click();
  await expect(page.getByRole('region', { name: '注释' })).toBeVisible();
  await page.getByRole('button', { name: '关闭注释', exact: true }).click();

  await page.getByRole('button', { name: '进入沉浸式写作', exact: true }).click();
  const immersive = page.getByRole('region', { name: '沉浸式写作' });
  await expect(immersive).toBeVisible();
  await expect(page.getByRole('button', { name: '在当前光标位置添加注释' })).toBeVisible();
  const marker = immersive.locator('.editor-annotation-marker').first();
  await expect(marker).toBeVisible();
  await marker.dblclick();
  await expect(page.getByRole('region', { name: '注释' })).toBeVisible();
  await page.getByRole('button', { name: '关闭注释', exact: true }).click();
  await expect(immersive).toBeVisible();

  const immersiveEditor = immersive.locator('.editor-writing-area');
  await immersiveEditor.focus();
  await immersiveEditor.press('End');
  const endSelection = await readEditorSelection(immersiveEditor);
  await page.getByRole('button', { name: '在当前光标位置添加注释' }).click();
  await expect(page.getByRole('region', { name: '注释' })).toBeVisible();
  await page.getByRole('button', { name: '关闭注释', exact: true }).click();
  await expect(immersive.locator('.editor-annotation-marker')).toHaveCount(2);
  await expect.poll(() => readEditorSelection(immersiveEditor)).toEqual(endSelection);
  const endMarker = immersive.locator('.editor-annotation-marker').last();
  const markerBefore = await endMarker.evaluate((marker) => marker.getBoundingClientRect().x);
  await immersiveEditor.pressSequentially('续');
  await expect.poll(() => readEditorSelection(immersiveEditor))
    .toEqual({ start: endSelection.start + 1, end: endSelection.end + 1 });
  await expect.poll(async () => Math.abs(
    await endMarker.evaluate((marker) => marker.getBoundingClientRect().x) - markerBefore,
  )).toBeLessThan(0.5);
});

test('immersive line breaks and deletions preserve the writing viewport', async ({ page }) => {
  await openApplication(page);
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  const card = page.getByRole('article', { name: '文本节点：未命名节点', exact: true });
  await card.getByRole('paragraph').dblclick({ position: { x: 80, y: 80 } });
  const ordinaryEditor = page.locator('.editor-writing-area').first();
  const body = Array.from({ length: 100 }, (_, index) => `第${String(index).padStart(3, '0')}行正文`).join('\n');
  await ordinaryEditor.fill(body);
  await expect(ordinaryEditor).toContainText('第099行正文');
  await page.getByRole('button', { name: '进入沉浸式写作', exact: true }).click();
  const editor = page.getByRole('region', { name: '沉浸式写作' }).locator('.editor-writing-area');
  const caret = body.indexOf('第050行正文') + 5;
  await selectEditorRange(editor, caret);
  const before = await editor.evaluate((element) => {
    const root = element as HTMLElement;
    const selection = document.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
    const rect = range?.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    if (rect) root.scrollTop += rect.top - rootRect.top - rootRect.height / 2;
    return root.scrollTop;
  });
  expect(before).toBeGreaterThan(0);

  await editor.evaluate((element, top) => {
    (element as HTMLElement).focus({ preventScroll: true });
    element.scrollTop = top;
  }, before);
  await page.keyboard.press('Enter');
  await expect.poll(async () => Math.abs(await editor.evaluate((element) => element.scrollTop) - before))
    .toBeLessThanOrEqual(1);
  await page.keyboard.press('Backspace');
  await expect.poll(async () => Math.abs(await editor.evaluate((element) => element.scrollTop) - before))
    .toBeLessThanOrEqual(1);
});

test('inline annotation anchors never jump left while ordinary or immersive text is inserted before them', async ({ page }) => {
  await openApplication(page);
  const card = page.getByRole('article', { name: /文本节点：/u }).first();
  await card.getByRole('paragraph').dblclick({ position: { x: 80, y: 90 } });
  const editor = page.locator('.editor-writing-area').first();
  await editor.focus();
  await editor.press('Control+Home');
  for (let index = 0; index < 10; index += 1) await editor.press('ArrowRight');
  await page.getByRole('button', { name: '添加注释', exact: true }).click();
  await page.getByRole('button', { name: '关闭注释', exact: true }).click();
  await editor.focus();
  await editor.press('Control+Home');
  for (let index = 0; index < 20; index += 1) await editor.press('ArrowRight');
  await page.getByRole('button', { name: '添加注释', exact: true }).click();
  await page.getByRole('button', { name: '关闭注释', exact: true }).click();
  const ordinaryMarkers = page.locator('.editor-pane:not(.immersive-pane) .editor-annotation-marker');
  await expect(ordinaryMarkers).toHaveCount(2);
  const boundaryBefore = await ordinaryMarkers.evaluateAll((markers) =>
    markers.map((marker) => marker.getBoundingClientRect().x));
  await editor.pressSequentially('界');
  await expect.poll(() => readEditorSelection(editor)).toEqual({ start: 21, end: 21 });
  await expect.poll(async () => {
    const latest = await ordinaryMarkers.evaluateAll((markers) =>
      markers.map((marker) => marker.getBoundingClientRect().x));
    return Math.max(...latest.map((value, index) => Math.abs(value - (boundaryBefore[index] ?? value))));
  }).toBeLessThan(0.5);
  await startAnnotationMotionProbe(
    page,
    '.editor-pane:not(.immersive-pane) .editor-annotation-marker',
    'ordinaryAnnotationMotion',
  );
  await editor.focus();
  await editor.press('Control+Home');
  await editor.pressSequentially('测');
  await page.waitForTimeout(350);
  const ordinaryMotion = await readAnnotationMotionProbe(page, 'ordinaryAnnotationMotion');
  expect(ordinaryMotion.frames).toBeGreaterThan(0);
  ordinaryMotion.minimum.forEach((minimum, index) => {
    expect(minimum).toBeGreaterThanOrEqual((ordinaryMotion.before[index] ?? 0) - 0.5);
    expect(ordinaryMotion.latest[index]).toBeGreaterThan((ordinaryMotion.before[index] ?? 0) + 0.5);
  });

  await page.getByRole('button', { name: '进入沉浸式写作', exact: true }).click();
  const immersive = page.getByRole('region', { name: '沉浸式写作' });
  const immersiveMarkers = immersive.locator('.editor-annotation-marker');
  const immersiveEditor = immersive.locator('.editor-writing-area');
  await expect(immersiveMarkers).toHaveCount(2);
  await startAnnotationMotionProbe(
    page,
    '.immersive-pane .editor-annotation-marker',
    'immersiveAnnotationMotion',
  );
  await immersiveEditor.focus();
  await immersiveEditor.press('Control+Home');
  await immersiveEditor.pressSequentially('试');
  await page.waitForTimeout(350);
  const immersiveMotion = await readAnnotationMotionProbe(page, 'immersiveAnnotationMotion');
  expect(immersiveMotion.frames).toBeGreaterThan(0);
  immersiveMotion.minimum.forEach((minimum, index) => {
    expect(minimum).toBeGreaterThanOrEqual((immersiveMotion.before[index] ?? 0) - 0.5);
    expect(immersiveMotion.latest[index]).toBeGreaterThan((immersiveMotion.before[index] ?? 0) + 0.5);
  });
});

test('a selected group creates a visible annotation pinned to its frame', async ({ page }) => {
  await openApplication(page);
  const cards = page.getByRole('article', { name: /文本节点：/u });
  await cards.nth(0).click({ position: { x: 70, y: 28 } });
  await cards.nth(1).click({ position: { x: 70, y: 28 }, modifiers: ['Control'] });
  await page.getByRole('button', { name: /^创建群组/u }).click();
  const group = page.locator('.group-frame').first();
  await expect(group).toBeVisible();
  await group.click({ position: { x: 8, y: 8 } });
  await page.getByRole('button', { name: '添加注释', exact: true }).click();
  const annotationPopup = page.getByRole('region', { name: '注释' });
  await expect(annotationPopup).toBeVisible();
  const marker = page.locator('.annotation-canvas-marker');
  await expect(marker).toBeVisible();
  await page.getByRole('button', { name: '关闭注释', exact: true }).click();

  await marker.click();
  await expect(annotationPopup).toHaveCount(0);
  await page.getByRole('button', { name: '修改选中项颜色', exact: true }).click();
  const picker = page.getByRole('dialog', { name: '颜色选择器' });
  await expect(picker).toBeVisible();
  const [markerBox, pickerBox] = await Promise.all([marker.boundingBox(), picker.boundingBox()]);
  expect(markerBox).not.toBeNull();
  expect(pickerBox).not.toBeNull();
  expect(Math.abs(pickerBox!.y - markerBox!.y - markerBox!.height - 8)).toBeLessThan(2);
  expect(pickerBox!.x).toBeLessThan(markerBox!.x + markerBox!.width);
  expect(pickerBox!.x + pickerBox!.width).toBeGreaterThan(markerBox!.x);
  await page.keyboard.press('Escape');

  await marker.dblclick();
  await expect(annotationPopup).toBeVisible();
});

test('Alt dragging a connected node keeps its existing connection anchored to the original', async ({ page }) => {
  await openApplication(page);
  const source = page.locator('.text-node-card').filter({
    has: page.locator('strong[title="AI 助手使用指南"]'),
  });
  const target = page.locator('.text-node-card').filter({
    has: page.locator('strong[title="画布基本操作指南"]'),
  });
  const sourcePort = source.getByRole('button', { name: '从AI 助手使用指南标题栏连接', exact: true });
  const [sourcePortBox, targetBox] = await Promise.all([sourcePort.boundingBox(), target.boundingBox()]);
  expect(sourcePortBox).not.toBeNull();
  expect(targetBox).not.toBeNull();

  await page.mouse.move(
    sourcePortBox!.x + sourcePortBox!.width / 2,
    sourcePortBox!.y + sourcePortBox!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(targetBox!.x + 8, targetBox!.y + 21, { steps: 8 });
  await page.mouse.up();

  const connection = page.locator('.connection-path').first();
  await expect(connection).toBeVisible();
  await page.waitForTimeout(500);
  let previousPath: string | null = null;
  let stableSamples = 0;
  await expect.poll(async () => {
    const nextPath = await connection.getAttribute('d');
    stableSamples = nextPath !== null && nextPath === previousPath ? stableSamples + 1 : 0;
    previousPath = nextPath;
    return stableSamples;
  }).toBeGreaterThanOrEqual(2);
  const pathBeforeDrag = previousPath;
  expect(pathBeforeDrag).not.toBeNull();
  const titleBox = await source.locator('strong').boundingBox();
  expect(titleBox).not.toBeNull();

  await page.keyboard.down('Alt');
  await page.mouse.move(titleBox!.x + titleBox!.width / 2, titleBox!.y + titleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(titleBox!.x + titleBox!.width / 2 + 180, titleBox!.y + titleBox!.height / 2 + 110, {
    steps: 8,
  });

  await expect(page.locator('.text-node-card.duplicate-origin')).toHaveCount(1);
  await expect.poll(() => connection.getAttribute('d')).toBe(pathBeforeDrag);

  await page.mouse.up();
  await page.keyboard.up('Alt');
  await expect(page.getByRole('article', { name: /文本节点：/u })).toHaveCount(3);
  await expect(connection).toHaveAttribute('d', pathBeforeDrag!);
});

test('Alt dragging a group duplicates the complete group instead of moving the original', async ({ page }) => {
  await openApplication(page);
  const cards = page.getByRole('article', { name: /文本节点：/u });
  await cards.nth(0).click({ position: { x: 70, y: 28 } });
  await cards.nth(1).click({ position: { x: 70, y: 28 }, modifiers: ['Control'] });
  await page.getByRole('button', { name: /^创建群组/u }).click();
  const group = page.locator('.group-frame').first();
  await expect(group).toBeVisible();
  const bounds = await group.boundingBox();
  expect(bounds).not.toBeNull();
  await page.keyboard.down('Alt');
  await page.mouse.move(bounds!.x + 8, bounds!.y + 8);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + 128, bounds!.y + 88, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Alt');
  await expect(cards).toHaveCount(4);
  await expect(page.locator('.group-frame')).toHaveCount(2);
});

test('independent AI assistants can be selected and deleted from the toolbar menu', async ({ page }) => {
  await openApplication(page);
  await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
  await page.getByRole('button', { name: '新开独立 AI 助手', exact: true }).click();
  await expect(page.getByRole('region', { name: 'AI 助手' })).toHaveCount(2);

  const launcher = page.getByRole('button', { name: /^打开 AI 助手/u }).first();
  await expect(page.locator('.ai-toolbar-count')).toHaveText('2');
  await launcher.hover();
  const menu = page.getByRole('menu', { name: '已打开的 AI 助手' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toHaveCount(2);
  await menu.getByRole('menuitem').first().click();
  await expect.poll(async () => Number(await page.locator('.ai-floating-panel').first().evaluate((element) =>
    getComputedStyle(element).zIndex))).toBeGreaterThan(
    Number(await page.locator('.ai-floating-panel').last().evaluate((element) => getComputedStyle(element).zIndex)),
  );
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: 'AI 助手' })).toHaveCount(1);
  await expect(page.locator('.ai-toolbar-count')).toHaveText('2');
  await launcher.hover();
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem').first().click();
  await expect(page.getByRole('region', { name: 'AI 助手' })).toHaveCount(2);
  await launcher.hover();
  await expect(menu).toBeVisible();
  await menu.getByRole('button', { name: /^删除/u }).last().click();
  await expect(page.getByRole('region', { name: 'AI 助手' })).toHaveCount(1);
  await expect(page.locator('.ai-toolbar-count')).toHaveCount(0);
});

test('AI transcript copy keeps the native clipboard and paste stays inside the composer', async ({ page }) => {
  await openApplication(page);
  await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
  await expect(page.getByText('Prompt：默认通用', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const target = document.querySelector<HTMLElement>('.ai-command-hints summary span');
    if (!target) throw new Error('AI copy fixture is missing');
    const range = document.createRange();
    range.selectNodeContents(target);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await page.keyboard.press('Control+c');
  const composer = page.locator('.ai-composer textarea');
  await composer.focus();
  await page.keyboard.press('Control+v');
  await expect(composer).toHaveValue(/输入 @ 即可检索/u);

  await composer.fill('@润');
  const mentionMenu = page.getByRole('listbox', { name: '@ 命令和文字节点' });
  await expect(mentionMenu).toBeVisible();
  await expect(mentionMenu.getByRole('option', { name: /@润色/u })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(composer).toHaveValue(/@润色/u);

  await composer.fill('第一版');
  await composer.fill('第二版');
  await page.keyboard.press('Control+z');
  await expect(composer).toHaveValue('第一版');
});

test('double-clicking the AI conversation scrollbar jumps to the latest conversation', async ({ page }) => {
  await openApplication(page);
  await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
  const feed = page.locator('.ai-chat-feed');
  await feed.evaluate((element) => {
    const fixture = document.createElement('div');
    fixture.dataset.aiScrollFixture = 'true';
    fixture.style.height = '2400px';
    fixture.textContent = '滚动测试';
    (element as HTMLElement).appendChild(fixture);
    element.scrollTop = 0;
  });
  await feed.dblclick({ position: { x: 40, y: 20 } });
  expect(await feed.evaluate((element) => element.scrollTop)).toBe(0);

  const scrollbar = page.getByRole('scrollbar', { name: 'AI 对话滚动条，双击跳到最新对话' });
  await expect(scrollbar).toBeVisible();
  await scrollbar.dblclick({ position: { x: 6, y: 20 } });
  await expect.poll(async () => feed.evaluate((element) =>
    Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThanOrEqual(2);

  await scrollbar.press('Home');
  await expect.poll(async () => feed.evaluate((element) => element.scrollTop)).toBe(0);
  const railBounds = await scrollbar.boundingBox();
  const thumbBounds = await scrollbar.locator('.ai-chat-scrollbar-thumb').boundingBox();
  expect(railBounds).not.toBeNull();
  expect(thumbBounds).not.toBeNull();
  await page.mouse.move(thumbBounds!.x + thumbBounds!.width / 2, thumbBounds!.y + 4);
  await page.mouse.down();
  await page.mouse.move(
    railBounds!.x + railBounds!.width / 2,
    railBounds!.y + railBounds!.height - 2,
    { steps: 4 },
  );
  await page.mouse.up();
  await expect.poll(async () => feed.evaluate((element) =>
    Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThanOrEqual(2);
});

test('AI memory and Prompt management views remain mounted through their governed panel actions', async ({ page }) => {
  await openApplication(page);
  await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
  const assistantPanel = page.getByRole('region', { name: 'AI 助手' });
  await expect(assistantPanel.locator('.floating-panel-title small')).toHaveText('记忆：新对话');
  await expect(assistantPanel.getByRole('button', { name: 'Prompt 模板', exact: true })
    .locator('[data-icon="template"]')).toBeVisible();
  await expect(assistantPanel.getByText(/^当前记忆：/u)).toHaveCount(0);
  await expect(assistantPanel.getByRole('button', { name: '保存当前对话为记忆', exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Prompt 模板', exact: true }).click();
  const promptCenter = page.getByRole('region', { name: 'AI Prompt 模板' });
  await expect(promptCenter).toBeVisible();
  await expect(promptCenter.getByText('当前模板', { exact: true })).toBeVisible();
  await expect(promptCenter.getByText('系统工作方式', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'AI 对话', exact: true }).click();
  const memoryShortcut = assistantPanel.getByRole('button', { name: '选择本轮记忆，前往记忆中心', exact: true });
  await expect(memoryShortcut).toHaveText('选择记忆 · 自动');
  await expect(assistantPanel.locator('.ai-memory-picker-popover')).toHaveCount(0);
  await memoryShortcut.click();
  const memoryCenter = page.getByRole('region', { name: 'AI 记忆中心' });
  await expect(memoryCenter).toBeVisible();
  await expect(memoryCenter.getByRole('heading', { name: '记忆库', exact: true })).toBeVisible();
  await expect(memoryCenter.getByRole('button', { name: '返回对话', exact: true })).toHaveCount(0);
  await expect(memoryCenter.getByRole('region', { name: '保存当前对话' })).toBeVisible();
  await expect(memoryCenter.getByRole('region', { name: '待确认的长期决定' })).toHaveCount(0);
  await expect(memoryCenter.getByRole('button', { name: '保存本轮对话' })).toBeVisible();
  const memoryFileActions = memoryCenter.getByRole('group', { name: '记忆文件操作' });
  await expect(memoryFileActions).toBeVisible();
  await expect(memoryFileActions.getByRole('button', { name: '选择保存路径' })).toBeVisible();
  await expect(memoryFileActions.getByRole('button', { name: '从本地导入记忆' })).toBeVisible();

  await page.getByRole('button', { name: 'AI 对话', exact: true }).click();
  await expect(page.locator('.ai-composer textarea')).toBeVisible();
});

test('unsaved books clearly distinguish browser recovery from a real book file', async ({ page }) => {
  await openApplication(page);
  await executeCommand(page, '书籍与恢复设置');
  const filePanel = page.getByRole('region', { name: '书籍与恢复' });
  await expect(filePanel).toBeVisible();
  const autosaveInterval = filePanel.getByRole('combobox', { name: '自动保存当前目标的间隔' });
  await expect(autosaveInterval).toBeVisible();
  await expect(autosaveInterval.locator('option')).toHaveText([
    '实时', '30 秒', '1 分钟', '2 分钟', '5 分钟', '10 分钟', '30 分钟', '关闭',
  ]);
  await expect(filePanel.getByText(/当前尚未选择书籍保存位置/u)).toBeVisible();
  await expect(filePanel.getByText(/不会生成 \.echo8 文件/u)).toBeVisible();
  await autosaveInterval.selectOption('0');
  await expect(filePanel.getByText(/自动保存已关闭/u)).toBeVisible();
  await autosaveInterval.selectOption('1000');
  await expect(autosaveInterval).toHaveValue('1000');
  await filePanel.getByRole('button', { name: '创建手动恢复点' }).click();
  await expect(filePanel.getByText(/本机恢复副本已更新/u)).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '会话恢复副本已更新' })).toHaveCount(0);
});

test('AI connection form keeps the routine connection path clear', async ({ page }) => {
  await openApplication(page);
  await executeCommand(page, '打开插件中心');
  const pluginCenter = page.getByRole('region', { name: '插件中心' });
  await pluginCenter.getByRole('switch', { name: '启用远程语义检索' }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^打开 AI 助手/u }).click();
  await page.getByRole('button', { name: '配置模型平台与 KEY', exact: true }).click();
  const settings = page.getByRole('region', { name: 'AI 模型与连接' });
  await expect(settings).toBeVisible();
  const chatConnectionHeading = settings.getByRole('heading', { name: '连接模型', exact: true });
  await expect(chatConnectionHeading).toBeVisible();
  const localSemantic = settings.getByRole('region', { name: '本机理解检索' });
  await expect(localSemantic).toBeVisible();
  const remoteSemantic = settings.getByRole('region', { name: '云端语义检索' });
  await expect(remoteSemantic).toBeVisible();
  const chatConnectionPanel = settings.locator('.ai-provider-panel');
  const transferActions = settings.locator('.ai-provider-transfer-actions');
  await expect(transferActions.getByRole('button', { name: '导出配置' })).toBeVisible();
  await expect(transferActions.getByRole('button', { name: '从本地导入' })).toBeVisible();
  const [settingsBox, transferActionsBox, chatConnectionBox, chatConnectionPanelBox, localSemanticBox, remoteSemanticBox] = await Promise.all([
    settings.boundingBox(),
    transferActions.boundingBox(),
    chatConnectionHeading.boundingBox(),
    chatConnectionPanel.boundingBox(),
    localSemantic.boundingBox(),
    remoteSemantic.boundingBox(),
  ]);
  expect(transferActionsBox?.y).toBeLessThan(chatConnectionBox?.y ?? Number.POSITIVE_INFINITY);
  expect(chatConnectionBox?.y).toBeLessThan(localSemanticBox?.y ?? Number.POSITIVE_INFINITY);
  expect(remoteSemanticBox?.y).toBeGreaterThan(localSemanticBox?.y ?? Number.NEGATIVE_INFINITY);
  expect(chatConnectionPanelBox?.width).toBeGreaterThanOrEqual((settingsBox?.width ?? 0) - 40);
  await expect(localSemantic.getByText('尚未下载公开模型', { exact: true })).toBeVisible();
  await expect(localSemantic.getByText(/下载约 40 MB/u)).toBeVisible();
  await expect(localSemantic.getByRole('button', { name: '下载模型（约 40 MB）' })).toBeVisible();
  await expect(localSemantic.locator('details')).toHaveCount(0);
  await expect(settings.getByLabel('选择平台', { exact: true })).toBeVisible();
  await expect(settings.getByText('平台名称', { exact: true })).toHaveCount(0);
  await expect(settings.getByText('连接名称', { exact: true })).toHaveCount(0);
  await settings.getByLabel('选择平台', { exact: true }).selectOption('deepseek');
  const modelName = settings.getByRole('combobox', { name: '模型', exact: true });
  await modelName.fill('deepseek-v4-pro');
  await expect(modelName).toHaveValue('deepseek-v4-pro');

  const manualConnection = settings.locator('details.ai-provider-manual-details');
  await manualConnection.locator(':scope > summary').click();
  const advancedConnection = manualConnection.locator('details.ai-provider-advanced');
  await advancedConnection.locator('summary').click();
  const memoryToolToggle = advancedConnection.getByLabel('允许 AI 按需查询已保存记忆');
  await expect(memoryToolToggle).toBeVisible();
  await expect(memoryToolToggle).not.toBeChecked();
  await expect(memoryToolToggle).toBeEnabled();
  await advancedConnection.locator('select').first().selectOption('gemini');
  await expect(memoryToolToggle).toBeDisabled();

  await expect(settings.getByRole('tab')).toHaveCount(0);
  await remoteSemantic.locator(':scope > details > summary').click();
  const semanticPreset = settings.getByLabel('快速选择语义平台');
  await expect(semanticPreset).toBeVisible();
  await expect(semanticPreset.locator('option[value="openai"]')).toBeEnabled();
  await expect(semanticPreset.locator('option[value="qwen"]')).toBeEnabled();
  expect(await semanticPreset.locator('option[value="deepseek"]').evaluate((option: HTMLOptionElement) => option.disabled)).toBe(true);
});
