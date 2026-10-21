import type {
  TextAssistCorrectionRule,
  TextAssistLanguageModel,
  TextAssistResourceIssue,
  TextAssistResourceRole,
} from '../../protocols/text-assist.ts';

export interface TextAssistResourceTexts {
  rules: string;
}

export interface TextAssistCompileResult {
  model: TextAssistLanguageModel;
  issues: TextAssistResourceIssue[];
}

export interface TextAssistRuleMergeResult {
  appendText: string;
  added: number;
}

const MAX_RESOURCE_LENGTH = 16 * 1024 * 1024;
const MAX_RESOURCE_LINES = 200_000;
const MAX_TERM_LENGTH = 160;
const MAX_CORRECTION_LENGTH = 512;
const MERGEABLE_SECTIONS = [
  '固定纠错',
  '忽略词',
  '易重复词',
  '允许重复',
  '标点映射',
  '同音候选',
  '形近候选',
  '混淆候选',
  '检查',
  '补全',
  '评分',
] as const;

export const DEFAULT_TEXT_ASSIST_SCORING: TextAssistLanguageModel['scoring'] = {
  nodeTitle: 35,
  prefix: 2,
  contains: -8,
  fuzzy: -12,
};

export function compileTextAssistResources(resources: TextAssistResourceTexts): TextAssistCompileResult {
  const issues: TextAssistResourceIssue[] = [];
  const rules = parseRules(resources.rules, issues);
  return {
    model: {
      schemaVersion: 3,
      corrections: rules.corrections,
      ignoredTerms: [...rules.ignoredTerms].sort(longestFirst),
      allowedRepeats: [...rules.allowedRepeats].sort(longestFirst),
      repeatedTerms: [...rules.repeatedTerms].sort(longestFirst),
      punctuationMappings: rules.punctuationMappings,
      checks: rules.checks,
      completion: rules.completion,
      scoring: rules.scoring,
      confusion: {
        ...rules.confusion,
        pinyin: [...rules.pinyinConfusions.values()].sort((left, right) =>
          left.character.localeCompare(right.character, 'zh-CN')),
        shape: [...rules.shapeConfusions.values()].sort((left, right) =>
          left.character.localeCompare(right.character, 'zh-CN')),
      },
    },
    issues,
  };
}

export function mergeMissingDefaultRules(existing: string, defaults: string): TextAssistRuleMergeResult {
  if (!existing.trim()) {
    return { appendText: defaults, added: countMergeableRuleLines(defaults) };
  }
  const known = collectMergeableRuleKeys(existing);
  const additions = new Map<string, string[]>();
  let section = '';
  for (const rawLine of defaults.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const sectionMatch = line.match(/^\[(.+)\]$/u);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }
    const key = mergeableRuleKey(section, line);
    if (!key || known.has(key)) continue;
    known.add(key);
    const lines = additions.get(section) ?? [];
    lines.push(line);
    additions.set(section, lines);
  }
  const added = [...additions.values()].reduce((count, lines) => count + lines.length, 0);
  if (added === 0) return { appendText: '', added: 0 };
  const blocks = ['# Echo-8 补充的内置纠错规则；原有自定义内容保持不变。'];
  let addedPycorrectorNotice = false;
  for (const name of MERGEABLE_SECTIONS) {
    const lines = additions.get(name);
    if (!lines?.length) continue;
    if (!addedPycorrectorNotice && (name === '同音候选' || name === '形近候选')) {
      blocks.push(
        '',
        '# 以下候选数据来自 pycorrector，Apache-2.0；只生成建议，不会自动替换正文。',
        '# 同音数据保留同调与异调边界；默认关闭异调候选以减少误报。',
      );
      addedPycorrectorNotice = true;
    }
    blocks.push('', `[${name}]`, ...lines);
  }
  return { appendText: `${existing.endsWith('\n') ? '\n' : '\n\n'}${blocks.join('\n')}\n`, added };
}

function countMergeableRuleLines(text: string): number {
  return collectMergeableRuleKeys(text).size;
}

function collectMergeableRuleKeys(text: string): Set<string> {
  const keys = new Set<string>();
  let section = '';
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const sectionMatch = line.match(/^\[(.+)\]$/u);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }
    const key = mergeableRuleKey(section, line);
    if (key) keys.add(key);
  }
  return keys;
}

