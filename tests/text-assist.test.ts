import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import type { ContentSummary } from '../src/protocols/content.ts';
import {
  analyzeTextAssistance,
  buildTextAssistCatalog as buildRuntimeTextAssistCatalog,
} from '../src/plugins/text-assist/analysis.ts';
import {
  compileTextAssistResources,
  mergeMissingDefaultRules,
} from '../src/plugins/text-assist/resource-format.ts';
import {
  moveTextAssistCompletionSelection,
  rebaseTextAssistAnalysis,
  stabilizeTextAssistAnalysis,
} from '../src/plugins/editor/text-assist-state.ts';

const DEFAULT_RULES = await readFile(
  new URL('../public/Echo-8-text-assist-rules.txt', import.meta.url),
  'utf8',
);
const DEFAULT_TEXT_ASSIST_LANGUAGE_MODEL = compileTextAssistResources({ rules: DEFAULT_RULES }).model;
const buildTextAssistCatalog: typeof buildRuntimeTextAssistCatalog = (
  summaries,
  languageModel = DEFAULT_TEXT_ASSIST_LANGUAGE_MODEL,
  excludedNodeIds = [],
) => buildRuntimeTextAssistCatalog(summaries, languageModel, excludedNodeIds);

test('completion keyboard selection wraps predictably through all visible candidates', () => {
  assert.equal(moveTextAssistCompletionSelection(0, 2, 1), 1);
  assert.equal(moveTextAssistCompletionSelection(1, 2, 1), 0);
  assert.equal(moveTextAssistCompletionSelection(0, 2, -1), 1);
  assert.equal(moveTextAssistCompletionSelection(3, 0, -1), 0);
});

test('text assistance returns corrections, clickable title references and title completions', () => {
  const catalog = buildTextAssistCatalog([
    summary('node-current', '当前文档', ''),
    summary('node-server', '服务器故障', '记录 502 与内存溢出的处理过程'),
    summary('node-plan', '部署计划', '上线前检查清单'),
  ]);
  const text = '服务器故障因该立刻处理。。\n部署';
  const result = analyzeTextAssistance({
    nodeId: 'node-current',
    revision: 7,
    text,
    windowStart: 100,
    cursor: 100 + text.length,
  }, catalog);

  const reference = result.decorations.find((item) => item.kind === 'node-reference');
  assert.equal(reference?.kind, 'node-reference');
  assert.equal(reference?.title, '服务器故障');
  assert.deepEqual(reference?.targets.map((target) => target.id), ['node-server']);

  const corrections = result.decorations.filter((item) => item.kind === 'correction');
  assert.ok(corrections.some((item) => item.original === '因该' && item.suggestions[0] === '应该'));
  assert.ok(corrections.some((item) => item.original === '。。' && item.suggestions[0] === '。'));
  assert.equal(result.completions[0]?.label, '部署计划');
  assert.equal(result.completions[0]?.replaceStart, 100 + text.length - 2);
});

test('text assistance excludes one-character titles and links to the longest matching title', () => {
  const catalog = buildTextAssistCatalog([
    summary('short', '服务', ''),
    summary('long', '服务器故障', ''),
    summary('single', '服', ''),
  ]);
  const result = analyzeTextAssistance({
    nodeId: 'current',
    revision: 1,
    text: '服务器故障与服',
    windowStart: 0,
    cursor: 7,
  }, catalog);
  const references = result.decorations.filter((item) => item.kind === 'node-reference');
  assert.deepEqual(references.map((item) => item.title), ['服务器故障']);
});

test('typing keeps unaffected title links stable while the next analysis is pending', () => {
  const original = analyzeTextAssistance({
    nodeId: 'current',
    revision: 1,
    text: '服务器故障需要处理',
    windowStart: 100,
    cursor: 108,
  }, buildTextAssistCatalog([
    summary('current', '当前文档', ''),
    summary('server', '服务器故障', ''),
  ]));
  const reference = original.decorations.find((item) => item.kind === 'node-reference')!;
  const rebased = rebaseTextAssistAnalysis(original, {
    start: 8,
    deleteCount: 0,
    insert: '立刻',
  }, 100)!;
  const rebasedReference = rebased.decorations.find((item) => item.kind === 'node-reference')!;
  assert.equal(rebasedReference.start, reference.start);
  assert.equal(rebasedReference.end, reference.end);

  const refreshed = stabilizeTextAssistAnalysis(rebased, { ...rebased, completions: [] });
  assert.equal(refreshed.decorations, rebased.decorations);
});

