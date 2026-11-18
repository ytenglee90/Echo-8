// Test-only cache of the same pinned assets used by the governed model loader.
import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
const directory = 'local-data/bge-comparison';
await mkdir(directory, { recursive: true });
const policy = await readFile('src/core/network-access.ts', 'utf8');
const assets = {
  'bge-small-zh-v1.5.model': 'small-model_quantized.onnx',
  'bge-small-zh-v1.5.tokenizer': 'small-tokenizer.json',
  'bge-small-zh-v1.5.tokenizer-config': 'small-tokenizer_config.json',
  'onnxruntime-web.wasm-runtime': 'ort.wasm.min.mjs',
  'onnxruntime-web.wasm-backend': 'ort-wasm-simd-threaded.mjs',
  'onnxruntime-web.wasm-binary': 'ort-wasm-simd-threaded.wasm',
};
for (const [asset, file] of Object.entries(assets)) {
  const path = `${directory}/${file}`;
  const minimum = file.endsWith('.wasm') ? 5000000 : file.endsWith('.onnx') ? 10000000 : 100;
  if ((await stat(path).catch(() => ({ size: 0 }))).size > minimum) continue;
  if (process.env.ECHO8_OFFLINE_TESTS === '1') throw Error(`Offline test asset missing: ${path}`);
  const section = policy.indexOf(`'${asset}': {`);
  const url = /url: '([^']+)'/u.exec(policy.slice(section))?.[1];
  if (section < 0 || !url) throw Error(`Pinned asset missing: ${asset}`);
  const response = await fetch(url);
  if (!response.ok) throw Error(`Model fixture ${asset}: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < minimum) throw Error(`Incomplete model fixture: ${asset}`);
  const staged = `${path}.${process.pid}.download`;
  await writeFile(staged, buffer);
  await rename(staged, path);
  console.log(`Cached local language test asset ${asset} (${buffer.length} bytes)`);
}
