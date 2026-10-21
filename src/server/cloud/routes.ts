import {
  CLOUD_DATA_WORKER_VERSION,
  cloudDataWorkerUpgradeAvailable,
  type CloudControlStatus,
  type CloudInstallationSummary,
} from '../../cloud/contracts.ts';
import { decryptJson, encryptJson, randomSecret, signCompactJson, signDataToken, verifyCompactJson } from './crypto.ts';
import { CloudConfigurationError, requireCloudControlEnv, type CloudControlEnv } from './env.ts';
import { HttpError, OAUTH_STATE_COOKIE, SESSION_COOKIE, apiError, expiredCookie, json, readBody, readCookie, secureCookie } from './http.ts';
import { createSession, readSession } from './session.ts';
import {
  authorizationUrl,
  exchangeAuthorizationCode,
  fetchAccounts,
  fetchIdentity,
  refreshTokenSet,
  type OAuthTokenSet,
} from './oauth.ts';
import {
  listInstallations,
  readInstallation,
  readOAuthGrant,
  readUser,
  upsertUser,
  writeInstallation,
  writeOAuthGrant,
  type StoredInstallation,
} from './control-store.ts';
import { provisionInstallation } from './provision.ts';

interface OAuthState {
  nonce: string;
  exp: number;
  returnTo: string;
}

export async function cloudStatusRoute(request: Request): Promise<Response> {
  try {
    const env = requireCloudControlEnv();
    const session = await readSession(request, env);
    if (!session) return json(emptyStatus(true));
    const [user, grant, installations] = await Promise.all([
      readUser(env.CONTROL_DB, session.sub),
      readOAuthGrant(env.CONTROL_DB, session.sub),
      listInstallations(env.CONTROL_DB, session.sub),
    ]);
    if (!user || !grant) return json(emptyStatus(true));
    const status: CloudControlStatus = {
      configured: true,
      authenticated: true,
      user,
      accounts: grant.accounts,
      installations: installations.map(publicInstallation),
    };
    return json(status);
  } catch (error) {
    if (error instanceof CloudConfigurationError) return json(emptyStatus(false));
    return apiError(error);
  }
}

export async function oauthStartRoute(request: Request): Promise<Response> {
  try {
    const env = requireCloudControlEnv();
    const requestUrl = new URL(request.url);
    const returnTo = safeReturnTo(requestUrl.searchParams.get('returnTo'));
    const stateValue: OAuthState = { nonce: crypto.randomUUID(), exp: Date.now() + 10 * 60_000, returnTo };
    const state = await signCompactJson(stateValue, env.SESSION_SECRET);
    const headers = new Headers({ location: authorizationUrl(env, state) });
    headers.append('set-cookie', secureCookie(OAUTH_STATE_COOKIE, state, 10 * 60));
    return new Response(null, { status: 302, headers });
  } catch (error) {
    return apiError(error);
  }
}

export async function oauthCallbackRoute(request: Request): Promise<Response> {
  const fallback = new URL('/?cloud=error', request.url);
  try {
    const env = requireCloudControlEnv();
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const expected = readCookie(request, OAUTH_STATE_COOKIE);
    if (!code || !state || !expected || state !== expected) throw new HttpError(400, 'OAuth 状态校验失败');
    const claims = await verifyCompactJson<OAuthState>(state, env.SESSION_SECRET);
    if (!claims || claims.exp <= Date.now() || typeof claims.nonce !== 'string') throw new HttpError(400, 'OAuth 请求已经过期');
    const tokenSet = await exchangeAuthorizationCode(env, code);
    const [identity, accounts] = await Promise.all([
      fetchIdentity(tokenSet.accessToken),
      fetchAccounts(tokenSet.accessToken),
    ]);
    if (!accounts.length) throw new HttpError(403, '当前授权没有可用的 Cloudflare 账户');
    await upsertUser(env.CONTROL_DB, identity);
    await writeOAuthGrant(env.CONTROL_DB, {
      userId: identity.id,
      tokenEncrypted: await encryptJson(tokenSet, env.TOKEN_ENCRYPTION_KEY),
      accounts,
      expiresAt: tokenSet.expiresAt,
    });
    const session = await createSession(identity.id, env);
    const redirect = new URL(claims.returnTo || '/', env.PUBLIC_APP_ORIGIN);
    redirect.searchParams.set('cloud', 'connected');
    const headers = new Headers({ location: redirect.toString() });
    headers.append('set-cookie', secureCookie(SESSION_COOKIE, session, 30 * 24 * 60 * 60));
    headers.append('set-cookie', expiredCookie(OAUTH_STATE_COOKIE));
    return new Response(null, { status: 302, headers });
  } catch (error) {
    console.error('echo8-oauth-callback', error);
    fallback.searchParams.set('reason', error instanceof Error ? error.message.slice(0, 160) : 'unknown');
    return new Response(null, { status: 302, headers: { location: fallback.toString(), 'set-cookie': expiredCookie(OAUTH_STATE_COOKIE) } });
  }
}