function mergeableRuleKey(section: string, line: string): string | undefined {
  if (!line || line.startsWith('#')) return undefined;
  if (section === '固定纠错' || section === '标点映射') {
    const arrow = line.indexOf('=>');
    if (arrow < 1) return undefined;
    return `${section}:${normalizeText(line.slice(0, arrow).trim())}`;
  }
  if (section === '同音候选' || section === '形近候选') {
    const [key] = splitAssignment(line);
    return validSingleHan(key) ? `${section}:${key}` : undefined;
  }
  if (['忽略词', '易重复词', '允许重复'].includes(section)) {
    return `${section}:${normalizeText(line)}`;
  }
  if (['混淆候选', '检查', '补全', '评分'].includes(section)) {
    const [key] = splitAssignment(line);
    return key ? `${section}:${key}` : undefined;
  }
  return undefined;
}

function parseRules(text: string, issues: TextAssistResourceIssue[]) {
  const corrections = new Map<string, TextAssistCorrectionRule>();
  const ignoredTerms = new Set<string>();
  const allowedRepeats = new Set<string>();
  const repeatedTerms = new Set<string>();
  const punctuationMappings = new Map<string, string>();
  const pinyinConfusions = new Map<string, { character: string; sameTone: string; differentTone: string }>();
  const shapeConfusions = new Map<string, { character: string; candidates: string }>();
  const checks: TextAssistLanguageModel['checks'] = {
    repeatedPunctuation: true,
    spaceBeforeChinesePunctuation: true,
    repeatedText: true,
    repeatedTerms: true,
    consecutiveSpaces: true,
    mixedChinesePunctuation: true,
    conflictingPunctuation: true,
  };
  const completion: TextAssistLanguageModel['completion'] = {
    minimumPrefix: 1,
    useContains: true,
    useFuzzy: true,
    minimumFuzzyPrefix: 2,
  };
  const scoring = { ...DEFAULT_TEXT_ASSIST_SCORING };
  const confusion = {
    useSameTone: true,
    useDifferentTone: false,
    useShape: true,
    minimumTermLength: 2,
    maximumTermLength: 12,
  };
  let section = '';
  forEachResourceLine(text, 'rules', issues, (raw, lineNumber) => {
    const sectionMatch = raw.match(/^\[(.+)\]$/u);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      return;
    }
    if (!section && raw.startsWith('版本=')) {
      if (!['版本=1', '版本=2', '版本=3'].includes(raw)) {
        issues.push({ role: 'rules', line: lineNumber, message: '仅支持规则版本 1、2 或 3' });
      }
      return;
    }
    if (section === '固定纠错') {
      parseCorrection(raw, lineNumber, corrections, issues);
      return;
    }
    if (section === '忽略词') {
      parseTerm(raw, lineNumber, ignoredTerms, issues, '忽略词');
      return;
    }
    if (section === '易重复词') {
      parseTerm(raw, lineNumber, repeatedTerms, issues, '易重复词');
      return;
    }
    if (section === '允许重复') {
      parseTerm(raw, lineNumber, allowedRepeats, issues, '允许重复词');
      return;
    }
    if (section === '标点映射') {
      const arrow = raw.indexOf('=>');
      const original = arrow < 0 ? '' : raw.slice(0, arrow).trim();
      const replacement = arrow < 0 ? '' : raw.slice(arrow + 2).trim();
      if ([...original].length !== 1 || [...replacement].length !== 1 ||
        !isPunctuation(original) || !isPunctuation(replacement)) {
        issues.push({ role: 'rules', line: lineNumber, message: '标点映射必须写成“单个标点 => 单个标点”' });
      } else punctuationMappings.set(original, replacement);
      return;
    }
    if (section === '同音候选') {
      parsePinyinConfusion(raw, lineNumber, pinyinConfusions, issues);
      return;
    }
    if (section === '形近候选') {
      parseShapeConfusion(raw, lineNumber, shapeConfusions, issues);
      return;
    }
    if (section === '混淆候选') {
      const [key, value] = splitAssignment(raw);
      if (key === '同音同调') {
        confusion.useSameTone = parseBoolean(value, confusion.useSameTone, 'rules', lineNumber, issues);
      } else if (key === '同音异调') {
        confusion.useDifferentTone = parseBoolean(value, confusion.useDifferentTone, 'rules', lineNumber, issues);
      } else if (key === '形近') {
        confusion.useShape = parseBoolean(value, confusion.useShape, 'rules', lineNumber, issues);
      } else if (key === '最短词长') {
        confusion.minimumTermLength = clampInteger(Number(value), 2, 8, 2);
      } else if (key === '最大词长') {
        confusion.maximumTermLength = clampInteger(Number(value), 2, 24, 12);
      } else {
        issues.push({ role: 'rules', line: lineNumber, message: `不支持混淆候选项“${key}”` });
      }
      return;
    }
    if (section === '混淆组') return;
    if (section === '检查') {
      const [key, value] = splitAssignment(raw);
      const checkKey = ({
        重复标点: 'repeatedPunctuation',
        标点前空格: 'spaceBeforeChinesePunctuation',
        重复文字: 'repeatedText',
        重复虚词: 'repeatedTerms',
        连续空格: 'consecutiveSpaces',
        中英文标点混用: 'mixedChinesePunctuation',
        冲突标点: 'conflictingPunctuation',
      } as Record<string, keyof TextAssistLanguageModel['checks']>)[key];
      if (checkKey) checks[checkKey] = parseBoolean(value, checks[checkKey], 'rules', lineNumber, issues);
      else issues.push({ role: 'rules', line: lineNumber, message: `不支持检查项“${key}”` });
      return;
    }
    if (section === '补全') {
      const [key, value] = splitAssignment(raw);
      if (key === '最少前缀') completion.minimumPrefix = clampInteger(Number(value), 1, 8, 1);
      else if (key === '包含匹配') {
        completion.useContains = parseBoolean(value, completion.useContains, 'rules', lineNumber, issues);
      } else if (key === '容错匹配') {
        completion.useFuzzy = parseBoolean(value, completion.useFuzzy, 'rules', lineNumber, issues);
      } else if (key === '容错最少前缀') {
        completion.minimumFuzzyPrefix = clampInteger(Number(value), 2, 8, 2);
      } else issues.push({ role: 'rules', line: lineNumber, message: `不支持补全项“${key}”` });
      return;
    }
    if (section === '评分') {
      const [key, value] = splitAssignment(raw);
      const parsed = Number(value);
      const target = ({
        节点标题: 'nodeTitle',
        前缀: 'prefix',
        包含: 'contains',
        容错: 'fuzzy',
      } as const)[key as '节点标题' | '前缀' | '包含' | '容错'];
      if (target && Number.isFinite(parsed)) scoring[target] = clamp(parsed, -100, 100);
      else if (!['画布词库', '个人词库', '通用词库', '词频'].includes(key)) {
        issues.push({ role: 'rules', line: lineNumber, message: `评分项“${key}”无效` });
      }
      return;
    }
    issues.push({ role: 'rules', line: lineNumber, message: section ? `不支持规则段“${section}”` : '规则必须写在已知段落中' });
  });
  return {
    corrections: [...corrections.values()],
    ignoredTerms,
    allowedRepeats,
    repeatedTerms,
    punctuationMappings: [...punctuationMappings].map(([original, replacement]) => ({ original, replacement })),
    checks,
    completion,
    scoring,
    pinyinConfusions,
    shapeConfusions,
    confusion: {
      ...confusion,
      maximumTermLength: Math.max(confusion.minimumTermLength, confusion.maximumTermLength),
    },
  };
}

