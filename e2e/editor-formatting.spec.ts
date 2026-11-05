import { test, expect, type Locator } from '@playwright/test';

async function select(editor: Locator, start: number, end = start) {
  await editor.evaluate((root, range) => {
    const locate = (offset: number): [Node, number] => {
      let remaining = offset;
      for (const block of root.childNodes) {
        const text = block.textContent ?? '';
        if (remaining <= text.length) {
          const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
          let node = walker.nextNode();
          let local = remaining;
          while (node) {
            if (local <= (node.textContent?.length ?? 0)) return [node, local];
            local -= node.textContent?.length ?? 0;
            node = walker.nextNode();
          }
          return [block, 0];
        }
        remaining -= text.length + 1;
      }
      return [root, root.childNodes.length];
    };
    (root as HTMLElement).focus();
    const selection = document.getSelection()!;
    const domRange = document.createRange();
    domRange.setStart(...locate(range.start));
    domRange.setEnd(...locate(range.end));
    selection.removeAllRanges(); selection.addRange(domRange);
    root.dispatchEvent(new Event('select', { bubbles: true }));
    root.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  }, { start, end });
}

async function openEditor(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
  await page.getByRole('button', { name: '新建文本', exact: true }).click();
  await page.getByRole('article', { name: '文本节点：未命名节点', exact: true }).getByRole('paragraph').dblclick({ position: { x: 80, y: 80 } });
  return page.locator('.editor-writing-area').first();
}

const paragraphMetrics = (editor: Locator, index: number) => editor.locator(':scope > div').nth(index).evaluate((element) => {
  const style = getComputedStyle(element);
  return { fontSize: style.fontSize, lineHeight: style.lineHeight, indent: style.textIndent, after: style.marginBottom };
});

test('paragraph formats are independent, caret parameters follow navigation and mixed selections can be unified', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const editor = await openEditor(page);
  await editor.fill('甲乙丙\n丁戊己\n末段');
  await select(editor, 1);
  const control = (name: string) => page.getByLabel(name, { exact: true });
  await control('字号').selectOption('24');
  await control('字距').selectOption('2');
  await control('行距').selectOption('1.2');
  await control('首行缩进').selectOption('2');
  await control('段后空行').selectOption('1');
  await expect.poll(() => paragraphMetrics(editor, 0)).toEqual({ fontSize: '24px', lineHeight: '28.8px', indent: '52px', after: '28.8px' });
  await expect.poll(() => paragraphMetrics(editor, 1)).toMatchObject({ fontSize: '15px', lineHeight: '25.5px', indent: '0px' });
  await select(editor, 5);
  await expect(control('字号')).toHaveValue('15');
  await expect(control('行距')).toHaveValue('1.7');
  await control('字号').selectOption('36');
  await control('行距').selectOption('2.6');
  await control('首行缩进').selectOption('4');
  await select(editor, 1);
  await expect(control('字号')).toHaveValue('24');
  await expect(control('字距')).toHaveValue('2');
  await expect(control('行距')).toHaveValue('1.2');
  await expect(control('首行缩进')).toHaveValue('2');
  await expect(control('段后空行')).toHaveValue('1');
  await select(editor, 0, 1);
  await control('字重').selectOption('900');
  await expect.poll(() => editor.locator('span').evaluateAll((spans) => spans.filter((span) => getComputedStyle(span).fontWeight === '900').map((span) => span.textContent).join(''))).toBe('甲');
  await select(editor, 1, 6);
  await expect(control('字号')).toHaveValue('mixed');
  await expect(control('行距')).toHaveValue('mixed');
  await expect(control('首行缩进')).toHaveValue('mixed');
  await control('行距').selectOption('1.7');
  await expect(control('行距')).toHaveValue('1.7');
  await expect(control('字号')).toHaveValue('mixed');
  await expect.poll(() => paragraphMetrics(editor, 0)).toMatchObject({ lineHeight: '40.8px' });
  await expect.poll(() => paragraphMetrics(editor, 1)).toMatchObject({ lineHeight: '61.2px' });
  await editor.focus();
  await page.keyboard.press('Control+z');
  await expect.poll(() => paragraphMetrics(editor, 0)).toMatchObject({ lineHeight: '28.8px' });
  await page.keyboard.press('Control+y');
  await expect.poll(() => paragraphMetrics(editor, 0)).toMatchObject({ lineHeight: '40.8px' });
  await select(editor, 0, 10);
  await control('字号').selectOption('15');
  await expect.poll(() => editor.locator('span').evaluateAll((spans) => [...new Set(spans.map((span) => getComputedStyle(span).fontSize))])).toEqual(['15px']);
  await expect(page.locator('.editor-error')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('terminal blank paragraph can be styled and typed without changing earlier paragraphs', async ({ page }) => {
  const editor = await openEditor(page);
  await editor.fill('前段\n');
  await select(editor, 3);
  await page.getByLabel('字号', { exact: true }).selectOption('36');
  await page.getByLabel('首行缩进', { exact: true }).selectOption('2');
  await expect.poll(() => paragraphMetrics(editor, 1)).toMatchObject({ fontSize: '36px', indent: '72px' });
  await select(editor, 3);
  await page.keyboard.insertText('新段');
  await expect.poll(() => paragraphMetrics(editor, 1)).toMatchObject({ fontSize: '36px', indent: '72px' });
  await expect.poll(() => paragraphMetrics(editor, 0)).toMatchObject({ fontSize: '15px', indent: '0px' });
  await select(editor, 4);
  await expect(page.getByLabel('字号', { exact: true })).toHaveValue('36');
  await expect(page.locator('.editor-error')).toHaveCount(0);
});
