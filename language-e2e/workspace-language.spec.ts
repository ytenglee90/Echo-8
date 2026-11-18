import assert from 'node:assert/strict';
import { test } from '@playwright/test';
import { localActions } from '../src/plugins/workspace-actions/actions.ts';
import { allLanguageCases, languageCases } from './suites.ts';
import { exercise } from './harness.ts';
import { judge } from './oracles.ts';
import { languageFixture } from './fixture.ts';

const missing = localActions.filter(action => !allLanguageCases.some(entry => entry.id === action.descriptor.id));
assert.deepEqual(missing.map(action => action.descriptor.id), [], 'Every executable adapter needs three natural utterances');
for (const item of allLanguageCases) assert.equal(new Set(item.phrases).size, 3, item.id + ': duplicate utterances');
const filters = process.env.ECHO8_LANGUAGE_FILTER?.split(',').filter(Boolean);
const selected = filters ? languageCases.filter(item => filters.includes(item.id)) : languageCases;

for (const item of selected) for (const [index, phrase] of item.phrases.entries()) {
  test(item.id + ' #' + (index + 1) + ' ' + phrase, async ({ page }, info) => {
    const fixture = await languageFixture(item.setup === 'junction');
    const observation = judge(item, await exercise(page, item, phrase, index + 1, fixture), fixture);
    await info.attach('natural-language-observation', { body: Buffer.from(JSON.stringify(observation)), contentType: 'application/json' });
    // Test runner green means collection completed, never that the assistant's business behavior passed.
    assert.ok(observation.phrase === phrase);
  });
}
