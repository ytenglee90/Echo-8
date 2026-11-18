import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

/** Real pinned model bytes, not mocked embeddings or mocked intent decisions. */
export async function installLocalLanguageAssets(page: Page, onServe?: (file: string) => void): Promise<void> {
  await page.route(/https:\/\/(?:huggingface\.co\/Xenova\/bge-small-zh-v1\.5\/resolve\/[^/]+\/(?:onnx\/model_quantized\.onnx|tokenizer(?:_config)?\.json)|cdn\.jsdelivr\.net\/npm\/onnxruntime-web@1\.29\.0\/dist\/[^/]+)$/u, async route => {
    const name = new URL(route.request().url()).pathname.split('/').at(-1)!;
    const file = name === 'model_quantized.onnx' ? 'small-model_quantized.onnx' : name.startsWith('tokenizer') ? 'small-' + name : name;
    const body = await readFile('local-data/bge-comparison/' + file);
    onServe?.(file);
    await route.fulfill({ body, contentType: 'application/octet-stream', headers: { 'access-control-allow-origin': '*' } });
  });
}