test('typing inside a title link removes only that stale decoration', () => {
  const original = analyzeTextAssistance({
    nodeId: 'current',
    revision: 1,
    text: '服务器故障与部署计划',
    windowStart: 0,
    cursor: 11,
  }, buildTextAssistCatalog([
    summary('current', '当前文档', ''),
    summary('server', '服务器故障', ''),
    summary('deploy', '部署计划', ''),
  ]));
  const rebased = rebaseTextAssistAnalysis(original, {
    start: 2,
    deleteCount: 0,
    insert: '新',
  }, 0)!;
  assert.deepEqual(
    rebased.decorations.filter((item) => item.kind === 'node-reference').map((item) => item.kind === 'node-reference' && item.title),
    ['部署计划'],
  );
});

test('typing exactly after a completed title keeps the new text outside its link range', () => {
  const title = '服务器故障';
  const original = analyzeTextAssistance({
    nodeId: 'current',
    revision: 1,
    text: title,
    windowStart: 0,
    cursor: title.length,
  }, buildTextAssistCatalog([
    summary('current', '当前文档', ''),
    summary('server', title, ''),
  ]));
  const reference = original.decorations.find((item) => item.kind === 'node-reference')!;
  const rebased = rebaseTextAssistAnalysis(original, {
    start: title.length,
    deleteCount: 0,
    insert: '继续',
  }, 0)!;
  const rebasedReference = rebased.decorations.find((item) => item.kind === 'node-reference')!;

  assert.equal(reference.start, 0);
  assert.equal(reference.end, title.length);
  assert.equal(rebasedReference.start, 0);
  assert.equal(rebasedReference.end, title.length);
});

test('text assistance does not compete with the input method for ordinary vocabulary', () => {
  const result = analyzeTextAssistance({
    nodeId: 'current',
    revision: 1,
    text: '优',
    windowStart: 0,
    cursor: 1,
  }, buildTextAssistCatalog([]));
  assert.deepEqual(result.completions, []);
  assert.equal(result.decorations.length, 0);
});

test('text assistance puts a correction into the shared candidate list before normal completion', () => {
  const result = analyzeTextAssistance({
    nodeId: 'current',
    revision: 1,
    text: '因该',
    windowStart: 20,
    cursor: 22,
  }, buildTextAssistCatalog([]));
  assert.equal(result.completions[0]?.kind, 'correction');
  assert.equal(result.completions[0]?.insertText, '应该');
  assert.equal(result.completions[0]?.replaceStart, 20);
  assert.equal(result.completions[0]?.replaceEnd, 22);
});

test('correction candidates remain available immediately after nearby punctuation', () => {
  const result = analyzeTextAssistance({
    nodeId: 'current',
    revision: 1,
    text: '因该。',
    windowStart: 0,
    cursor: 3,
  }, buildTextAssistCatalog([]));
  assert.equal(result.completions[0]?.kind, 'correction');
  assert.equal(result.completions[0]?.insertText, '应该');
  assert.equal(result.completions[0]?.replaceStart, 0);
  assert.equal(result.completions[0]?.replaceEnd, 2);
});

test('node title completion supports bounded contains and one-edit matching without noisy one-character contains', () => {
  const catalog = buildTextAssistCatalog([
    summary('server', '服务器故障排查', '502 与内存溢出'),
    summary('deploy', '部署计划', '上线清单'),
  ]);
  const contains = analyzeTextAssistance({
    nodeId: 'current', revision: 1, text: '故障', windowStart: 0, cursor: 2,
  }, catalog);
  assert.equal(contains.completions[0]?.label, '服务器故障排查');
  assert.match(contains.completions[0]?.detail ?? '', /包含匹配/u);

  const fuzzy = analyzeTextAssistance({
    nodeId: 'current', revision: 1, text: '服器', windowStart: 0, cursor: 2,
  }, catalog);
  assert.equal(fuzzy.completions[0]?.label, '服务器故障排查');
  assert.match(fuzzy.completions[0]?.detail ?? '', /容错匹配/u);

  const oneCharacterContains = analyzeTextAssistance({
    nodeId: 'current', revision: 1, text: '署', windowStart: 0, cursor: 1,
  }, catalog);
  assert.equal(oneCharacterContains.completions.some((item) => item.label === '部署计划'), false);
});

