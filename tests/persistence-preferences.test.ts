import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import dataWorker from '../cloud/data-worker/worker.js';
import { SQLiteD1 } from './helpers/d1.ts';
import { signDataToken } from '../src/server/cloud/crypto.ts';
import { AUTOSAVE_INTERVAL_OPTIONS } from '../src/protocols/files.ts';
import { RECOVERY_RETENTION_OPTIONS } from '../src/protocols/recovery-management.ts';
import { isPersistencePreferences, type PersistencePreferences } from '../src/protocols/persistence-preferences.ts';
import { planPersistencePreferenceSync, preferenceFingerprint } from '../src/plugins/cloud-sync/persistence-preferences-sync.ts';
import { ApplicationKernel } from '../src/core/kernel.ts';

const preferences: PersistencePreferences = { schemaVersion: 1, autosaveIntervalMs: 0, recoveryRetentionLimit: null };

test('saving preferences restore on a fresh device, preserve resets, and protect other accounts and concurrent changes', () => {
  const remote = { revision: 4, preferences };
  const local = { ...preferences, autosaveIntervalMs: 1000, recoveryRetentionLimit: 8 };
  assert.equal(planPersistencePreferenceSync('a', local, remote).action, 'download');
  assert.equal(planPersistencePreferenceSync('a', local, { revision: 0, preferences: null }).action, 'upload');
  const saved = { scope: 'a', revision: 4, baseline: preferenceFingerprint(local), dirty: false };
  assert.equal(planPersistencePreferenceSync('a', preferences, { revision: 4, preferences: local }, saved).action, 'upload');
  assert.equal(planPersistencePreferenceSync('a', preferences, { revision: 5, preferences: local }, saved).action, 'conflict');
  assert.equal(planPersistencePreferenceSync('b', local, { revision: 0, preferences: null }, saved).action, 'download');
  assert.equal(planPersistencePreferenceSync('a', preferences, remote, saved).action, 'equal');
});

test('account API accepts every supported cadence and retention option, enforces CAS and isolates identities', async () => {
  const db = new SQLiteD1();
  const env = { DB: db, DATA_WORKER_VERSION: '6', STORAGE_MODE: 'd1', INSTALLATION_ID: 'preferences-installation', DATA_SIGNING_SECRET: 'preferences-test-secret', ALLOWED_ORIGIN: 'https://canvas.example' };
  const request = async (user: string, method = 'GET', body?: unknown) => {
    const signed = await signDataToken({ sub: user, aud: env.INSTALLATION_ID, installationId: env.INSTALLATION_ID, scope: ['projects:read', 'projects:write'] }, env.DATA_SIGNING_SECRET, 600);
    return dataWorker.fetch(new Request('https://data.example/v2/preferences', {
      method, headers: { authorization: `Bearer ${signed.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env);
  };
  assert.deepEqual(await (await request('alice')).json(), { revision: 0, preferences: null });
  let revision = 0;
  for (const interval of AUTOSAVE_INTERVAL_OPTIONS) for (const limit of [null, ...RECOVERY_RETENTION_OPTIONS]) {
    const value = { ...preferences, autosaveIntervalMs: interval, recoveryRetentionLimit: limit };
    assert.equal(isPersistencePreferences(value), true);
    const result = await request('alice', 'PUT', { expectedRevision: revision, preferences: value });
    assert.equal(result.status, 200); revision++;
    assert.deepEqual(await result.json(), { revision });
    assert.deepEqual(await (await request('alice')).json(), { revision, preferences: value });
  }
  assert.deepEqual(await (await request('bob')).json(), { revision: 0, preferences: null });
  assert.equal((await request('alice', 'PUT', { expectedRevision: 0, preferences })).status, 409);
  for (const value of [{ ...preferences, autosaveIntervalMs: 1 }, { ...preferences, recoveryRetentionLimit: 0 }, { ...preferences, recoveryRetentionLimit: 'none' }, { ...preferences, secret: 'excluded' }, { ...preferences, schemaVersion: 2 }]) {
    assert.equal(isPersistencePreferences(value), false);
    assert.equal((await request('alice', 'PUT', { expectedRevision: revision, preferences: value })).status, 400);
  }
  assert.equal((await request('alice', 'PUT', { expectedRevision: -1, preferences })).status, 400);
  assert.equal((await request('alice', 'DELETE')).status, 405);
  const reset = await request('alice', 'PUT', { expectedRevision: revision, preferences });
  assert.equal(reset.status, 200);
  assert.equal(db.sqlite.prepare('SELECT count(*) AS count FROM account_preferences').get()!.count, 1);
  assert.equal(db.sqlite.prepare('SELECT count(*) AS count FROM account_shortcuts').get()!.count, 0);
});

test('D1 preference migration is additive and idempotent over existing books and account shortcuts', () => {
  const db = new SQLiteD1();
  db.sqlite.exec("DROP TABLE account_preferences; DELETE FROM schema_migrations WHERE version=4; INSERT INTO account_shortcuts VALUES ('alice', 7, '[]', 1)");
  db.sqlite.exec("INSERT INTO projects(id,name,created_at,updated_at,head_revision) VALUES ('existing-book','保留的书籍',1,2,17)");
  const schema = readFileSync(new URL('../cloud/data-worker/schema.sql', import.meta.url), 'utf8');
  db.sqlite.exec(schema); db.sqlite.exec(schema);
  assert.equal(db.sqlite.prepare("SELECT revision FROM account_shortcuts WHERE user_id='alice'").get()!.revision, 7);
  assert.equal(db.sqlite.prepare('SELECT count(*) AS count FROM account_preferences').get()!.count, 0);
  assert.equal(db.sqlite.prepare('SELECT count(*) AS count FROM schema_migrations WHERE version=4').get()!.count, 1);
  assert.deepEqual({ ...db.sqlite.prepare("SELECT name,head_revision FROM projects WHERE id='existing-book'").get() }, { name: '保留的书籍', head_revision: 17 });
});

test('core preference messages validate before changing personal state and leave document history untouched', async () => {
  const kernel = new ApplicationKernel([]);
  const before = kernel.history.export();
  const read = () => kernel.router.ask<PersistencePreferences>('system.persistence.preferences@1', undefined, 'core.test');
  assert.deepEqual(await read(), { ...preferences, autosaveIntervalMs: 60000 });
  await kernel.router.dispatch('system.persistence.applyPreferences@1', preferences, 'core.test');
  assert.deepEqual(await read(), preferences);
  await assert.rejects(kernel.router.dispatch('system.persistence.applyPreferences@1', { ...preferences, recoveryRetentionLimit: 'none' }, 'core.test'), /Invalid command payload/u);
  assert.deepEqual(await read(), preferences);
  assert.deepEqual(kernel.history.export(), before);
  assert.equal(kernel.store.getDomainRevision('document'), 0);
});
