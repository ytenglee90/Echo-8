import assert from 'node:assert/strict';
import test from 'node:test';
import type { AIPromptTemplateRecord } from '../src/protocols/ai.ts';
import {
  isPromptTemplateCatalog,
  normalizePromptTemplateCatalog,
  parsePromptTemplateFile,
  serializePromptTemplateFile,
  uniquePromptTemplateName,
} from '../src/plugins/ai-assistant/prompt-template-files.ts';
import { promptTemplateTransaction } from '../src/plugins/ai-assistant/prompt-template-runtime.ts';

function template(overrides: Partial<AIPromptTemplateRecord> = {}): AIPromptTemplateRecord {
  return {
    id: 'template:1',
    name: '内容创作',
    systemInstruction: '严格核对事实。',
    userInstruction: '执行 {{operation}}。',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

test('Prompt template TXT codec preserves user-facing content without internal metadata', () => {
  const source = template();
  const serialized = serializePromptTemplateFile(source);
  const parsed = parsePromptTemplateFile(`\uFEFF${serialized.replace(/\n/gu, '\r\n')}`);

  assert.deepEqual(parsed, {
    name: source.name,
    systemInstruction: source.systemInstruction,
    userInstruction: source.userInstruction,
  });
  assert.equal(serialized.includes(source.id), false);
  assert.equal(serialized.trimStart().startsWith('{'), false);
});

test('Prompt template TXT parser rejects an unrelated or incomplete text file', () => {
  assert.throws(() => parsePromptTemplateFile('普通文本'), /不是有效/u);
  assert.throws(
    () => parsePromptTemplateFile('模板名称：测试\n\n系统工作方式：\n\n\n本次任务前缀：\n'),
    /内容不完整/u,
  );
});

test('Prompt template catalog normalization keeps valid records and a valid active selection only', () => {
  const valid = template();
  const malformed = { ...valid, id: '', name: '坏记录' };

  assert.deepEqual(normalizePromptTemplateCatalog([malformed, valid], valid.id), {
    templates: [valid],
    activeTemplateId: valid.id,
  });
  assert.deepEqual(normalizePromptTemplateCatalog([valid], 'missing'), {
    templates: [valid],
    activeTemplateId: undefined,
  });
  assert.equal(isPromptTemplateCatalog({ templates: [valid], activeTemplateId: valid.id }), true);
  assert.equal(isPromptTemplateCatalog({ templates: [malformed] }), false);
});

test('Prompt template names receive deterministic suffixes without changing the original records', () => {
  const templates = [
    template(),
    template({ id: 'template:2', name: '内容创作 (2)' }),
  ];

  assert.equal(uniquePromptTemplateName(' 内容创作 ', templates), '内容创作 (3)');
  assert.equal(uniquePromptTemplateName('代码审查', templates), '代码审查');
});

test('Prompt template changes remain personal workspace patches outside document history', () => {
  const source = template();
  const transaction = promptTemplateTransaction('保存模板', [source], source.id);

  assert.equal(transaction.history, false);
  assert.equal(transaction.patches.every((patch) => patch.domain === 'workspace'), true);
  assert.deepEqual(transaction.patches.map((patch) => patch.key), [
    'promptTemplates',
    'activePromptTemplateId',
  ]);
  assert.deepEqual(transaction.events, [{
    type: 'ai.prompt.configuration.changed',
    payload: { activeTemplateId: source.id },
  }]);
});
