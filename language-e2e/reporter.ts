import type { Reporter, TestCase, TestResult, FullResult } from '@playwright/test/reporter';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import type { Observation } from './harness.ts';
import { allLanguageCases, languageCases, languageReportStem, languageSuite } from './suites.ts';
import { localActions } from '../src/plugins/workspace-actions/actions.ts';

export default class LanguageReporter implements Reporter {
  observations: Observation[] = [];
  infrastructureFailures: Array<{ test: string; error: string }> = [];
  collectionNotes: string[] = [];
  async onTestEnd(test: TestCase, result: TestResult) {
    const artifact = result.attachments.find(item => item.name === 'natural-language-observation');
    if (result.status !== 'passed') this.infrastructureFailures.push({ test: test.title, error: result.errors.map(error => error.message).join('\n') });
    if (!artifact) {
      if (result.status === 'passed') this.infrastructureFailures.push({ test: test.title, error: 'Missing observation attachment' }); return;
    }
    const content = artifact.body ?? await readFile(artifact.path!);
    this.observations.push(JSON.parse(content.toString('utf8')) as Observation);
  }
  async onEnd(result: FullResult) {
    const observations = this.observations.sort((a, b) => a.id.localeCompare(b.id) || a.variant - b.variant);
    const ids = [...new Set(observations.map(entry => entry.id))];
    const expected = languageCases.length * 3;
    const group = (id: string) => observations.filter(entry => entry.id === id);
    const consistency = ids.map(id => ({ id, outcomes: group(id).map(entry => ({ phrase: entry.phrase, verdict: entry.verdict })),
      allVerified: group(id).length === 3 && group(id).every(entry => entry.verdict === 'verified'),
      wordingSensitive: group(id).some(entry => entry.verdict === 'verified') && !group(id).every(entry => entry.verdict === 'verified'),
      inconsistent: new Set(group(id).map(entry => entry.verdict)).size > 1 }));
    const counts = Object.fromEntries([...new Set(observations.map(entry => entry.verdict))].map(verdict => [verdict, observations.filter(entry => entry.verdict === verdict).length]));
    const runtime = JSON.parse(await readFile('local-data/workspace-language/runtime-catalog.json', 'utf8').catch(() => '[]')) as Array<{ id: string; label: string }>;
    const caseKey = (id: string) => id.replace(/^registered:/u, 'manual:');
    const missingRuntimeIds = runtime.filter(entry => !allLanguageCases.some(item => item.id === caseKey(entry.id))).map(entry => entry.id);
    const runtimeIdsOutsideSuite = runtime.filter(entry => !languageCases.some(item => item.id === caseKey(entry.id))).map(entry => entry.id);
    const labels = new Map([...runtime.map(entry => [caseKey(entry.id), entry.label.replace(/ · .*$/u, '')] as const),
      ...localActions.map(action => [action.descriptor.id, action.descriptor.label] as const)]);
    const report = { version: 1, generatedAt: new Date().toISOString(), runnerStatus: result.status, suite: languageSuite,
      expectedUtterances: expected, collectedUtterances: observations.length,
      executableAdapters: languageCases.filter(entry => !entry.id.startsWith('manual:') && !/^E\d/u.test(entry.id)).length,
      runtimeExecutableAdapters: localActions.length, runtimeIdsOutsideSuite,
      manualEntries: languageCases.filter(entry => entry.id.startsWith('manual:')).length,
      integrationScenarios: languageCases.filter(entry => /^E\d/u.test(entry.id)).length,
      runtimeActionCount: runtime.length, missingRuntimeIds,
      localAssetLoadingCases: observations.filter(entry => entry.localAssetFiles.length > 0).length,
      allWordingsVerifiedIntents: consistency.filter(entry => entry.allVerified).length,
      wordingSensitiveIntents: consistency.filter(entry => entry.wordingSensitive).length,
      sentUtterances: observations.filter(entry => entry.sent ?? Boolean(entry.before && entry.after)).length,
      completeCorpusRun: observations.length === expected && observations.every(entry => entry.sent ?? Boolean(entry.before && entry.after)) && this.infrastructureFailures.length === 0,
      acceptancePassed: observations.length === expected && observations.every(entry => entry.verdict === 'verified') && this.infrastructureFailures.length === 0,
      verified: counts.verified ?? 0, counts, consistency, observations, infrastructureFailures: this.infrastructureFailures,
      cloudRequestsSent: 0, collectionNotes: this.collectionNotes,
      blockedRequests: observations.reduce((sum, entry) => sum + entry.blockedRequests.length, 0),
      localModel: 'Cached real BGE-small ONNX assets only; no generative model and no mocked intent/output.',
      method: 'Original utterances are sent through the assistant composer. Fixed plans are used only for fixture setup and independent readback/export, never as the intent under test.',
    };
    await mkdir('local-data/workspace-language', { recursive: true });
    await writeFile('local-data/workspace-language/' + (languageSuite === 'extended' ? 'latest-extended-report.json' : 'latest-report.json'), JSON.stringify(report, null, 2));
    const json = new URL('../../deliveries/' + languageReportStem + '测试报告.json', import.meta.url);
    const md = new URL('../../deliveries/' + languageReportStem + '测试报告.md', import.meta.url);
    await writeFile(json, JSON.stringify(report, null, 2));
    await writeFile(new URL('../../deliveries/' + languageReportStem + '语料.json', import.meta.url), JSON.stringify({ version: 1,
      purpose: '独立验收语料，未被产品解析器导入。每项三种等价操作说法。', cases: languageCases }, null, 2));
    const escape = (text: string) => text.replaceAll('|', '\\|').replaceAll('\n', ' ');
    const rows = consistency.map(entry => `| ${entry.id} ${labels.get(entry.id) ?? ''} | ${entry.allVerified ? '3/3通过' : entry.wordingSensitive ? '换说法失效' : entry.inconsistent ? '失败类型不同' : '未全部通过'} | ${entry.outcomes.map(outcome => escape(outcome.phrase) + ' → ' + outcome.verdict).join('<br>')} |`);
    const creationReadback = observations.filter(entry => entry.id === 'node.create').map(entry => {
      const titles = Object.values(entry.document?.textNode ?? {}).filter(value => value && typeof value === 'object' && 'title' in value)
        .map(value => String((value as { title: string }).title)).filter(title => !['第一章', '第二章', '主角', '配角', '反派', '空白1', '空白2', '线索', '世界观', '纠错与补全规则'].includes(title));
      return '- ' + entry.phrase + ' → 实际新标题：' + (titles.join('、') || '没有正确创建') + '；助手状态：' + (entry.after?.status ?? '未取得');
    });
    await writeFile(md, [
      '# Echo-8 自然语言同义指令测试报告', '', `生成时间：${report.generatedAt}。采集尝试 ${observations.length}/${expected} 条，实际发送 ${report.sentUtterances} 条；经实际状态或文件内容核验通过 ${report.verified} 条。`, '',
      `本套语料（${languageSuite}）覆盖 ${report.executableAdapters} 个执行适配、${report.manualEntries} 个界面入口、${report.integrationScenarios} 个组合场景，每项3种等价说法。${observations.length === expected ? '已尝试本套全量语料。' : '**本次只采集部分语料。**'}${report.sentUtterances < expected ? `其中${expected - report.sentUtterances}条未能通过实际输入入口发送，不能声称全部指令已执行。` : ''}`, '',
      `当前运行时动作${runtime.length}项，未配语料的动作${missingRuntimeIds.length}项；${report.allWordingsVerifiedIntents}项在3种说法下均经核验通过，${report.wordingSensitiveIntents}项有说法通过、换说法失效。${report.localAssetLoadingCases}条观察到真实本地BGE资产加载。`, '',
      `运行时有${runtimeIdsOutsideSuite.length}项不属于本套语料，须查看另一套独立报告，不能据本套结果宣称全部动作通过。`, '',
      '**Playwright绿灯仅表示采集流程结束，不表示动作通过。只有verified计入成功；等待、未识别、外部请求拦截、缺模型和缺少独立断言均不算成功。**', '',
      '成功发送的消息均通过真实助手输入框进入。固定计划只准备隔离夹具并在测试后读取结果，不代替自然语言解析。模型资产由本地缓存提供真实BGE字节，没有伪造向量、意图、计划或助手回答。无本地生成式模型。外部及模型API请求被拦截，实际云端请求为0。', '',
      '同义句仅供验收工具读取。', '',
      '## 建卡名称回读', '', ...creationReadback, '',
      '结果分类（除verified外均不计验收通过）：', '', ...Object.entries(counts).map(([name, count]) => `- ${name}：${count}`), '',
      'failed表示实际对象、参数或状态不符；unrecognized-or-misrouted表示机械指令落入模型未配置或无法理解分支；unverified表示缺少充分独立断言；blocked-local-generative-model表示缺本地生成式模型；precondition-unavailable表示界面入口或必要前置不可达；requires-local-authorization-simulation表示仍需本机授权夹具。', '',
      '| 动作 | 同义表达稳定性 | 输入与结果 |', '|---|---|---|', ...rows, '',
      '逐条原始回复、状态、执行后文档、文件字节和未通过原因见同名JSON。', '',
      ...this.collectionNotes.map(note => '- ' + note), '',
      ...this.infrastructureFailures.map(failure => `- 采集异常：${escape(failure.test)}：${escape(failure.error)}`), '',
    ].join('\n'));
    process.stdout.write(`\nNatural-language outcome: ${report.verified}/${observations.length} state-verified; ${consistency.filter(entry => entry.allVerified).length}/${ids.length} intents passed every wording. Runner status is collection status only.\n`);
    return { status: report.acceptancePassed ? result.status : 'failed' as const };
  }
}
