export const LOCAL_SEMANTIC_LOAD_MODEL_JOB = 'local-semantic-provider.model.load@1';
export const LOCAL_SEMANTIC_EMBED_JOB = 'local-semantic-provider.embed@1';
export const LOCAL_SEMANTIC_DISPOSE_MODEL_JOB = 'local-semantic-provider.model.dispose@1';
export const LOCAL_SEMANTIC_ENCODE_CACHE_JOB = 'local-semantic-provider.cache.encode@1';
export const LOCAL_SEMANTIC_DECODE_CACHE_JOB = 'local-semantic-provider.cache.decode@1';

export interface LocalSemanticLoadModelRequest {
  model: ArrayBuffer;
  tokenizer: string;
  tokenizerConfig: string;
  runtimeModule: string;
  runtimeBackend: string;
  runtimeWasm: ArrayBuffer;
}

export interface LocalSemanticEmbedRequest {
  texts: string[];
}

export interface LocalSemanticEmbedResult {
  vectors: Float32Array[];
  dimensions: number;
}

export interface LocalSemanticCacheChunk {
  start: number;
  length: number;
  fingerprint: string;
  coverage: 'full' | 'sampled';
  vector: Float32Array;
}

export interface LocalSemanticCacheSource {
  sourceId: string;
  revision: number;
  chunks: LocalSemanticCacheChunk[];
}

export interface LocalSemanticEncodeCacheRequest {
  sources: LocalSemanticCacheSource[];
}

export interface LocalSemanticEncodeCacheResult {
  text: string;
  retainedSources: number;
  retainedChunks: number;
  truncated: boolean;
}

export interface LocalSemanticDecodeCacheRequest {
  text: string;
}

export interface LocalSemanticDecodeCacheResult {
  sources: LocalSemanticCacheSource[];
}
