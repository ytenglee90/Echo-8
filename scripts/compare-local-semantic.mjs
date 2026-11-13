import { chromium } from '@playwright/test';
import { readFile, readdir, stat } from 'node:fs/promises';

const origin = process.env.ECHO8_BENCHMARK_ORIGIN ?? 'http://localhost:3001';
const directory = 'local-data/bge-comparison';
const wasm = (await Promise.all((await readdir(directory)).filter(name => name.endsWith('.wasm')).map(async name =>
  ({ name, size: (await stat(`${directory}/${name}`)).size })))).sort((a, b) => b.size - a.size)[0];
if (!wasm || wasm.size < 5_000_000) throw new Error('Missing complete ONNX WASM in local-data/bge-comparison');
const pairs = [
  ['渡口关闭后怎么从西岸去对面？', '轮渡已经停航。旅客需绕行上游两公里处的公路桥。'],
  ['新来的同事想领电脑，找谁？', '新员工设备由信息技术服务台统一发放，工号生效即可申领。'],
  ['为什么赵姨一入夜就不肯出门？', '暮色降临后，赵姨总把门反锁。她曾在夜市遭遇抢劫，对夜间街道一直心有余悸。'],
  ['错过审核日期了还有什么补救措施？', '超过材料复核期限的，可在三个工作日内提交书面申诉，由受理窗口重新登记。'],
  ['什么办法防止文档误删就找不回？', '启用每日快照和版本历史，保留至少三十天的文件恢复点。'],
  ['什么东西让破裂的陶罐暂时不漏？', '将蜂蜡融化后填入陶器细缝，冷却凝固可阻止水从裂纹渗出。'],
  ['谁最适合带调查小组查旧城的建筑？', '林砚曾任市规划院制图员，熟悉老城区改建前的街区和历史地籍。'],
  ['作者准备什么时候让读者知道真正的凶手？', '故事直到终章的指纹鉴定才揭示行凶者身份，前面的嫌疑名单用于铺设误导线索。'],
  ['网站拥挤时应该如何保持响应？', '高峰期为热门请求启用边缘缓存，将耗时任务投入异步队列并按请求量扩缩容。'],
  ['为什么预算实际花的比预计多？', '成本超支主要来自运输价格上涨和工期延误带来的临时人工费。'],
  ['先让哪片庄稼喝水？', '水量受限时优先灌溉正值抽穗扬花期的稻田，其余地块错峰供水。'],
  ['哪里可以放久一点的药？', '药物按包装说明避光保存。需冷藏的药物放在温度稳定的冰箱中层。'],
];
const distractors = [
  '西岸的新桥夜景适合在步道上拍照，拍摄比赛周六开始。', '人事部安排新同事参加部门介绍和消防演习。',
  '赵姨每天中午在老街卖陶器，顾客可以到夜市预订。', '旅游申请的审核日期与入境停留期限各自独立。',
  '编辑文档时打开历史摘要面板，显示过去两周的协作讨论。', '陶罐置于博物馆恒温库房，修复展览安排在夏季。',
  '旧城咖啡店计划扩大座位，负责人希望附近建筑增加照明。', '嫌疑人供认曾在案发地经过，目击记录尚待核实。',
  '网站首页展示流量统计，可按日期查看访问来源。', '预算审查会议讨论下一季度的会场预订和宣传物料。',
  '村里的农田艺术节在稻谷收割后举办。', '药品外包装上的中文标签需要印出清晰的有效日期。',
];
const browser = await chromium.launch({ args: ['--disable-extensions'] });
try {
  for (const modelId of ['small', 'base']) {
    const page = await browser.newPage();
    await page.route('**/raw-ort/**', async route => route.fulfill({
      body: await readRuntimeAsset(route.request().url()),
      contentType: 'application/octet-stream',
    }));
    await page.goto(`${origin}/@vite/client`, { waitUntil: 'commit' });
    const cdp = await page.context().newCDPSession(page);
    const before = await cdp.send('Runtime.getHeapUsage');
    const result = await page.evaluate(async ({ modelId, pairs, distractors, directory, wasmName }) => {
      const jobs = await import('/src/plugins/local-semantic-provider/worker-jobs.ts');
      const fetchAsset = async name => {
        const response = await fetch(`/${directory}/${name}`);
        if (!response.ok) throw new Error(`Missing ${name}`);
        return response;
      };
      const [model, tokenizer, tokenizerConfig, runtimeModule, runtimeBackend, runtimeWasm] = await Promise.all([
        fetchAsset(`${modelId}-model_quantized.onnx`).then(r => r.arrayBuffer()),
        fetchAsset(`${modelId}-tokenizer.json`).then(r => r.text()),
        fetchAsset(`${modelId}-tokenizer_config.json`).then(r => r.text()),
        fetch('/raw-ort/ort.wasm.min.mjs').then(r => r.text()),
        fetch('/raw-ort/ort-wasm-simd-threaded.mjs').then(r => r.text()),
        fetchAsset(wasmName).then(r => r.arrayBuffer()),
      ]);
      const bytes = model.byteLength + tokenizer.length + tokenizerConfig.length + runtimeModule.length + runtimeBackend.length + runtimeWasm.byteLength;
      const loadStart = performance.now();
      await jobs.loadLocalSemanticModel({ modelId, model, tokenizer, tokenizerConfig, runtimeModule, runtimeBackend, runtimeWasm });
      const loadMs = performance.now() - loadStart;
      const embed = async texts => (await jobs.embedLocalSemanticTexts({ texts })).vectors;
      const documents = pairs.map(pair => pair[1]).concat(distractors);
      const indexStart = performance.now();
      const vectors = [];
      for (let offset = 0; offset < documents.length; offset += 8) vectors.push(...await embed(documents.slice(offset, offset + 8)));
      const indexMs = performance.now() - indexStart;
      const durations = [];
      const ranks = [];
      for (const [index, pair] of pairs.entries()) {
        const start = performance.now();
        const [vector] = await embed([pair[0]]);
        durations.push(performance.now() - start);
        const ordered = vectors.map((doc, id) => ({ id, score: doc.reduce((sum, value, dimension) => sum + value * vector[dimension], 0) }))
          .sort((a, b) => b.score - a.score);
        ranks.push(1 + ordered.findIndex(item => item.id === index));
      }
      return { modelId, bytes, dimensions: vectors[0].length, loadMs: Math.round(loadMs), indexMs: Math.round(indexMs),
        queryMedianMs: Math.round(durations.sort((a, b) => a - b)[Math.floor(durations.length / 2)]),
        hitsAt1: ranks.filter(rank => rank === 1).length, hitsAt5: ranks.filter(rank => rank <= 5).length, ranks };
    }, { modelId, pairs, distractors, directory, wasmName: wasm.name });
    const after = await cdp.send('Runtime.getHeapUsage');
    console.log(JSON.stringify({ ...result, backingStorageDeltaBytes: after.backingStorageSize - before.backingStorageSize }));
    await page.close();
  }
} finally {
  await browser.close();
}

async function readRuntimeAsset(url) {
  return readFile(`${directory}/${new URL(url).pathname.split('/').at(-1)}`);
}
