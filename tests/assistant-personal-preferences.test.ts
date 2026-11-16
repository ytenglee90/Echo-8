import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../cloud/data-worker/worker.js';
import { signDataToken } from '../src/server/cloud/crypto.ts';
import { emptyAssistantPreferences, isAssistantPreferences, type AssistantPreferences } from '../src/protocols/assistant-preferences.ts';
import { resolvePreference } from '../src/plugins/ai-assistant/personal-preferences.ts';
import { SQLiteD1 } from './helpers/d1.ts';

test('personal account settings survive reload, reject stale re-insertion, and stay under the signed identity', async () => {
  const db = new SQLiteD1();
  const env = { DB: db, DATA_WORKER_VERSION: '8', STORAGE_MODE: 'd1', INSTALLATION_ID: 'assistant-prefs-test',
    DATA_SIGNING_SECRET: 'assistant-preferences-fixture', ALLOWED_ORIGIN: 'https://canvas.example' };
  const request = async (user: string, account: string, body?: unknown) => {
    const signed = await signDataToken({ sub: user, aud: env.INSTALLATION_ID, installationId: env.INSTALLATION_ID,
      scope: ['projects:read', 'projects:write'] }, env.DATA_SIGNING_SECRET, 600);
    return worker.fetch(new Request('https://data.example/v2/assistant-preferences?account=' + account, {
      method: body === undefined ? 'GET' : 'PUT',
      headers: { authorization: `Bearer ${signed.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env);
  };
  const blank = emptyAssistantPreferences();
  const value: AssistantPreferences = { ...blank, entries: [
    { kind: 'phrase', id: 'group-phrase', phrase: '收一下', enabled: true, action: 'group', status: 'active', evidence: 1 },
  ] };
  assert.deepEqual(await (await request('alice', 'alice')).json(), { revision: 0, preferences: blank });
  assert.equal((await request('alice', 'alice', { expectedRevision: 0, preferences: value })).status, 200);
  assert.deepEqual(await (await request('alice', 'alice')).json(), { revision: 1, preferences: value });
  assert.equal((await request('alice', 'bob')).status, 403);
  assert.deepEqual(await (await request('bob', 'bob')).json(), { revision: 0, preferences: blank });
  assert.equal((await request('alice', 'alice', { expectedRevision: 1, preferences: blank })).status, 200);
  assert.equal((await request('alice', 'alice', { expectedRevision: 1, preferences: value })).status, 409);
  assert.deepEqual(await (await request('alice', 'alice')).json(), { revision: 2, preferences: blank });
  const tampered = { ...value, entries: [{ ...value.entries[0], action: 'delete-all' }] };
  assert.equal(isAssistantPreferences(tampered), false);
  assert.equal((await request('alice', 'alice', { expectedRevision: 2, preferences: tampered })).status, 400);
});

test('accepted account phrases apply only in their scope, and an explicit gap overrides a preference', () => {
  const value: AssistantPreferences = { ...emptyAssistantPreferences(), entries: [
    { kind: 'phrase', id: 'candidate', phrase: '捏一起', enabled: true, action: 'group', status: 'candidate', evidence: 2 },
    { kind: 'phrase', id: 'accepted', phrase: '收一下', enabled: true, action: 'group', status: 'active', evidence: 1, bookId: 'book-a' },
    { kind: 'gap', id: 'g', enabled: true, gap: 80 },
  ] };
  assert.equal(resolvePreference('收一下。', value, 'book-a')?.instruction, '把选中的节点分组');
  assert.equal(resolvePreference('收一下', value, 'book-b'), undefined);
  assert.equal(resolvePreference('捏一起', value), undefined);
  assert.equal(resolvePreference('收一下', { ...value, enabled: false }, 'book-a'), undefined);
  assert.equal(resolvePreference('把选中节点横排', value)?.instruction, '把选中节点横排，间距 80');
  assert.equal(resolvePreference('把选中节点横排，间距 120', value), undefined);
});
