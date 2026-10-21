import { HttpError } from './http.ts';

const API_ROOT = 'https://api.cloudflare.com/client/v4';

interface ApiEnvelope<TResult> {
  success?: boolean;
  result?: TResult;
  errors?: Array<{ code?: number; message?: string }>;
}

export async function cloudflareApi<TResult>(
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<TResult> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${accessToken}`);
  headers.set('accept', 'application/json');
  if (init.body && !(init.body instanceof FormData) && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(`${API_ROOT}${path}`, { ...init, headers, cache: 'no-store' });
  let body: ApiEnvelope<TResult> | undefined;
  try { body = await response.json() as ApiEnvelope<TResult>; } catch { /* handled below */ }
  if (!response.ok || body?.success === false || body?.result === undefined) {
    const detail = body?.errors?.map((error) => error.message).filter(Boolean).join('；') || `HTTP ${response.status}`;
    throw new HttpError(response.status === 401 || response.status === 403 ? 403 : 502, `Cloudflare API：${detail}`);
  }
  return body.result;
}

