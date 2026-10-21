export interface PersonalTextAssetReadRequest {
  key: string;
}

export interface PersonalTextAssetRecord {
  schemaVersion: 1;
  text: string;
  fileName?: string;
  updatedAt: number;
}

export interface PersonalTextAssetWriteRequest extends PersonalTextAssetReadRequest {
  asset: PersonalTextAssetRecord;
}
