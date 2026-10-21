import type { CloudControlEnv } from './env.ts';
import { readCookie, SESSION_COOKIE } from './http.ts';
import { signCompactJson, verifyCompactJson } from './crypto.ts';

interface SessionClaims {
  sub: string;
  exp: number;
  nonce: string;
}

export async function createSession(userId: string, env: Required<CloudControlEnv>): Promise<string> {
  return signCompactJson({
    sub: userId,
    exp: Date.now() + 30 * 24 * 60 * 60_000,
    nonce: crypto.randomUUID(),
  } satisfies SessionClaims, env.SESSION_SECRET);
}

export async function readSession(request: Request, env: Required<CloudControlEnv>): Promise<SessionClaims | undefined> {
  const session = await verifyCompactJson<SessionClaims>(readCookie(request, SESSION_COOKIE), env.SESSION_SECRET);
  if (!session || typeof session.sub !== 'string' || !Number.isFinite(session.exp) || session.exp <= Date.now()) {
    return undefined;
  }
  return session;
}

