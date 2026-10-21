import { createServer, type Server } from 'node:http';
import { expect, test } from '@playwright/test';

const TOKEN = 'playwright-real-loopback-pairing-token-1234567890';
const PORT = 32148;
let bridge: Server;
let receivedAuthorization = '';

test.beforeAll(async () => {
  bridge = createServer((request, response) => {
    const origin = request.headers.origin ?? '';
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Access-Control-Allow-Private-Network', 'true');
    response.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
    response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
    receivedAuthorization = request.headers.authorization ?? '';
    if (receivedAuthorization !== `Bearer ${TOKEN}`) {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: '配对令牌无效' } }));
      return;
    }
    const body: Buffer[] = [];
    request.on('data', (chunk) => body.push(chunk));
    request.on('end', () => {
      const parsed = JSON.parse(Buffer.concat(body).toString('utf8')) as {
        model?: string;
        stream?: boolean;
      };
      if (request.url === '/v1/connector/health') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          status: 'READY',
          protocol: 'novelforge-canvas-local/2',
          capabilities: ['chat', 'runtime-projects', 'runtime-snapshot', 'runtime-proposals'],
        }));
        return;
      }
      if (request.url === '/v1/runtime/projects') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ protocol: 'novelforge-canvas-runtime/2', projects: [] }));
        return;
      }
      if (request.url !== '/v1/chat/completions' || parsed.model !== 'novelforge-codex' || !parsed.stream) {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: '请求协议不正确' } }));
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      response.write('data: {"choices":[{"index":0,"delta":{"content":"画布桥接"},"finish_reason":null}]}\n\n');
      setTimeout(() => {
        response.write('data: {"choices":[{"index":0,"delta":{"content":"流式回答成功"},"finish_reason":null}]}\n\n');
        response.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
        response.end('data: [DONE]\n\n');
      }, 30);
    });
  });
  await new Promise<void>((resolve, reject) => {
    bridge.once('error', reject);
    bridge.listen(PORT, '127.0.0.1', resolve);
  });
});

test.afterAll(() => {
  bridge.closeAllConnections();
  bridge.close();
  bridge.unref();
});

test('hosted canvas streams through the paired loopback NovelForge Codex provider', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '继续当前浏览器中的画布' }).click();
  await page.keyboard.press('Control+k');
  let palette = page.getByRole('dialog', { name: '命令面板' });
  await palette.getByRole('textbox', { name: '搜索命令' }).fill('打开 NovelForge 小说工程');
  await palette.getByRole('option', { name: /^打开 NovelForge 小说工程/u }).click();
  const novelForge = page.getByRole('region', { name: 'NovelForge 小说工程' });
  await novelForge.getByLabel('本机地址').fill(`http://127.0.0.1:${PORT}`);
  await novelForge.getByLabel('一次性配置用配对令牌').fill(TOKEN);
  await novelForge.getByRole('button', { name: '保存并连接（只需一次）' }).click();
  await expect(novelForge.getByText('已自动连接')).toBeVisible();

  await page.keyboard.press('Control+k');
  palette = page.getByRole('dialog', { name: '命令面板' });
  await palette.getByRole('textbox', { name: '搜索命令' }).fill('配置 AI 模型连接与密钥');
  await palette.getByRole('option', { name: /^配置 AI 模型连接与密钥/u }).click();

  const settings = page.getByRole('region', { name: 'AI 模型连接与密钥' });
  await settings.getByRole('combobox', { name: '选择平台' })
    .selectOption({ label: 'NovelForge Codex（本机）' });
  await expect(settings.getByText(/NovelForge Codex 会自动复用本机配对/u)).toBeVisible();
  await expect(settings.getByLabel('配对令牌')).toHaveCount(0);
  await settings.getByRole('button', { name: '保存连接' }).click();
  await expect(settings.getByText('当前连接已就绪')).toBeVisible();

  await page.getByRole('button', { name: 'AI 对话' }).click();
  const assistant = page.getByRole('region', { name: 'AI 助手' });
  await assistant.getByPlaceholder(/直接描述任务/u).fill('只回答本机桥接是否连通');
  await assistant.getByRole('button', { name: '发送给模型' }).click();
  await expect(assistant.getByText('画布桥接流式回答成功')).toBeVisible({ timeout: 15_000 });
  expect(receivedAuthorization).toBe(`Bearer ${TOKEN}`);
});
