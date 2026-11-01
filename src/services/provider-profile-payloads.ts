import { isRecord } from '../core/contracts.ts';

export interface ProfileIdPayload {
  profileId?: string;
}

export interface SessionKeyPayload extends ProfileIdPayload {
  apiKey: string;
}

export function isRequiredProfileIdPayload(value: unknown): value is { profileId: string } {
  return isRecord(value) && typeof value.profileId === 'string' && value.profileId.length > 0;
}

export function isOptionalProfileIdPayload(value: unknown): value is ProfileIdPayload {
  return value === undefined || (isRecord(value) &&
    (value.profileId === undefined || typeof value.profileId === 'string'));
}

export function isSessionKeyPayload(value: unknown): value is SessionKeyPayload {
  return isRecord(value) && typeof value.apiKey === 'string' && value.apiKey.length <= 4096 &&
    (value.profileId === undefined || typeof value.profileId === 'string');
}