function parsePinyinConfusion(
  raw: string,
  lineNumber: number,
  target: Map<string, { character: string; sameTone: string; differentTone: string }>,
  issues: TextAssistResourceIssue[],
): void {
  const columns = raw.split('|').map((part) => part.trim());
  const [character, sameToneText] = splitAssignment(columns.shift() ?? '');
  if (!validSingleHan(character)) {
    issues.push({ role: 'rules', line: lineNumber, message: '同音候选必须以单个汉字开头' });
    return;
  }
  let differentToneText = '';
  for (const property of columns) {
    const [key, value] = splitAssignment(property);
    if (key === '异调') differentToneText = value;
    else issues.push({ role: 'rules', line: lineNumber, message: `不支持同音候选属性“${key}”` });
  }
  const sameTone = uniqueHanCharacters(sameToneText, character);
  const differentTone = uniqueHanCharacters(differentToneText, character);
  const existing = target.get(character);
  target.set(character, {
    character,
    sameTone: uniqueHanCharacters(`${existing?.sameTone ?? ''}${sameTone}`, character),
    differentTone: uniqueHanCharacters(`${existing?.differentTone ?? ''}${differentTone}`, character),
  });
}

function parseShapeConfusion(
  raw: string,
  lineNumber: number,
  target: Map<string, { character: string; candidates: string }>,
  issues: TextAssistResourceIssue[],
): void {
  const [character, candidateText] = splitAssignment(raw);
  if (!validSingleHan(character)) {
    issues.push({ role: 'rules', line: lineNumber, message: '形近候选必须以单个汉字开头' });
    return;
  }
  const candidates = uniqueHanCharacters(candidateText, character);
  const existing = target.get(character);
  target.set(character, {
    character,
    candidates: uniqueHanCharacters(`${existing?.candidates ?? ''}${candidates}`, character),
  });
}

