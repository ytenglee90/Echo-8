import assert from 'node:assert/strict';
import test from 'node:test';
import { linkOnnxRuntimeEntry } from '../src/plugins/local-semantic-provider/worker-jobs.ts';

test('links only the pinned ORT runtime backend filename', () => {
  const source = 'const backend = "ort-wasm-simd-threaded.mjs";';
  assert.equal(
    linkOnnxRuntimeEntry(source, 'blob:governed-ort-backend'),
    'const backend = "blob:governed-ort-backend";',
  );
});

test('rejects an ORT entry without the pinned runtime backend filename', () => {
  assert.throws(
    () => linkOnnxRuntimeEntry('const backend = "unexpected.mjs";', 'blob:governed-ort-backend'),
    /未包含受支持的固定后端引用/,
  );
});