export async function logoutRoute(): Promise<Response> {
  return json({ loggedOut: true }, 200, { 'set-cookie': expiredCookie(SESSION_COOKIE) });
}

export async function installRoute(request: Request): Promise<Response> {
  let pending: StoredInstallation | undefined;
  try {
    const env = requireCloudControlEnv();
    const userId = await requireUserId(request, env);
    const body = await readBody<{ accountId?: unknown }>(request);
    if (typeof body.accountId !== 'string') throw new HttpError(400, '请选择 Cloudflare 账户');
    const { grant, tokenSet } = await activeTokenSet(env, userId);
    const account = grant.accounts.find((item) => item.id === body.accountId);
    if (!account) throw new HttpError(403, '该账户不在本次 Cloudflare 授权范围内');
    const existing = (await listInstallations(env.CONTROL_DB, userId)).find((item) => item.accountId === account.id);
    if (existing?.status === 'ready') return json({ installation: publicInstallation(existing) });
    const signingSecret = existing
      ? await decryptJson<string>(existing.signingSecretEncrypted, env.TOKEN_ENCRYPTION_KEY)
      : randomSecret();
    const id = existing?.id ?? `installation-${crypto.randomUUID()}`;
    pending = {
      id,
      userId,
      accountId: account.id,
      accountName: account.name,
      workerName: existing?.workerName ?? resourceName('echo8-data', id),
      workerUrl: existing?.workerUrl ?? '',
      d1DatabaseId: existing?.d1DatabaseId,
      r2BucketName: existing?.r2BucketName,
      workerVersion: existing?.workerVersion ?? 0,
      signingSecretEncrypted: existing?.signingSecretEncrypted ?? await encryptJson(signingSecret, env.TOKEN_ENCRYPTION_KEY),
      status: 'provisioning',
    };
    await writeInstallation(env.CONTROL_DB, pending);
    const ready = await provisionInstallation({
      installation: pending,
      accessToken: tokenSet.accessToken,
      dataSigningSecret: signingSecret,
      allowedOrigin: env.PUBLIC_APP_ORIGIN,
      onProgress: async (progress) => {
        pending = progress;
        await writeInstallation(env.CONTROL_DB, progress);
      },
    });
    await writeInstallation(env.CONTROL_DB, ready);
    return json({ installation: publicInstallation(ready) }, 201);
  } catch (error) {
    if (pending) {
      try {
        const env = requireCloudControlEnv();
        await writeInstallation(env.CONTROL_DB, {
          ...pending,
          status: 'error',
          error: error instanceof Error ? error.message.slice(0, 500) : String(error),
        });
      } catch { /* retain original provisioning error */ }
    }
    return apiError(error);
  }
}

