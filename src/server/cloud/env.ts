import { env as workerEnv } from 'cloudflare:workers';

export interface CloudControlEnv {
  CONTROL_DB?: D1Database;
  CLOUDFLARE_OAUTH_CLIENT_ID?: string;
  CLOUDFLARE_OAUTH_CLIENT_SECRET?: string;
  CLOUDFLARE_OAUTH_SCOPES?: string;
  SESSION_SECRET?: string;
  TOKEN_ENCRYPTION_KEY?: string;
  PUBLIC_APP_ORIGIN?: string;
}

export function cloudEnv(): CloudControlEnv {
  const bound = workerEnv as unknown as CloudControlEnv;
  return {
    ...bound,
    CLOUDFLARE_OAUTH_CLIENT_ID: bound.CLOUDFLARE_OAUTH_CLIENT_ID ?? process.env.CLOUDFLARE_OAUTH_CLIENT_ID,
    CLOUDFLARE_OAUTH_CLIENT_SECRET: bound.CLOUDFLARE_OAUTH_CLIENT_SECRET ?? process.env.CLOUDFLARE_OAUTH_CLIENT_SECRET,
    CLOUDFLARE_OAUTH_SCOPES: bound.CLOUDFLARE_OAUTH_SCOPES ?? process.env.CLOUDFLARE_OAUTH_SCOPES,
    SESSION_SECRET: bound.SESSION_SECRET ?? process.env.SESSION_SECRET,
    TOKEN_ENCRYPTION_KEY: bound.TOKEN_ENCRYPTION_KEY ?? process.env.TOKEN_ENCRYPTION_KEY,
    PUBLIC_APP_ORIGIN: bound.PUBLIC_APP_ORIGIN ?? process.env.PUBLIC_APP_ORIGIN,
  };
}

export function isCloudControlConfigured(env: CloudControlEnv): boolean {
  return Boolean(
    env.CONTROL_DB && env.CLOUDFLARE_OAUTH_CLIENT_ID && env.CLOUDFLARE_OAUTH_CLIENT_SECRET &&
    env.SESSION_SECRET && env.TOKEN_ENCRYPTION_KEY && env.PUBLIC_APP_ORIGIN,
  );
}

export function requireCloudControlEnv(): Required<CloudControlEnv> {
  const env = cloudEnv();
  if (!isCloudControlConfigured(env)) {
    throw new CloudConfigurationError('Cloudflare 云同步尚未配置');
  }
  return env as Required<CloudControlEnv>;
}

export class CloudConfigurationError extends Error {}

