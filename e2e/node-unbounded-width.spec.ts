import { expect, test } from '@playwright/test';

for (const textBox of [false, true]) test(`${textBox ? 'text box' : 'node'} dragging exceeds the former width limit and undo restores its size`, async ({ page }) => {
  await page.setViewportSize({ width: 2600, height: 1000 });
  await page.goto('/'); await page.getByRole('region', { name: 'Echo-8 书库' }).press('Escape');
  const node = page.locator('.text-node-card').filter({ has: page.locator('strong[title="AI 助手使用指南"]') });
  await node.locator('header').click();
  if (textBox) {
    await page.getByRole('button', { name: '文本框与文字节点相互转换', exact: true }).click();
    await expect(node).toHaveClass(/text-box/u);
    await expect.poll(() => node.evaluate(element => (element as HTMLElement).offsetWidth)).toBe(240);
  }
  const originalWidth = await node.evaluate(element => (element as HTMLElement).offsetWidth);
  const handle = await node.getByRole('button', { name: /调整AI 助手使用指南的大小/u }).boundingBox();
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2); await page.mouse.down();
  await page.mouse.move(handle!.x + handle!.width / 2 + 1900, handle!.y + handle!.height / 2, { steps: 15 });
  await page.mouse.up();
  await expect.poll(() => node.evaluate(element => (element as HTMLElement).offsetWidth)).toBeGreaterThan(2000);
  await page.keyboard.press('Control+z');
  await expect.poll(() => node.evaluate(element => (element as HTMLElement).offsetWidth)).toBe(originalWidth);
  await page.keyboard.press('Control+Shift+z');
  await expect.poll(() => node.evaluate(element => (element as HTMLElement).offsetWidth)).toBeGreaterThan(2000);
});