export async function upgradeRoute(request: Request): Promise<Response> {
  try {
    const env = requireCloudControlEnv();
    const userId = await requireUserId(request, env);
    const body = await readBody<{ installationId?: unknown }>(request);
    if (typeof body.installationId !== 'string') throw new HttpError(400, '安装编号无效');
    const installation = await readInstallation(env.CONTROL_DB, userId, body.installationId);
    if (!installation || installation.status !== 'ready' || !installation.d1DatabaseId) {
      throw new HttpError(404, '云存储安装尚未就绪');
    }
    if (installation.workerVersion >= CLOUD_DATA_WORKER_VERSION) {
      return json({ installation: publicInstallation(installation) });
    }
    const { grant, tokenSet } = await activeTokenSet(env, userId);
    if (!grant.accounts.some((account) => account.id === installation.accountId)) {
      throw new HttpError(403, '该安装所在账户不在本次 Cloudflare 授权范围内');
    }
    const signingSecret = await decryptJson<string>(
      installation.signingSecretEncrypted,
      env.TOKEN_ENCRYPTION_KEY,
    );
    const upgraded = await provisionInstallation({
      installation,
      accessToken: tokenSet.accessToken,
      dataSigningSecret: signingSecret,
      allowedOrigin: env.PUBLIC_APP_ORIGIN,
    });
    await writeInstallation(env.CONTROL_DB, upgraded);
    return json({ installation: publicInstallation(upgraded) });
  } catch (error) {
    return apiError(error);
  }
}

export async function dataTokenRoute(request: Request): Promise<Response> {
  try {
    const env = requireCloudControlEnv();
    const userId = await requireUserId(request, env);
    const body = await readBody<{ installationId?: unknown }>(request);
    if (typeof body.installationId !== 'string') throw new HttpError(400, '安装编号无效');
    const installation = await readInstallation(env.CONTROL_DB, userId, body.installationId);
    if (!installation || installation.status !== 'ready' || !installation.workerUrl) {
      throw new HttpError(404, '云存储安装尚未就绪');
    }
    const secret = await decryptJson<string>(installation.signingSecretEncrypted, env.TOKEN_ENCRYPTION_KEY);
    const signed = await signDataToken({
      sub: userId,
      aud: installation.id,
      installationId: installation.id,
      scope: ['projects:read', 'projects:write'],
    }, secret);
    return json({
      installationId: installation.id,
      workerUrl: installation.workerUrl,
      token: signed.token,
      expiresAt: signed.expiresAt,
    });
  } catch (error) {
    return apiError(error);
  }
}

async function requireUserId(request: Request, env: Required<CloudControlEnv>): Promise<string> {
  const session = await readSession(request, env);
  if (!session) throw new HttpError(401, '请先连接 Cloudflare 账户');
  return session.sub;
}

async function activeTokenSet(env: Required<CloudControlEnv>, userId: string) {
  const grant = await readOAuthGrant(env.CONTROL_DB, userId);
  if (!grant) throw new HttpError(401, 'Cloudflare 授权不存在，请重新连接');
  let tokenSet = await decryptJson<OAuthTokenSet>(grant.tokenEncrypted, env.TOKEN_ENCRYPTION_KEY);
  if (tokenSet.expiresAt && tokenSet.expiresAt <= Date.now() + 60_000) {
    if (!tokenSet.refreshToken) throw new HttpError(401, 'Cloudflare 授权已过期，请重新连接');
    const refreshed = await refreshTokenSet(env, tokenSet.refreshToken);
    tokenSet = { ...refreshed, refreshToken: refreshed.refreshToken ?? tokenSet.refreshToken };
    await writeOAuthGrant(env.CONTROL_DB, {
      ...grant,
      tokenEncrypted: await encryptJson(tokenSet, env.TOKEN_ENCRYPTION_KEY),
      expiresAt: tokenSet.expiresAt,
    });
  }
  return { grant, tokenSet };
}

function publicInstallation(value: StoredInstallation): CloudInstallationSummary {
  return {
    id: value.id,
    accountId: value.accountId,
    accountName: value.accountName,
    workerUrl: value.workerUrl,
    workerVersion: value.workerVersion,
    latestWorkerVersion: CLOUD_DATA_WORKER_VERSION,
    upgradeAvailable: cloudDataWorkerUpgradeAvailable(value.workerVersion),
    status: value.status,
    error: value.error,
  };
}

function emptyStatus(configured: boolean): CloudControlStatus {
  return { configured, authenticated: false, accounts: [], installations: [] };
}

function safeReturnTo(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/';
}

function resourceName(prefix: string, id: string): string {
  const suffix = id.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(-20) || crypto.randomUUID().slice(0, 12);
  return `${prefix}-${suffix}`.slice(0, 63).replace(/-+$/u, '');
}
