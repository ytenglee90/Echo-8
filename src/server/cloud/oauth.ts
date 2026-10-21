import type { CloudAccountSummary } from '../../cloud/contracts.ts';
import type { CloudControlEnv } from './env.ts';
import { HttpError } from './http.ts';

const AUTHORIZATION_ENDPOINT = 'https://dash.cloudflare.com/oauth2/auth';
const TOKEN_ENDPOINT = 'https://dash.cloudflare.com/oauth2/token';
const USERINFO_ENDPOINT = 'https://dash.cloudflare.com/oauth2/userinfo';
const API_ENDPOINT = 'https://api.cloudflare.com/client/v4';
const TOKEN_REQUEST_ATTEMPTS = 2;

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  scope?: string;
  expiresAt?: number;
}

export interface CloudflareIdentity {
  id: string;
  email?: string;
  name?: string;
}

export function oauthRedirectUri(env: Required<CloudControlEnv>): string {
  return new URL('/api/cloud/oauth/callback', normalizedOrigin(env.PUBLIC_APP_ORIGIN)).toString();
}

export function authorizationUrl(
  env: Required<CloudControlEnv>,
  state: string,
): string {
  const url = new URL(AUTHORIZATION_ENDPOINT);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', env.CLOUDFLARE_OAUTH_CLIENT_ID);
  url.searchParams.set('redirect_uri', oauthRedirectUri(env));
  url.searchParams.set('state', state);
  const scopes = env.CLOUDFLARE_OAUTH_SCOPES?.trim();
  if (scopes) url.searchParams.set('scope', scopes);
  return url.toString();
}

export async function exchangeAuthorizationCode(
  env: Required<CloudControlEnv>,
  code: string,
): Promise<OAuthTokenSet> {
  return requestToken(env, new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: oauthRedirectUri(env),
  }));
}

export async function refreshTokenSet(
  env: Required<CloudControlEnv>,
  refreshToken: string,
): Promise<OAuthTokenSet> {
  return requestToken(env, new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }));
}

export async function fetchIdentity(accessToken: string): Promise<CloudflareIdentity> {
  const response = await fetch(USERINFO_ENDPOINT, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    cache: 'no-store',
  });
  if (!response.ok) throw new HttpError(502, `Cloudflare 用户信息返回 HTTP ${response.status}`);
  const body = await response.json() as Record<string, unknown>;
  const id = typeof body.sub === 'string' ? body.sub : typeof body.id === 'string' ? body.id : '';
  if (!id) throw new HttpError(502, 'Cloudflare 用户信息缺少唯一编号');
  return {
    id,
    email: typeof body.email === 'string' ? body.email : undefined,
    name: typeof body.name === 'string' ? body.name : undefined,
  };
}

export async function fetchAccounts(accessToken: string): Promise<CloudAccountSummary[]> {
  const response = await fetch(`${API_ENDPOINT}/memberships?status=accepted&per_page=50`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    cache: 'no-store',
  });
  const body = await response.json() as {
    success?: boolean;
    result?: Array<{ account?: { id?: string; name?: string } }>;
    errors?: Array<{ message?: string }>;
  };
  if (!response.ok || body.success === false) {
    throw new HttpError(502, body.errors?.[0]?.message || `Cloudflare 账户列表返回 HTTP ${response.status}`);
  }
  const unique = new Map<string, CloudAccountSummary>();
  for (const membership of body.result ?? []) {
    const id = membership.account?.id;
    if (id) unique.set(id, { id, name: membership.account?.name || id });
  }
  return [...unique.values()];
}

async function requestToken(env: Required<CloudControlEnv>, params: URLSearchParams): Promise<OAuthTokenSet> {
  const credentials = btoa(`${env.CLOUDFLARE_OAUTH_CLIENT_ID}:${env.CLOUDFLARE_OAUTH_CLIENT_SECRET}`);
  let lastFailure = 'Cloudflare 暂时没有返回有效响应';
  for (let attempt = 0; attempt < TOKEN_REQUEST_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Basic ${credentials}`,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: params,
        cache: 'no-store',
      });
      const body = await readJsonObject(response);
      if (response.ok && typeof body?.access_token === 'string') return tokenSetFromBody(body);

      const description = tokenFailureDescription(response, body);
      lastFailure = description;
      if (!retryableTokenFailure(response, body) || attempt === TOKEN_REQUEST_ATTEMPTS - 1) break;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : '网络请求失败';
      if (attempt === TOKEN_REQUEST_ATTEMPTS - 1) break;
    }
    await shortRetryDelay();
  }
  throw new HttpError(502, `Cloudflare OAuth 令牌交换失败：${lastFailure}`);
}

async function readJsonObject(response: Response): Promise<Record<string, unknown> | undefined> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function retryableTokenFailure(response: Response, body: Record<string, unknown> | undefined): boolean {
  return response.status !== 429 && (!body || response.status >= 500);
}

function tokenFailureDescription(response: Response, body: Record<string, unknown> | undefined): string {
  if (response.status === 429) return '操作太频繁，请等待一两分钟后重新连接';
  if (typeof body?.error_description === 'string') return body.error_description;
  return body ? `HTTP ${response.status}` : `HTTP ${response.status}（响应格式不是 JSON）`;
}

function tokenSetFromBody(body: Record<string, unknown>): OAuthTokenSet {
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : undefined;
  return {
    accessToken: body.access_token as string,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
    tokenType: typeof body.token_type === 'string' ? body.token_type : 'Bearer',
    scope: typeof body.scope === 'string' ? body.scope : undefined,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
  };
}

function shortRetryDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 150));
}

function normalizedOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') throw new Error('PUBLIC_APP_ORIGIN 必须使用 HTTPS');
  return url.origin;
}
