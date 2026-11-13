import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodeLocalSemanticCache,
  encodeLocalSemanticCache,
} from '../src/plugins/local-semantic-provider/worker-jobs.ts';

test('local semantic cache round-trips vectors without storing source text', () => {
  const encoded = encodeLocalSemanticCache({
    sources: [{
      sourceId: 'node-1',
      revision: 7,
      chunks: [{
        start: 12,
        length: 34,
        fingerprint: 'fingerprint-1',
        coverage: 'full',
        vector: Float32Array.from([0.25, -0.5, 0.75]),
      }],
    }],
  });
  assert.equal(encoded.truncated, false);
  assert.equal(encoded.retainedSources, 1);
  assert.equal(encoded.retainedChunks, 1);
  assert.equal(encoded.text.includes('正文不应进入缓存'), false);

  const decoded = decodeLocalSemanticCache({ text: encoded.text });
  assert.equal(decoded.sources[0]?.sourceId, 'node-1');
  assert.equal(decoded.sources[0]?.revision, 7);
  assert.deepEqual(
    [...(decoded.sources[0]?.chunks[0]?.vector ?? [])],
    [0.25, -0.5, 0.75],
  );
});

test('local semantic cache rejects incompatible or non-finite vectors', () => {
  const encoded = encodeLocalSemanticCache({
    sources: [{
      sourceId: 'node-1',
      revision: 1,
      chunks: [{
        start: 0,
        length: 3,
        fingerprint: 'fingerprint-1',
        coverage: 'sampled',
        vector: Float32Array.from([1, 0]),
      }],
    }],
  });
  assert.throws(
    () => decodeLocalSemanticCache({ text: encoded.text.replace('"schemaVersion":1', '"schemaVersion":2') }),
    /版本不兼容/u,
  );
  assert.throws(
    () => encodeLocalSemanticCache({
      sources: [{
        sourceId: 'node-1',
        revision: 1,
        chunks: [{
          start: 0,
          length: 3,
          fingerprint: 'fingerprint-1',
          coverage: 'full',
          vector: Float32Array.from([Number.NaN, 0]),
        }],
      }],
    }),
    /分块无效/u,
  );
});

test('Base and legacy Small use independent cache identities', () => {
  const small = encodeLocalSemanticCache({ sources: [] });
  const base = encodeLocalSemanticCache({ modelId: 'base', sources: [] });
  assert.match(small.text, /bge-small-zh-v1\.5:quantized/u);
  assert.match(base.text, /bge-base-zh-v1\.5:quantized/u);
  assert.throws(() => decodeLocalSemanticCache({ text: base.text }), /版本不兼容/u);
  assert.throws(() => decodeLocalSemanticCache({ modelId: 'base', text: small.text }), /版本不兼容/u);
  assert.deepEqual(decodeLocalSemanticCache({ modelId: 'base', text: base.text }).sources, []);
});
