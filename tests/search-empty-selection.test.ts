import assert from 'node:assert/strict';
import test from 'node:test';
import { ApplicationKernel } from '../src/core/kernel.ts';
import { textNodePlugin } from '../src/plugins/text-node/plugin.ts';
import { createSelectionPlugin } from '../src/plugins/selection/model.ts';
import { createSearchReplacePlugin } from '../src/plugins/search-replace/model.ts';
import type { SearchNavigationSignal, SearchResult } from '../src/protocols/search.ts';
import type { SelectionSnapshot } from '../src/protocols/selection.ts';

async function setup() {
  const kernel = new ApplicationKernel([textNodePlugin, createSelectionPlugin(), createSearchReplacePlugin()]);
  await kernel.start();
  const ids: string[] = [];
  for (const [title, body] of [['无匹配', '空白'], ['命中甲', '目标词'], ['命中乙', '目标词']]) {
    ids.push((await kernel.router.dispatch<{ id: string }>('node.create', { title, body }, 'core.test')).id);
  }
  const results = new Promise<SearchResult>(resolve => {
    const unsubscribe = kernel.router.subscribeSignal('core.test', 'search.results', message => {
      unsubscribe(); resolve(message.payload as SearchResult);
    });
  });
  await kernel.router.dispatch('search.run', { query: '目标词', scope: 'canvas', matchCase: false, wholeWord: false }, 'core.test');
  const result = await results;
  await kernel.router.dispatch('selection.set', { ids: [ids[0]] }, 'core.test');
  const select = () => kernel.capabilities.request<SelectionSnapshot>('selection.read@1');
  return { kernel, ids, result, select };
}
async function settled(predicate: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('navigation did not settle');
}

test('a nonmatching selection clears and falls back to canvas navigation without narrowing the next step', async () => {
  const { kernel, ids, select } = await setup();
  const history = kernel.history.getState().undoCount;
  const first = await kernel.router.dispatch<SearchNavigationSignal>('search.next', undefined, 'core.test');
  assert.equal(first.scope, 'canvas'); assert.equal(first.total, 2); assert.equal(first.nodeId, ids[1]);
  await settled(async () => (await select()).ids.length === 1 && (await select()).ids[0] === ids[1]);
  const second = await kernel.router.dispatch<SearchNavigationSignal>('search.next', undefined, 'core.test');
  assert.equal(second.nodeId, ids[2]); assert.equal(second.scope, 'canvas');
  await settled(async () => (await select()).ids[0] === ids[2]);
  assert.equal(kernel.history.getState().undoCount, history);
});

test('previous also falls back, while a selected node containing matches keeps its intentional scope', async () => {
  const { kernel, ids, select } = await setup();
  const previous = await kernel.router.dispatch<SearchNavigationSignal>('search.previous', undefined, 'core.test');
  assert.equal(previous.nodeId, ids[2]); assert.equal(previous.scope, 'canvas');
  await settled(async () => (await select()).ids[0] === ids[2]);
  await kernel.router.dispatch('selection.set', { ids: [ids[1]] }, 'core.test');
  await new Promise(resolve => setTimeout(resolve, 10));
  const scoped = await kernel.router.dispatch<SearchNavigationSignal>('search.next', undefined, 'core.test');
  assert.equal(scoped.nodeId, ids[1]); assert.equal(scoped.scope, 'selection'); assert.equal(scoped.total, 1);
});

test('replacement with a nonmatching selection navigates first and never replaces the whole canvas implicitly', async () => {
  const { kernel, ids, result, select } = await setup();
  const history = kernel.history.getState().undoCount;
  const replaced = await kernel.router.dispatch<{ replaced: number }>('search.replaceTargets', {
    requestId: result.requestId, replacement: '新内容',
  }, 'core.test');
  assert.equal(replaced.replaced, 0);
  await settled(async () => (await select()).ids[0] === ids[1]);
  assert.equal(kernel.history.getState().undoCount, history);
  const summaries = await kernel.capabilities.request<import('../src/protocols/content.ts').ContentSummary[]>('content.summaries@1');
  assert.equal(summaries.filter(node => node.preview === '目标词').length, 2);
});
