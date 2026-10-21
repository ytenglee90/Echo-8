const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function signCompactJson(value: unknown, secret: string): Promise<string> {
  const payload = base64Url(encoder.encode(JSON.stringify(value)));
  return `${payload}.${await hmac(payload, secret)}`;
}

export async function verifyCompactJson<T>(value: string | undefined, secret: string): Promise<T | undefined> {
  if (!value) return undefined;
  const [payload, signature, extra] = value.split('.');
  if (!payload || !signature || extra || !await timingSafeEqual(signature, await hmac(payload, secret))) return undefined;
  try {
    return JSON.parse(decoder.decode(base64UrlBytes(payload))) as T;
  } catch {
    return undefined;
  }
}

export async function encryptJson(value: unknown, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encryptionKey(secret, ['encrypt']);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(value)));
  return `${base64Url(iv)}.${base64Url(new Uint8Array(encrypted))}`;
}

export async function decryptJson<T>(value: string, secret: string): Promise<T> {
  const [iv, encrypted, extra] = value.split('.');
  if (!iv || !encrypted || extra) throw new Error('加密数据结构无效');
  const key = await encryptionKey(secret, ['decrypt']);
  const ivBytes = base64UrlBytes(iv);
  const encryptedBytes = base64UrlBytes(encrypted);
  const clear = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: exactBuffer(ivBytes) },
    key,
    exactBuffer(encryptedBytes),
  );
  return JSON.parse(decoder.decode(clear)) as T;
}

export async function signDataToken(
  claims: { sub: string; aud: string; installationId: string; scope: string[] },
  secret: string,
  lifetimeSeconds = 600,
): Promise<{ token: string; expiresAt: number }> {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + lifetimeSeconds;
  const header = base64Url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = base64Url(encoder.encode(JSON.stringify({
    iss: 'echo8-control',
    ...claims,
    iat: now,
    exp: expiresAt,
    jti: crypto.randomUUID(),
  })));
  const body = `${header}.${payload}`;
  return { token: `${body}.${await hmac(body, secret)}`, expiresAt: expiresAt * 1000 };
}

export function randomSecret(bytes = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function encryptionKey(secret: string, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.digest('SHA-256', encoder.encode(secret)).then((digest) =>
    crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, usages));
}

async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value))));
}

async function timingSafeEqual(left: string, right: string): Promise<boolean> {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  if (leftBytes.length !== rightBytes.length) return false;
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) difference |= leftBytes[index] ^ rightBytes[index];
  return difference === 0;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function base64UrlBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function exactBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}
