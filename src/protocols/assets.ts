export interface TextAssetReadRequest {
  /** Relative packaged asset name; traversal and absolute URLs are rejected. */
  path: string;
  maxBytes?: number;
}

export interface TextAssetReadResult {
  path: string;
  text: string;
  bytes: number;
}
