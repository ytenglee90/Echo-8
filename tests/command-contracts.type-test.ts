import type { ViewClient } from '../src/core/contracts.ts';

declare const client: ViewClient;

async function compileTimeCommandContracts(): Promise<void> {
  const annotation = await client.dispatch('annotation.update', {
    id: 'annotation:1',
    body: '正文批注',
    expectedRevision: 1,
  });
  annotation.revision.toFixed();

  const connection = await client.dispatch('connection.setLabel', {
    id: 'connection:1',
    label: '前置条件',
    expectedRevision: 1,
  });
  connection.revision.toFixed();

  const connectionSize = await client.dispatch('connection.resizeLabel', {
    id: 'connection:1',
    width: 260,
    height: 84,
    expectedRevision: connection.revision,
  });
  connectionSize.width.toFixed();
  connectionSize.height.toFixed();
  connectionSize.revision.toFixed();

  const persistence = await client.dispatch('system.persistence.setAutosaveInterval', {
    intervalMs: 60_000,
  });
  persistence.autosaveIntervalMs.toFixed();

  const saved = await client.dispatch('aiProvider.profile.save', {
    label: '本机模型',
    platform: 'compatible',
    endpoint: 'https://example.invalid/v1',
    model: 'model',
    authentication: 'bearer',
    apiStyle: 'openai',
  });
  saved.id.toUpperCase();

  // @ts-expect-error known commands require their declared payload shape
  await client.dispatch('annotation.update', { id: 'annotation:1' });
  // @ts-expect-error connection label edits are revision checked
  await client.dispatch('connection.setLabel', { id: 'connection:1', label: '缺少版本' });
  // @ts-expect-error connection label resizing requires both dimensions and a revision
  await client.dispatch('connection.resizeLabel', { id: 'connection:1', width: 260 });
  // @ts-expect-error known command results are inferred and cannot be invented by the caller
  void annotation.missingResultField;
  // Extension/test commands that are not yet in the application registry remain callable,
  // but their result is intentionally unknown until they publish a contract.
  await client.dispatch('extension.example', { value: true });
}

void compileTimeCommandContracts;
