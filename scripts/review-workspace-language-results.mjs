import { readFile } from 'node:fs/promises';
import LanguageReporter from '../language-e2e/reporter.ts';
import { languageCases } from '../language-e2e/corpus.ts';
import { LANGUAGE_FIXTURE_RECORDS } from '../language-e2e/fixture.ts';
import { judge } from '../language-e2e/oracles.ts';
import { records, body } from '../language-e2e/harness.ts';
import { isRecord } from '../src/core/contracts.ts';

const source = process.argv[2] ?? 'local-data/workspace-language/first-full-report.json';
const retry = process.argv[3] ?? 'local-data/workspace-language/latest-report.json';
const baseline = JSON.parse(await readFile(source, 'utf8'));
const recheck = JSON.parse(await readFile(retry, 'utf8'));
const key = entry => entry.id + ':' + entry.variant;
const observations = new Map(baseline.observations.map(entry => [key(entry), entry]));
for (const entry of recheck.observations) observations.set(key(entry), entry);

// Reconstruct only unchanged public fixture records from real exports. No expected action is executed here.
const fixtures = new Map();
for (const entry of observations.values()) {
  if (!entry.document) continue;
  const nodes = records(entry.document, 'textNode');
  const unchanged = LANGUAGE_FIXTURE_RECORDS.map(([title, text], index) => nodes.find(node => node.title === title &&
    node.x === 80 + index % 3 * 360 && node.y === 60 + Math.floor(index / 3) * 250 && body(entry.document, node) === text));
  if (unchanged.some(node => !node)) continue;
  const ids = Object.fromEntries(LANGUAGE_FIXTURE_RECORDS.map(([title], index) => [title, unchanged[index].id]));
  const chapter = ids['第一章'];
  if (fixtures.has(chapter)) continue;
  const all = Object.values(entry.document).flatMap(values => Object.values(values).filter(isRecord));
  const edge = all.find(value => isRecord(value.from) && isRecord(value.to) && value.from.nodeId === ids['主角'] && value.to.nodeId === ids['反派']);
  const annotation = all.find(value => value.body === '需核对' && isRecord(value.target) && value.target.targetId === chapter);
  fixtures.set(chapter, { bytes: Buffer.alloc(0), ids, edgeId: edge?.id ?? '', annotationId: annotation?.id ?? '',
    source: { document: { revision: 0, namespaces: entry.document }, plugins: [] } });
}

const reporter = new LanguageReporter();
for (const entry of observations.values()) {
  entry.sent ??= Boolean(entry.before && entry.after);
  const item = languageCases.find(item => item.id === entry.id);
  const fixture = [...fixtures.values()].find(fixture => entry.document?.textNode?.[fixture.ids['第一章']]);
  if (item && fixture && item.setup !== 'junction') {
    const original = entry.verdict;
    judge(item, entry, fixture);
    if (original !== entry.verdict) entry.initialVerdict = original;
  }
  reporter.observations.push(entry);
}
const retriedKeys = new Set(recheck.observations.map(key));
reporter.infrastructureFailures = (baseline.infrastructureFailures ?? []).filter(failure => ![...retriedKeys].some(id => {
  const [action, variant] = id.split(/:(?=\d+$)/u); return failure.test.startsWith(action + ' #' + variant + ' ');
}));
reporter.infrastructureFailures.push(...(recheck.infrastructureFailures ?? []));
reporter.collectionNotes = [
  '合并首次完整语料采集与前置界面修复后的复查；每个动作、每种原句仅保留最新的真实输入结果。',
  '根据真实导出的未变公开夹具重新计算结果断言，未重写原始回复、视口、文档或文件证据；初始判定变化保存在initialVerdict。',
  '动作未进入本地解析而显示“AI模型连接尚未配置”时，机械操作计为unrecognized-or-misrouted；不会因此宣称需要云端。',
];
const outcome = await reporter.onEnd({ status: reporter.infrastructureFailures.length ? 'failed' : 'passed', startTime: new Date(), duration: 0 });
if (outcome.status !== 'passed') process.exitCode = 1;
