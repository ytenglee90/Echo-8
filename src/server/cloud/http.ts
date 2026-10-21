import { CloudConfigurationError } from './env.ts';

export const SESSION_COOKIE = '__Host-echo8_session';
export const OAUTH_STATE_COOKIE = '__Host-echo8_oauth_state';

export function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function apiError(error: unknown): Response {
  if (error instanceof CloudConfigurationError) return json({ error: error.message, configured: false }, 503);
  const status = error instanceof HttpError ? error.status : 500;
  const message = status >= 500 ? '云服务暂时不可用' : error instanceof Error ? error.message : String(error);
  if (status >= 500) console.error('echo8-cloud-api', error);
  return json({ error: message }, status);
}

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function readCookie(request: Request, name: string): string | undefined {
  const cookies = request.headers.get('cookie') ?? '';
  for (const pair of cookies.split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 0) continue;
    if (pair.slice(0, separator).trim() === name) return decodeURIComponent(pair.slice(separator + 1).trim());
  }
  return undefined;
}

export function secureCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function expiredCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function readBody<T extends Record<string, unknown>>(request: Request): Promise<T> {
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > 1024 * 1024) throw new HttpError(413, '请求过大');
  try {
    const value = await request.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as T;
  } catch {
    throw new HttpError(400, '请求结构无效');
  }
}