test('node title completion uses the typed suffix when the caret is between existing text', () => {
  const catalog = buildTextAssistCatalog([
    summary('server', '服务器故障排查', '502 与内存溢出'),
  ]);
  const text = '开头服务结尾';
  const cursor = '开头服务'.length;
  const result = analyzeTextAssistance({
    nodeId: 'current', revision: 1, text, windowStart: 0, cursor,
  }, catalog);
  const candidate = result.completions.find((item) => item.label === '服务器故障排查');

  assert.equal(candidate?.replaceStart, '开头'.length);
  assert.equal(candidate?.replaceEnd, cursor);
  assert.equal(
    `${text.slice(0, candidate?.replaceStart)}${candidate?.insertText}${text.slice(candidate?.replaceEnd)}`,
    '开头服务器故障排查结尾',
  );
});

test('node title completion does not duplicate a complete title before a middle caret', () => {
  const catalog = buildTextAssistCatalog([
    summary('server', '服务器故障排查', '502 与内存溢出'),
  ]);
  const text = '开头服务器故障排查结尾';
  const cursor = '开头服务器故障排查'.length;
  const result = analyzeTextAssistance({
    nodeId: 'current', revision: 1, text, windowStart: 0, cursor,
  }, catalog);

  assert.equal(result.completions.some((item) => item.label === '服务器故障排查'), false);
});

test('correction decoration budget keeps the error nearest the cursor', () => {
  const text = `${'因该'.repeat(400)}在见`;
  const result = analyzeTextAssistance({
    nodeId: 'current',
    revision: 1,
    text,
    windowStart: 0,
    cursor: text.length,
    maxDecorations: 1,
  }, buildTextAssistCatalog([]));
  const correction = result.decorations.find((item) => item.kind === 'correction');
  assert.equal(correction?.kind, 'correction');
  assert.equal(correction?.original, '在见');
  assert.deepEqual(correction?.suggestions, ['再见']);
});

test('text assistance switches correction and completion independently without removing title links', () => {
  const catalog = buildTextAssistCatalog([summary('linked', '部署计划', '上线前检查清单')]);
  const correctionOff = analyzeTextAssistance({
    nodeId: 'current',
    revision: 1,
    text: '部署计划因该',
    windowStart: 0,
    cursor: 6,
  }, catalog, undefined, { correctionEnabled: false, completionEnabled: true });
  assert.equal(correctionOff.decorations.some((item) => item.kind === 'correction'), false);
  assert.equal(correctionOff.decorations.some((item) => item.kind === 'node-reference'), true);

  const completionOff = analyzeTextAssistance({
    nodeId: 'current',
    revision: 1,
    text: '优',
    windowStart: 0,
    cursor: 1,
  }, catalog, undefined, { correctionEnabled: true, completionEnabled: false });
  assert.equal(completionOff.completions.length, 0);

  const correctionWithCompletionOff = analyzeTextAssistance({
    nodeId: 'current',
    revision: 1,
    text: '因该',
    windowStart: 0,
    cursor: 2,
  }, catalog, undefined, { correctionEnabled: true, completionEnabled: false });
  assert.deepEqual(correctionWithCompletionOff.completions.map((item) => item.kind), ['correction']);
});

test('rule resources compile ignored terms, repeated terms and punctuation mappings without a dictionary', () => {
  const compiled = compileTextAssistResources({
    rules: `[忽略词]
Forma-8
[易重复词]
因为
[允许重复]
看看
[标点映射]
, => ，
[检查]
重复虚词=是
中英文标点混用=是`,
  });
  assert.deepEqual(compiled.model.ignoredTerms, ['Forma-8']);
  assert.deepEqual(compiled.model.repeatedTerms, ['因为']);
  assert.deepEqual(compiled.model.allowedRepeats, ['看看']);
  assert.deepEqual(compiled.model.punctuationMappings, [{ original: ',', replacement: '，' }]);
});

