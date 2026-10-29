/** Public, version-pinned model assets that a local AI runtime may retrieve. */
export type LocalModelAsset =
  | 'bge-small-zh-v1.5.model'
  | 'bge-small-zh-v1.5.tokenizer'
  | 'bge-small-zh-v1.5.tokenizer-config'
  | 'onnxruntime-web.wasm-runtime'
  | 'onnxruntime-web.wasm-backend'
  | 'onnxruntime-web.wasm-binary';

export interface LocalModelAssetData {
  asset: LocalModelAsset;
  data: ArrayBuffer;
}
