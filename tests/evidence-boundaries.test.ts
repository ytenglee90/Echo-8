import assert from 'node:assert/strict';
import test from 'node:test';
import {
  enclosingChatExchange,
  enclosingChatTurn,
  enclosingCodeBlock,
  enclosingMarkdownList,
  enclosingMarkdownTable,
  estimateAITokens,
  evidenceFromLocalRange,
  fitRangeEndToTokenBudget,
} from '../src/plugins/ai-assistant/evidence-boundaries.ts';

test('AI evidence boundaries preserve complete Markdown and conversation structures', () => {
  const table = '| 名称 | 状态 |\n| --- | --- |\n| Echo-8 | 正常 |';
  assert.deepEqual(enclosingMarkdownTable(table, table.indexOf('Echo-8')), {
    start: 0,
    end: table.length,
  });

  const list = '- 第一项\n  补充说明\n- 第二项';
  assert.deepEqual(enclosingMarkdownList(list, list.indexOf('补充')), {
    start: 0,
    end: list.length,
  });

  const code = '前文\n\n```ts\nconst value = 1;\n```\n\n后文';
  const codeStart = code.indexOf('```ts');
  assert.deepEqual(enclosingCodeBlock(code, code.indexOf('value')), {
    start: codeStart,
    end: code.indexOf('```', codeStart + 3) + 3,
  });

  const transcript = '[用户]\n问题一\n\n[助手]\n回答一\n\n[用户]\n问题二';
  const turn = enclosingChatTurn(transcript, transcript.indexOf('回答一'));
  assert.equal(transcript.slice(turn?.start, turn?.end).trim(), '[助手]\n回答一');
  const exchange = enclosingChatExchange(transcript, transcript.indexOf('回答一'));
  assert.equal(transcript.slice(exchange?.start, exchange?.end).trim(), '[用户]\n问题一\n\n[助手]\n回答一');
});

test('AI token fitting is conservative for Chinese and never splits a surrogate pair', () => {
  assert.equal(estimateAITokens('中文测试'), 4);
  assert.ok(estimateAITokens('中文测试') > estimateAITokens('test'));

  const text = 'ab😀cd';
  const end = fitRangeEndToTokenBudget(text, 0, text.length, 1);
  assert.notEqual(text.charCodeAt(end - 1), 0xd83d);
});

test('AI evidence ranges trim surrounding whitespace but preserve absolute offsets', () => {
  const block = evidenceFromLocalRange(100, '  正文内容  ', { start: 0, end: 8 }, 'paragraph', true);
  assert.deepEqual(block, {
    start: 102,
    length: 4,
    text: '正文内容',
    boundary: 'paragraph',
    complete: true,
  });
});