test('resource rules support phrase corrections, repeated terms, punctuation and allowed repetitions', () => {
  const model = compileTextAssistResources({
    rules: `[固定纠错]
详尽说明下 => 详细说明一下 | 提示=表达可能不完整
[易重复词]
因为
[允许重复]
看看
[标点映射]
, => ，
[检查]
重复标点=否
标点前空格=否
重复文字=是
重复虚词=是
中英文标点混用=是`,
  }).model;
  const result = analyzeTextAssistance({
    nodeId: 'current',
    revision: 1,
    text: '看看测试测试，因为因为你来,详尽说明下',
    windowStart: 0,
    cursor: 22,
  }, buildTextAssistCatalog([], model));
  const corrections = result.decorations.filter((item) => item.kind === 'correction');
  assert.equal(corrections.some((item) => item.original === '看看'), false);
  assert.ok(corrections.some((item) => item.original === '测试测试' && item.suggestions[0] === '测试'));
  assert.ok(corrections.some((item) => item.original === '因为因为' && item.suggestions[0] === '因为'));
  assert.ok(corrections.some((item) => item.original === ',' && item.suggestions[0] === '，'));
  assert.ok(corrections.some((item) => item.original === '详尽说明下' && item.suggestions[0] === '详细说明一下'));
});

test('title completion stays ahead of literal rule text without executing rule text', () => {
  const model = compileTextAssistResources({
    rules: `[固定纠错]
a+ => 危险 | 提示=按普通文字处理
[补全]
最少前缀=1
[评分]
节点标题=50
前缀=2`,
  }).model;
  const result = analyzeTextAssistance({
    nodeId: 'current',
    revision: 1,
    text: 'aaaa 服务',
    windowStart: 0,
    cursor: 7,
  }, buildTextAssistCatalog([summary('same', '服务方案', '')], model));
  assert.equal(result.decorations.some((item) => item.kind === 'correction'), false);
  assert.equal(result.completions[0]?.kind, 'node-title');
  assert.equal(result.completions.filter((item) => item.label === '服务方案').length, 1);
});

test('the correction rule resource is excluded from title links and self-analysis', () => {
  const catalog = buildTextAssistCatalog([
    summary('resource', '纠错与补全规则', '因该'),
    summary('ordinary', '部署计划', ''),
  ], undefined, ['resource']);
  const resourceResult = analyzeTextAssistance({
    nodeId: 'resource', revision: 1, text: '因该部署计划', windowStart: 0, cursor: 6,
  }, catalog);
  assert.deepEqual(resourceResult.decorations, []);
  assert.deepEqual(resourceResult.completions, []);

  const ordinaryResult = analyzeTextAssistance({
    nodeId: 'ordinary', revision: 1, text: '纠错与补全规则', windowStart: 0, cursor: 8,
  }, catalog);
  assert.equal(ordinaryResult.decorations.some((item) => item.kind === 'node-reference'), false);
});

test('default rules cover common writing, idiom and technical mistakes without flagging allowed repetition', () => {
  assert.ok(DEFAULT_TEXT_ASSIST_LANGUAGE_MODEL.corrections.length >= 270);
  assert.ok(DEFAULT_TEXT_ASSIST_LANGUAGE_MODEL.allowedRepeats.length >= 30);
  assert.ok(DEFAULT_TEXT_ASSIST_LANGUAGE_MODEL.repeatedTerms.length >= 20);
  const text = '做事要按步就班，服务出现内存益出，需要研究研究，但是但是不要部署部署。';
  const result = analyzeTextAssistance({
    nodeId: 'current',
    revision: 1,
    text,
    windowStart: 0,
    cursor: text.length,
  }, buildTextAssistCatalog([]));
  const corrections = result.decorations.filter((item) => item.kind === 'correction');
  assert.ok(corrections.some((item) => item.original === '按步就班' && item.suggestions[0] === '按部就班'));
  assert.ok(corrections.some((item) => item.original === '内存益出' && item.suggestions[0] === '内存溢出'));
  assert.equal(corrections.some((item) => item.original === '研究研究'), false);
  assert.ok(corrections.some((item) => item.original === '但是但是' && item.suggestions[0] === '但是'));
  assert.ok(corrections.some((item) => item.original === '部署部署' && item.suggestions[0] === '部署'));
});