function parseCorrection(
  raw: string,
  lineNumber: number,
  corrections: Map<string, TextAssistCorrectionRule>,
  issues: TextAssistResourceIssue[],
): void {
  const columns = raw.split('|').map((part) => part.trim());
  const mapping = columns.shift() ?? '';
  const arrow = mapping.indexOf('=>');
  if (arrow < 1) {
    issues.push({ role: 'rules', line: lineNumber, message: '固定纠错必须写成“错误 => 正确”' });
    return;
  }
  const original = mapping.slice(0, arrow).trim();
  const replacement = mapping.slice(arrow + 2).trim();
  if (!validCorrectionText(original) || !validCorrectionText(replacement)) {
    issues.push({ role: 'rules', line: lineNumber, message: '纠错内容为空、过长或包含控制字符' });
    return;
  }
  let confidence = 0.92;
  let message = '可能的错字';
  for (const property of columns) {
    const separator = property.indexOf('=');
    const key = separator < 0 ? '' : property.slice(0, separator).trim();
    const value = separator < 0 ? '' : property.slice(separator + 1).trim();
    if (key === '可信度') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) confidence = clamp(parsed, 0, 1);
      else issues.push({ role: 'rules', line: lineNumber, message: '可信度必须是 0 到 1 的数字' });
    } else if (key === '提示' && value) message = value.slice(0, 120);
    else issues.push({ role: 'rules', line: lineNumber, message: `不支持属性“${key || property}”，已忽略` });
  }
  corrections.set(normalizeText(original), { original, replacement, confidence, message });
}

function parseTerm(
  raw: string,
  lineNumber: number,
  target: Set<string>,
  issues: TextAssistResourceIssue[],
  label: string,
): void {
  if (validTerm(raw)) target.add(raw);
  else issues.push({ role: 'rules', line: lineNumber, message: `${label}为空、过长或包含控制字符` });
}

function forEachResourceLine(
  text: string,
  role: TextAssistResourceRole,
  issues: TextAssistResourceIssue[],
  visit: (line: string, lineNumber: number) => void,
): void {
  if (text.length > MAX_RESOURCE_LENGTH) throw new Error(`${role} 资源超过 16 MiB 安全上限`);
  let lineNumber = 0;
  for (const rawLine of text.split(/\r?\n/u)) {
    lineNumber += 1;
    if (lineNumber > MAX_RESOURCE_LINES) throw new Error(`${role} 资源超过 200000 行安全上限`);
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    try {
      visit(line, lineNumber);
    } catch (error) {
      issues.push({ role, line: lineNumber, message: error instanceof Error ? error.message : String(error) });
    }
  }
}

function parseBoolean(
  value: string,
  fallback: boolean,
  role: TextAssistResourceRole,
  line: number,
  issues: TextAssistResourceIssue[],
): boolean {
  const normalized = value.trim().toLocaleLowerCase('zh-CN');
  if (['是', 'true', '1', '开', '开启'].includes(normalized)) return true;
  if (['否', 'false', '0', '关', '关闭'].includes(normalized)) return false;
  issues.push({ role, line, message: `布尔值“${value}”无效，应填写“是”或“否”` });
  return fallback;
}

function splitAssignment(line: string): [string, string] {
  const separator = line.indexOf('=');
  return separator < 0 ? [line.trim(), ''] : [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
}

function validTerm(term: string): boolean {
  return term.length > 0 && term.length <= MAX_TERM_LENGTH && !/[\u0000-\u001f\u007f]/u.test(term);
}

function validSingleHan(value: string): boolean {
  return /^\p{Script=Han}$/u.test(value);
}

function uniqueHanCharacters(value: string, excluded = ''): string {
  const characters = new Set<string>();
  for (const character of value) {
    if (character !== excluded && validSingleHan(character)) characters.add(character);
  }
  return [...characters].join('');
}

function validCorrectionText(text: string): boolean {
  return text.length > 0 && text.length <= MAX_CORRECTION_LENGTH && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text);
}

function isPunctuation(value: string): boolean {
  return /^[\p{P}\p{S}]$/u.test(value);
}

function normalizeText(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase('zh-CN');
}

function longestFirst(left: string, right: string): number {
  return right.length - left.length || left.localeCompare(right, 'zh-CN');
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clampInteger(value: number, min: number, max: number, fallback: number): number {
  return Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
}
