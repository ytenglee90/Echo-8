import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const vendorRoot = resolve(projectRoot, 'src/plugins/text-assist/vendor/pycorrector');
const coreRulesPath = resolve(projectRoot, 'src/plugins/text-assist/rules-core.txt');
const outputPath = resolve(projectRoot, 'public/Echo-8-text-assist-rules.txt');

const sources = {
  pinyin: {
    file: 'same_pinyin.txt',
    sha256: '39f9a93a68386ce63d23b97cdecf74ab4c381721b8bee68c854d64a2b5f21db0',
  },
  stroke: {
    file: 'same_stroke.txt',
    sha256: 'c9e31dac045484b16f7f0704af1bd93d2cf841023e2e3a18a1181b413ec62d43',
  },
};

const [pinyinText, strokeText] = await Promise.all([
  readVerified(sources.pinyin),
  readVerified(sources.stroke),
]);
const coreRules = (await readFile(coreRulesPath, 'utf8')).replace(/^\uFEFF/u, '').trimEnd();

const pinyinLines = pinyinText.split(/\r?\n/u)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'))
  .map((line, index) => {
    const [character = '', sameTone = '', differentTone = ''] = line.split('\t');
    assertSingleHan(character, `same_pinyin.txt:${index + 2}`);
    return `${character} = ${uniqueHan(sameTone, character)} | 异调=${uniqueHan(differentTone, character)}`;
  });

const strokeLines = strokeText.split(/\r?\n/u)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line, index) => {
    const [character = '', ...candidates] = line.split(/\s+/u);
    assertSingleHan(character, `same_stroke.txt:${index + 1}`);
    return `${character} = ${uniqueHan(candidates.join(''), character)}`;
  });

const ruleSections = `# 以下候选数据来自 pycorrector，Apache-2.0；只生成建议，不会自动替换正文。
# 同音数据保留“同音同调”和“同音异调”边界；默认关闭异调候选以减少误报。
[同音候选]
${pinyinLines.join('\n')}

[形近候选]
${strokeLines.join('\n')}

[混淆候选]
同音同调=是
同音异调=否
形近=是
最短词长=2
最大词长=12`;

const generated = `${coreRules}\n\n${ruleSections}\n`;

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, generated, 'utf8');

async function readVerified(source) {
  const path = resolve(vendorRoot, source.file);
  const content = await readFile(path);
  const actual = createHash('sha256').update(content).digest('hex');
  if (actual !== source.sha256) {
    throw new Error(`${source.file} SHA-256 mismatch: expected ${source.sha256}, received ${actual}`);
  }
  return content.toString('utf8').replace(/^\uFEFF/u, '');
}

function assertSingleHan(value, location) {
  if (!/^\p{Script=Han}$/u.test(value)) {
    throw new Error(`${location} must start with one Han character`);
  }
}

function uniqueHan(value, excluded) {
  const seen = new Set();
  for (const character of value) {
    if (character !== excluded && /^\p{Script=Han}$/u.test(character)) seen.add(character);
  }
  return [...seen].join('');
}
