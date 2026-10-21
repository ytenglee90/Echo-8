export interface PersonalPreferenceReadRequest {
  key: string;
}

export interface PersonalPreferenceWriteRequest extends PersonalPreferenceReadRequest {
  value: unknown;
}