test('pycorrector confusion data is embedded in the rule node and compiled with safe defaults', () => {
  const defaults = DEFAULT_RULES;
  assert.match(defaults, /\[同音候选\]/u);
  assert.match(defaults, /气 = .*器.*\| 异调=/u);
  assert.match(defaults, /\[形近候选\]/u);
  assert.ok(ruleSectionLineCount(defaults, '同音候选', '形近候选') >= 3_500);
  assert.ok(ruleSectionLineCount(defaults, '形近候选', '混淆候选') >= 800);
  assert.equal(DEFAULT_TEXT_ASSIST_LANGUAGE_MODEL.confusion.useSameTone, true);
  assert.equal(DEFAULT_TEXT_ASSIST_LANGUAGE_MODEL.confusion.useDifferentTone, false);
  assert.equal(DEFAULT_TEXT_ASSIST_LANGUAGE_MODEL.confusion.useShape, true);
});

test('same-tone confusion proposes a bounded correction without enabling different-tone guesses', () => {
  const sameTone = analyzeTextAssistance({
    nodeId: 'current', revision: 1, text: '服务气', windowStart: 0, cursor: 3,
  }, buildTextAssistCatalog([]));
  assert.ok(sameTone.decorations.some((item) => item.kind === 'correction' &&
    item.original === '服务气' && item.suggestions[0] === '服务器'));

  const differentTone = analyzeTextAssistance({
    nodeId: 'current', revision: 1, text: '服务奇', windowStart: 0, cursor: 3,
  }, buildTextAssistCatalog([]));
  assert.equal(differentTone.decorations.some((item) => item.kind === 'correction' &&
    item.suggestions[0] === '服务器'), false);
});

test('shape confusion can infer one-character mistakes from a trusted canonical rule', () => {
  const model = compileTextAssistResources({
    rules: `[固定纠错]
匡架 => 框架 | 可信度=0.99
[形近候选]
架 = 驾
[混淆候选]
同音同调=否
同音异调=否
形近=是
最短词长=2
最大词长=8`,
  }).model;
  const result = analyzeTextAssistance({
    nodeId: 'current', revision: 1, text: '框驾', windowStart: 0, cursor: 2,
  }, buildTextAssistCatalog([], model));
  assert.ok(result.decorations.some((item) => item.kind === 'correction' &&
    item.original === '框驾' && item.suggestions[0] === '框架'));
});

test('node titles and ignored terms suppress corrections inside protected names', () => {
  const model = compileTextAssistResources({
    rules: `[固定纠错]
因该 => 应该
[忽略词]
因该工作室`,
  }).model;
  const catalog = buildTextAssistCatalog([
    summary('brand', '按步就班工作室', ''),
  ], model);
  const text = '因该工作室和按步就班工作室，另外因该修改。';
  const result = analyzeTextAssistance({
    nodeId: 'current', revision: 1, text, windowStart: 0, cursor: text.length,
  }, catalog);
  const corrections = result.decorations.filter((item) => item.kind === 'correction');
  assert.deepEqual(corrections.map((item) => item.original), ['因该']);
});

test('default rule upgrade appends only missing data and preserves customized corrections', () => {
  const existing = `版本=1
[固定纠错]
因该 => 应当 | 提示=用户自己的选择
[混淆组]
己,已
[允许重复]
看看
[检查]
重复标点=否`;
  const defaults = DEFAULT_RULES;
  const merged = mergeMissingDefaultRules(existing, defaults);
  assert.ok(merged.added >= 300);
  assert.match(merged.appendText, /按步就班 => 按部就班/u);
  assert.doesNotMatch(merged.appendText, /因该 => 应该/u);
  const compiled = compileTextAssistResources({ rules: existing + merged.appendText });
  assert.equal(compiled.model.corrections.find((rule) => rule.original === '因该')?.replacement, '应当');
  assert.equal(compiled.issues.length, 0);
});

function ruleSectionLineCount(text: string, startName: string, endName: string): number {
  const start = text.indexOf(`[${startName}]`);
  const end = text.indexOf(`[${endName}]`, start + 1);
  return text.slice(start, end < 0 ? undefined : end)
    .split(/\r?\n/u)
    .filter((line) => line.trim() && !line.trim().startsWith('#') && !line.startsWith('['))
    .length;
}

function summary(id: string, title: string, preview: string): ContentSummary {
  return {
    id,
    title,
    preview,
    x: 0,
    y: 0,
    width: 320,
    height: 220,
    titleColor: '#ffffff',
    textColor: '#111111',
    presentation: 'card',
    resizeLimits: { minWidth: 220, maxWidth: 1600, minHeight: 120, maxHeight: 1200 },
    revision: 1,
    length: preview.length,
  };
}
