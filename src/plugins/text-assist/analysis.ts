import type { ContentSummary } from '../../protocols/content.ts';
import type {
  TextAssistAnalysis,
  TextAssistAnalyzeRequest,
  TextAssistCorrectionRule,
  TextAssistLanguageModel,
  TextAssistSettings,
  TextCompletionCandidate,
  TextCorrectionDecoration,
  TextNodeReferenceDecoration,
} from '../../protocols/text-assist.ts';
import { DEFAULT_TEXT_ASSIST_SETTINGS } from '../../protocols/text-assist.ts';
import { compileTextAssistResources } from './resource-format.ts';

interface TitleEntry {
  title: string;
  normalized: string;
  targets: TextNodeReferenceDecoration['targets'];
}

interface TitleTrieNode {
  children: Map<string, TitleTrieNode>;
  entry?: TitleEntry;
}

interface TermTrieNode {
  children: Map<string, TermTrieNode>;
  terminal?: boolean;
  replacement?: string;
}

interface CorrectionTrieNode {
  children: Map<string, CorrectionTrieNode>;
  rule?: TextAssistCorrectionRule;
}

type ConfusionKind = 'same-tone' | 'shape' | 'different-tone';

interface ConfusionTarget {
  character: string;
  kind: ConfusionKind;
  rank: number;
}

interface ConfusionCanonicalEntry {
  text: string;
  message: string;
  priority: number;
}

interface ConfusionTrieNode {
  children: Map<string, ConfusionTrieNode>;
  entries?: ConfusionCanonicalEntry[];
}

interface RuntimeLanguageModel {
  model: TextAssistLanguageModel;
  allowedRepeats: Set<string>;
  ignoredTrie: TermTrieNode;
  repeatedTrie: TermTrieNode;
  correctionTrie: CorrectionTrieNode;
  punctuationMappings: Map<string, string>;
  confusionTargets: Map<string, ConfusionTarget[]>;
}

interface TextRange {
  start: number;
  end: number;
}

export interface TextAssistCatalog {
  entries: TitleEntry[];
  trie: TitleTrieNode;
  language: RuntimeLanguageModel;
  confusionTrie: ConfusionTrieNode;
  resourceNodeIds: Set<string>;
}

const LANGUAGE_RUNTIME_CACHE = new WeakMap<TextAssistLanguageModel, RuntimeLanguageModel>();
const FOCUSED_CORRECTION_LOOKBEHIND = 512;
const FOCUSED_CORRECTION_LOOKAHEAD = 256;
const FOCUSED_CORRECTION_SCAN_LIMIT = 600;
const MIN_CONFUSION_CANONICAL_CONFIDENCE = 0.94;

/** Lightweight parser defaults used only before the external rule TXT is ready. */
export const DEFAULT_TEXT_ASSIST_LANGUAGE_MODEL = compileTextAssistResources({ rules: '' }).model;

export function buildTextAssistCatalog(
  summaries: ContentSummary[],
  languageModel: TextAssistLanguageModel = DEFAULT_TEXT_ASSIST_LANGUAGE_MODEL,
  excludedNodeIds: Iterable<string> = [],
): TextAssistCatalog {
  const resourceNodeIds = new Set(excludedNodeIds);
  const grouped = new Map<string, ContentSummary[]>();
  for (const summary of summaries) {
    if (resourceNodeIds.has(summary.id)) continue;
    const title = summary.title.trim();
    if ([...title].length < 2 || title.length > 160) continue;
    const matches = grouped.get(title) ?? [];
    matches.push(summary);
    grouped.set(title, matches);
  }
  const entries: TitleEntry[] = [...grouped.entries()].map(([title, matches]) => ({
    title,
    normalized: normalizeForCompletion(title),
    targets: matches.map((summary) => ({
      id: summary.id,
      title: summary.title,
      preview: summary.preview.trim(),
    })),
  })).sort((left, right) => right.title.length - left.title.length || left.title.localeCompare(right.title, 'zh-CN'));
  const trie: TitleTrieNode = { children: new Map() };
  for (const entry of entries) insertTitle(trie, entry);
  const language = cachedRuntimeLanguageModel(languageModel);
  return {
    entries,
    trie,
    language,
    confusionTrie: createConfusionTrie(languageModel, entries),
    resourceNodeIds,
  };
}

export function analyzeTextAssistance(
  request: TextAssistAnalyzeRequest,
  catalog: TextAssistCatalog,
  signal?: AbortSignal,
  settings: TextAssistSettings = DEFAULT_TEXT_ASSIST_SETTINGS,
): TextAssistAnalysis {
  if (catalog.resourceNodeIds.has(request.nodeId)) return emptyAnalysis(request);
  const maxDecorations = clampInteger(request.maxDecorations, 1, 600, 240);
  const maxCompletions = clampInteger(request.maxCompletions, 1, 8, 5);
  const corrections = settings.correctionEnabled
    ? prioritizedCorrectionDecorations(request, catalog, maxDecorations, signal)
    : [];
  const references = titleDecorations(
    request.text,
    request.windowStart,
    request.nodeId,
    catalog.trie,
    Math.max(0, maxDecorations - corrections.length),
    signal,
  );
  return {
    nodeId: request.nodeId,
    revision: request.revision,
    windowStart: request.windowStart,
    windowLength: request.text.length,
    decorations: [...corrections, ...references].sort((left, right) =>
      left.start - right.start || left.end - right.end || left.kind.localeCompare(right.kind)),
    completions: completionCandidates(request, catalog, corrections, maxCompletions, settings),
  };
}

function prioritizedCorrectionDecorations(
  request: TextAssistAnalyzeRequest,
  catalog: TextAssistCatalog,
  limit: number,
  signal?: AbortSignal,
): TextCorrectionDecoration[] {
  const localCursor = Math.max(0, Math.min(request.text.length, request.cursor - request.windowStart));
  const focusStart = Math.max(0, localCursor - FOCUSED_CORRECTION_LOOKBEHIND);
  const focusEnd = Math.min(request.text.length, localCursor + FOCUSED_CORRECTION_LOOKAHEAD);
  const focused = correctionDecorations(
    request.text.slice(focusStart, focusEnd),
    request.windowStart + focusStart,
    catalog,
    FOCUSED_CORRECTION_SCAN_LIMIT,
    signal,
  );
  const surrounding = focusStart === 0 && focusEnd === request.text.length
    ? []
    : correctionDecorations(request.text, request.windowStart, catalog, limit, signal);
  const unique = new Map<string, TextCorrectionDecoration>();
  for (const item of [...focused, ...surrounding]) {
    unique.set(`${item.start}:${item.end}:${item.suggestions.join('\u0000')}`, item);
  }
  return [...unique.values()]
    .sort((left, right) => correctionDistance(left, request.cursor) - correctionDistance(right, request.cursor) ||
      left.start - right.start || left.end - right.end)
    .slice(0, limit)
    .sort((left, right) => left.start - right.start || left.end - right.end);
}

function correctionDistance(item: TextCorrectionDecoration, cursor: number): number {
  if (cursor < item.start) return item.start - cursor;
  if (cursor > item.end) return cursor - item.end;
  return 0;
}

function correctionDecorations(
  text: string,
  windowStart: number,
  catalog: TextAssistCatalog,
  limit: number,
  signal?: AbortSignal,
): TextCorrectionDecoration[] {
  const language = catalog.language;
  const corrections: TextCorrectionDecoration[] = [];
  const protectedRanges = [
    ...findTitleRanges(text, catalog.trie, signal),
    ...findTermRanges(text, language.ignoredTrie, signal),
  ];
  appendFixedCorrections(text, windowStart, language.correctionTrie, corrections, limit, signal);
  appendConfusionCorrections(
    text,
    windowStart,
    catalog.confusionTrie,
    language.confusionTargets,
    corrections,
    limit,
    signal,
  );

  if (language.model.checks.repeatedPunctuation) {
    for (const match of text.matchAll(/([，。！？；：、,.!?;:])\1+/gu)) {
      throwIfAborted(signal);
      if (corrections.length >= limit) break;
      corrections.push(correction(windowStart + match.index, match[0], match[1], '这里可能有重复标点', 'punctuation'));
    }
  }

  if (language.model.checks.conflictingPunctuation) {
    for (const match of text.matchAll(/[，、；：,;:][。！？!?]|[。！？!?][，、；：,;:]/gu)) {
      throwIfAborted(signal);
      if (corrections.length >= limit) break;
      const replacement = /[。！？!?]/u.test(match[0][0]) ? match[0][0] : match[0][1];
      corrections.push(correction(windowStart + match.index, match[0], replacement, '相邻标点可能互相冲突', 'conflicting-punctuation'));
    }
  }

  if (language.model.checks.spaceBeforeChinesePunctuation) {
    for (const match of text.matchAll(/[ \t]+(?=[，。！？；：、])/gu)) {
      throwIfAborted(signal);
      if (corrections.length >= limit) break;
      corrections.push(correction(windowStart + match.index, match[0], '', '中文标点前通常不需要空格', 'space'));
    }
  }

  if (language.model.checks.consecutiveSpaces) {
    for (const match of text.matchAll(/([\p{Script=Han}])[ \t]{2,}(?=[\p{Script=Han}])/gu)) {
      throwIfAborted(signal);
      if (corrections.length >= limit) break;
      const spaces = match[0].slice(match[1].length);
      corrections.push(correction(
        windowStart + match.index + match[1].length,
        spaces,
        '',
        '中文之间可能多输入了空格',
        'consecutive-spaces',
      ));
    }
  }

  if (language.model.checks.mixedChinesePunctuation) {
    appendMixedPunctuationCorrections(text, windowStart, language.punctuationMappings, corrections, limit, signal);
  }

  if (language.model.checks.repeatedText) {
    for (const match of text.matchAll(/([\p{Script=Han}]{2,12})\1|([\p{Script=Han}])\2{2,}/gu)) {
      throwIfAborted(signal);
      if (corrections.length >= limit) break;
      const original = match[0];
      if (isAllowedRepeat(text, match.index, original, language)) continue;
      corrections.push(correction(
        windowStart + match.index,
        original,
        match[1] ?? match[2],
        '这里可能重复输入了文字',
        'repeated-text',
      ));
    }
  }

  if (language.model.checks.repeatedTerms) {
    appendRepeatedTermCorrections(text, windowStart, language, corrections, limit, signal);
  }

  return removeOverlappingCorrections(corrections)
    .filter((item) => !overlapsAny(item.start - windowStart, item.end - windowStart, protectedRanges))
    .slice(0, limit);
}

function appendConfusionCorrections(
  text: string,
  windowStart: number,
  trie: ConfusionTrieNode,
  targets: Map<string, ConfusionTarget[]>,
  corrections: TextCorrectionDecoration[],
  limit: number,
  signal?: AbortSignal,
): void {
  for (let start = 0; start < text.length && corrections.length < limit; start += 1) {
    if ((start & 2047) === 0) throwIfAborted(signal);
    let states: Array<{ node: ConfusionTrieNode; kind?: ConfusionKind; rank: number }> = [
      { node: trie, rank: 0 },
    ];
    let best: { end: number; entry: ConfusionCanonicalEntry; kind: ConfusionKind; rank: number } | undefined;
    for (let end = start; end < text.length && states.length > 0; end += 1) {
      const actual = text[end];
      const next = new Map<ConfusionTrieNode, { node: ConfusionTrieNode; kind?: ConfusionKind; rank: number }>();
      for (const state of states) {
        const direct = state.node.children.get(actual);
        if (direct) retainConfusionState(next, { ...state, node: direct });
        if (state.kind) continue;
        for (const target of targets.get(actual) ?? []) {
          const substitute = state.node.children.get(target.character);
          if (substitute) retainConfusionState(next, { node: substitute, kind: target.kind, rank: target.rank });
        }
      }
      states = [...next.values()];
      for (const state of states) {
        if (!state.kind || !state.node.entries?.length) continue;
        for (const entry of state.node.entries) {
          const candidate = { end: end + 1, entry, kind: state.kind, rank: state.rank };
          if (!best || compareConfusionMatch(candidate, best) > 0) best = candidate;
        }
      }
    }
    if (!best) continue;
    const original = text.slice(start, best.end);
    if (original === best.entry.text) continue;
    corrections.push(correction(
      windowStart + start,
      original,
      best.entry.text,
      `${best.entry.message}（${confusionKindLabel(best.kind)}候选）`,
      `confusion:${best.entry.text}`,
    ));
    start = best.end - 1;
  }
}

function retainConfusionState(
  states: Map<ConfusionTrieNode, { node: ConfusionTrieNode; kind?: ConfusionKind; rank: number }>,
  candidate: { node: ConfusionTrieNode; kind?: ConfusionKind; rank: number },
): void {
  const current = states.get(candidate.node);
  if (!current || candidate.rank > current.rank) states.set(candidate.node, candidate);
}

function compareConfusionMatch(
  left: { end: number; entry: ConfusionCanonicalEntry; rank: number },
  right: { end: number; entry: ConfusionCanonicalEntry; rank: number },
): number {
  return left.end - right.end || left.entry.priority - right.entry.priority || left.rank - right.rank ||
    right.entry.text.localeCompare(left.entry.text, 'zh-CN');
}

function confusionKindLabel(kind: ConfusionKind): string {
  if (kind === 'same-tone') return '同音同调';
  if (kind === 'different-tone') return '同音异调';
  return '形近字';
}

function appendFixedCorrections(
  text: string,
  windowStart: number,
  trie: CorrectionTrieNode,
  corrections: TextCorrectionDecoration[],
  limit: number,
  signal?: AbortSignal,
): void {
  for (let start = 0; start < text.length && corrections.length < limit; start += 1) {
    if ((start & 4095) === 0) throwIfAborted(signal);
    let node: CorrectionTrieNode | undefined = trie;
    let best: { end: number; rule: TextAssistCorrectionRule } | undefined;
    for (let end = start; end < text.length; end += 1) {
      node = node.children.get(text[end]);
      if (!node) break;
      if (node.rule) best = { end: end + 1, rule: node.rule };
    }
    if (!best) continue;
    corrections.push(correction(
      windowStart + start,
      best.rule.original,
      best.rule.replacement,
      best.rule.message,
    ));
    start = best.end - 1;
  }
}

function appendMixedPunctuationCorrections(
  text: string,
  windowStart: number,
  mappings: Map<string, string>,
  corrections: TextCorrectionDecoration[],
  limit: number,
  signal?: AbortSignal,
): void {
  for (let index = 0; index < text.length && corrections.length < limit; index += 1) {
    if ((index & 4095) === 0) throwIfAborted(signal);
    const replacement = mappings.get(text[index]);
    if (!replacement) continue;
    const previous = text[index - 1] ?? '';
    const next = text[index + 1] ?? '';
    if (!isHan(previous) && !isHan(next)) continue;
    corrections.push(correction(
      windowStart + index,
      text[index],
      replacement,
      `中文语句中建议使用“${replacement}”`,
      'mixed-punctuation',
    ));
  }
}

function appendRepeatedTermCorrections(
  text: string,
  windowStart: number,
  language: RuntimeLanguageModel,
  corrections: TextCorrectionDecoration[],
  limit: number,
  signal?: AbortSignal,
): void {
  for (let start = 0; start < text.length && corrections.length < limit; start += 1) {
    if ((start & 4095) === 0) throwIfAborted(signal);
    let node: TermTrieNode | undefined = language.repeatedTrie;
    let best: { end: number; replacement: string } | undefined;
    for (let end = start; end < text.length; end += 1) {
      node = node.children.get(text[end]);
      if (!node) break;
      if (node.replacement !== undefined) best = { end: end + 1, replacement: node.replacement };
    }
    if (!best) continue;
    const original = text.slice(start, best.end);
    if (!isAllowedRepeat(text, start, original, language)) {
      corrections.push(correction(
        windowStart + start,
        original,
        best.replacement,
        `“${best.replacement}”可能重复输入`,
        'repeated-term',
      ));
    }
    start = best.end - 1;
  }
}

function correction(
  start: number,
  original: string,
  replacement: string,
  message: string,
  discriminator = original,
): TextCorrectionDecoration {
  return {
    id: `correction:${start}:${discriminator}`,
    kind: 'correction',
    start,
    end: start + original.length,
    original,
    suggestions: [replacement],
    message: replacement && message === '可能的错字' ? `${message}：建议改为“${replacement}”` : message,
  };
}

function isAllowedRepeat(text: string, start: number, original: string, language: RuntimeLanguageModel): boolean {
  if (language.allowedRepeats.has(original)) return true;
  for (const allowed of language.allowedRepeats) {
    const left = Math.max(0, start - allowed.length + original.length);
    const right = Math.min(text.length, start + original.length + allowed.length);
    if (text.slice(left, right).includes(allowed)) return true;
  }
  return false;
}

function titleDecorations(
  text: string,
  windowStart: number,
  currentNodeId: string,
  trie: TitleTrieNode,
  limit: number,
  signal?: AbortSignal,
): TextNodeReferenceDecoration[] {
  const references: TextNodeReferenceDecoration[] = [];
  for (let start = 0; start < text.length && references.length < limit; start += 1) {
    if ((start & 4095) === 0) throwIfAborted(signal);
    let node: TitleTrieNode | undefined = trie;
    let best: { entry: TitleEntry; end: number } | undefined;
    for (let end = start; end < text.length; end += 1) {
      node = node.children.get(text[end]);
      if (!node) break;
      if (node.entry) best = { entry: node.entry, end: end + 1 };
    }
    if (!best) continue;
    const targets = best.entry.targets.filter((target) => target.id !== currentNodeId);
    if (targets.length === 0) continue;
    references.push({
      id: `node-reference:${windowStart + start}:${best.entry.title}`,
      kind: 'node-reference',
      start: windowStart + start,
      end: windowStart + best.end,
      title: best.entry.title,
      targets,
    });
    start = best.end - 1;
  }
  return references;
}

function completionCandidates(
  request: TextAssistAnalyzeRequest,
  catalog: TextAssistCatalog,
  corrections: TextCorrectionDecoration[],
  limit: number,
  settings: TextAssistSettings,
): TextCompletionCandidate[] {
  const localCursor = Math.max(0, Math.min(request.text.length, request.cursor - request.windowStart));
  const candidates: TextCompletionCandidate[] = [];
  const seen = new Set<string>();

  if (settings.correctionEnabled) {
    const nearbyCorrections = corrections
      .filter((item) => isCorrectionNearCursor(item, request, localCursor))
      .sort((left, right) => request.cursor - left.end - (request.cursor - right.end) || right.end - left.end);
    for (const item of nearbyCorrections) {
      if (candidates.length >= limit) break;
      for (const suggestion of item.suggestions) {
        if (candidates.length >= limit) break;
        const key = `correction:${item.start}:${item.end}:${suggestion}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({
          id: key,
          kind: 'correction',
          label: suggestion || '删除多余内容',
          detail: `纠错 · 替换“${item.original || '空格'}”`,
          insertText: suggestion,
          replaceStart: item.start,
          replaceEnd: item.end,
        });
      }
    }
  }

  if (!settings.completionEnabled || candidates.length >= limit) return candidates;
  const prefixMatch = request.text.slice(Math.max(0, localCursor - 64), localCursor)
    .match(/[\p{L}\p{N}_·-]{1,48}$/u);
  const prefix = prefixMatch?.[0] ?? '';
  if ([...prefix].length < catalog.language.model.completion.minimumPrefix) return candidates;
  const normalizedToken = normalizeForCompletion(prefix);
  const prefixOptions = completionPrefixOptions(
    prefix,
    request.cursor,
    catalog.language.model.completion.minimumPrefix,
  );
  const ranked: Array<{ score: number; candidate: TextCompletionCandidate; normalized: string }> = [];

  for (const entry of catalog.entries) {
    if (normalizedToken.endsWith(entry.normalized)) continue;
    const match = bestTitleCompletionMatch(
      entry.normalized,
      prefixOptions,
      catalog.language.model.completion,
    );
    if (!match) continue;
    const target = entry.targets.find((item) => item.id !== request.nodeId) ?? entry.targets[0];
    if (!target) continue;
    const matchScore = match.kind === 'prefix'
      ? 0
      : match.kind === 'contains'
        ? catalog.language.model.scoring.contains
        : catalog.language.model.scoring.fuzzy;
    const matchLabel = match.kind === 'prefix'
      ? '前缀匹配'
      : match.kind === 'contains'
        ? '包含匹配'
        : '容错匹配';
    ranked.push({
      normalized: entry.normalized,
      score: catalog.language.model.scoring.nodeTitle + matchScore +
        match.option.length * catalog.language.model.scoring.prefix,
      candidate: {
        id: `completion:node:${target.id}`,
        kind: 'node-title',
        label: entry.title,
        detail: `${matchLabel} · 画布节点`,
        insertText: entry.title,
        replaceStart: match.option.replaceStart,
        replaceEnd: request.cursor,
        targetId: target.id,
      },
    });
  }

  ranked.sort((left, right) => right.score - left.score || left.candidate.label.localeCompare(right.candidate.label, 'zh-CN'));
  for (const item of ranked) {
    if (candidates.length >= limit || seen.has(item.normalized)) continue;
    seen.add(item.normalized);
    candidates.push(item.candidate);
  }
  return candidates;
}

interface CompletionPrefixOption {
  normalized: string;
  length: number;
  replaceStart: number;
}

function completionPrefixOptions(
  token: string,
  cursor: number,
  minimumPrefix: number,
): CompletionPrefixOption[] {
  const characters = [...token];
  const options: CompletionPrefixOption[] = [];
  let utf16Offset = 0;
  for (let index = 0; index < characters.length; index += 1) {
    const text = token.slice(utf16Offset);
    const normalized = normalizeForCompletion(text);
    const length = [...normalized].length;
    if (length >= minimumPrefix) {
      options.push({
        normalized,
        length,
        replaceStart: cursor - text.length,
      });
    }
    utf16Offset += characters[index].length;
  }
  return options;
}

function bestTitleCompletionMatch(
  title: string,
  options: CompletionPrefixOption[],
  settings: TextAssistLanguageModel['completion'],
): { kind: 'prefix' | 'contains' | 'fuzzy'; option: CompletionPrefixOption } | undefined {
  let best: { kind: 'prefix' | 'contains' | 'fuzzy'; option: CompletionPrefixOption } | undefined;
  for (const option of options) {
    const kind = titleCompletionMatch(title, option.normalized, settings);
    if (!kind || title === option.normalized) continue;
    if (!best || titleCompletionMatchRank(kind) > titleCompletionMatchRank(best.kind) ||
      (kind === best.kind && option.length > best.option.length)) {
      best = { kind, option };
    }
  }
  return best;
}

function titleCompletionMatchRank(match: 'prefix' | 'contains' | 'fuzzy'): number {
  return match === 'prefix' ? 3 : match === 'contains' ? 2 : 1;
}

function isCorrectionNearCursor(
  item: TextCorrectionDecoration,
  request: TextAssistAnalyzeRequest,
  localCursor: number,
): boolean {
  if (item.end > request.cursor || request.cursor - item.end > 4) return false;
  const localEnd = item.end - request.windowStart;
  if (localEnd < 0 || localEnd > localCursor) return false;
  return /^[\s，。！？；：、,.!?;:]*$/u.test(request.text.slice(localEnd, localCursor));
}

function titleCompletionMatch(
  title: string,
  prefix: string,
  settings: TextAssistLanguageModel['completion'],
): 'prefix' | 'contains' | 'fuzzy' | undefined {
  if (title.startsWith(prefix)) return 'prefix';
  const prefixLength = [...prefix].length;
  if (prefixLength < settings.minimumFuzzyPrefix) return undefined;
  if (settings.useContains && title.includes(prefix)) return 'contains';
  if (!settings.useFuzzy) return undefined;
  const titlePrefix = [...title].slice(0, prefixLength).join('');
  return isWithinOneEdit(prefix, titlePrefix) ? 'fuzzy' : undefined;
}

function isWithinOneEdit(left: string, right: string): boolean {
  const leftCharacters = [...left];
  const rightCharacters = [...right];
  if (Math.abs(leftCharacters.length - rightCharacters.length) > 1) return false;
  if (leftCharacters.length === rightCharacters.length) {
    let differences = 0;
    for (let index = 0; index < leftCharacters.length; index += 1) {
      if (leftCharacters[index] !== rightCharacters[index] && ++differences > 1) return false;
    }
    return differences === 1;
  }
  const shorter = leftCharacters.length < rightCharacters.length ? leftCharacters : rightCharacters;
  const longer = leftCharacters.length < rightCharacters.length ? rightCharacters : leftCharacters;
  let shortIndex = 0;
  let longIndex = 0;
  let skipped = false;
  while (shortIndex < shorter.length && longIndex < longer.length) {
    if (shorter[shortIndex] === longer[longIndex]) {
      shortIndex += 1;
      longIndex += 1;
      continue;
    }
    if (skipped) return false;
    skipped = true;
    longIndex += 1;
  }
  return true;
}

function createRuntimeLanguageModel(model: TextAssistLanguageModel): RuntimeLanguageModel {
  const correctionTrie: CorrectionTrieNode = { children: new Map() };
  for (const rule of model.corrections) insertCorrection(correctionTrie, rule);
  const ignoredTrie: TermTrieNode = { children: new Map() };
  for (const term of model.ignoredTerms) insertTerm(ignoredTrie, term);
  const repeatedTrie: TermTrieNode = { children: new Map() };
  for (const term of model.repeatedTerms) insertRepeatedTerm(repeatedTrie, term);
  return {
    model,
    allowedRepeats: new Set(model.allowedRepeats),
    ignoredTrie,
    repeatedTrie,
    correctionTrie,
    punctuationMappings: new Map(model.punctuationMappings.map((mapping) => [mapping.original, mapping.replacement])),
    confusionTargets: createConfusionTargets(model),
  };
}

function createConfusionTargets(model: TextAssistLanguageModel): Map<string, ConfusionTarget[]> {
  const relations = new Map<string, Map<string, ConfusionTarget>>();
  if (model.confusion.useSameTone || model.confusion.useDifferentTone) {
    for (const entry of model.confusion.pinyin) {
      if (model.confusion.useSameTone) {
        addConfusionRelations(relations, entry.character, entry.sameTone, 'same-tone', 3);
      }
      if (model.confusion.useDifferentTone) {
        addConfusionRelations(relations, entry.character, entry.differentTone, 'different-tone', 1);
      }
    }
  }
  if (model.confusion.useShape) {
    for (const entry of model.confusion.shape) {
      addConfusionRelations(relations, entry.character, entry.candidates, 'shape', 2);
    }
  }
  return new Map([...relations].map(([character, candidates]) => [
    character,
    [...candidates.values()].sort((left, right) => right.rank - left.rank ||
      left.character.localeCompare(right.character, 'zh-CN')),
  ]));
}

function addConfusionRelations(
  relations: Map<string, Map<string, ConfusionTarget>>,
  source: string,
  candidates: string,
  kind: ConfusionKind,
  rank: number,
): void {
  for (const candidate of candidates) {
    addConfusionRelation(relations, source, candidate, kind, rank);
    addConfusionRelation(relations, candidate, source, kind, rank);
  }
}

function addConfusionRelation(
  relations: Map<string, Map<string, ConfusionTarget>>,
  source: string,
  candidate: string,
  kind: ConfusionKind,
  rank: number,
): void {
  if (source === candidate) return;
  const targets = relations.get(source) ?? new Map<string, ConfusionTarget>();
  const current = targets.get(candidate);
  if (!current || rank > current.rank) targets.set(candidate, { character: candidate, kind, rank });
  relations.set(source, targets);
}

function createConfusionTrie(model: TextAssistLanguageModel, titles: TitleEntry[]): ConfusionTrieNode {
  const root: ConfusionTrieNode = { children: new Map() };
  const canonical = new Map<string, ConfusionCanonicalEntry>();
  const { minimumTermLength, maximumTermLength } = model.confusion;
  for (const rule of model.corrections) {
    const length = [...rule.replacement].length;
    if (length < minimumTermLength || length > maximumTermLength ||
      [...rule.original].length !== length || rule.confidence < MIN_CONFUSION_CANONICAL_CONFIDENCE ||
      !isHanTerm(rule.replacement)) continue;
    const entry = {
      text: rule.replacement,
      message: `可能的错字：建议改为“${rule.replacement}”`,
      priority: Math.round(rule.confidence * 100),
    };
    const current = canonical.get(entry.text);
    if (!current || entry.priority > current.priority) canonical.set(entry.text, entry);
  }
  for (const title of titles) {
    const length = [...title.title].length;
    if (length < minimumTermLength || length > maximumTermLength || !isHanTerm(title.title)) continue;
    canonical.set(title.title, {
      text: title.title,
      message: `可能是画布节点标题“${title.title}”`,
      priority: 120,
    });
  }
  for (const entry of canonical.values()) insertConfusionCanonical(root, entry);
  return root;
}

function insertConfusionCanonical(trie: ConfusionTrieNode, entry: ConfusionCanonicalEntry): void {
  let node = trie;
  for (const character of entry.text) {
    let next = node.children.get(character);
    if (!next) {
      next = { children: new Map() };
      node.children.set(character, next);
    }
    node = next;
  }
  const entries = node.entries ?? [];
  if (!entries.some((candidate) => candidate.text === entry.text)) entries.push(entry);
  node.entries = entries;
}

function cachedRuntimeLanguageModel(model: TextAssistLanguageModel): RuntimeLanguageModel {
  const cached = LANGUAGE_RUNTIME_CACHE.get(model);
  if (cached) return cached;
  const created = createRuntimeLanguageModel(model);
  LANGUAGE_RUNTIME_CACHE.set(model, created);
  return created;
}

function insertTitle(trie: TitleTrieNode, entry: TitleEntry): void {
  let node = trie;
  for (const character of entry.title) {
    let next = node.children.get(character);
    if (!next) {
      next = { children: new Map() };
      node.children.set(character, next);
    }
    node = next;
  }
  node.entry = entry;
}

function insertCorrection(trie: CorrectionTrieNode, rule: TextAssistCorrectionRule): void {
  let node = trie;
  for (const character of rule.original) {
    let next = node.children.get(character);
    if (!next) {
      next = { children: new Map() };
      node.children.set(character, next);
    }
    node = next;
  }
  node.rule = rule;
}

function insertTerm(trie: TermTrieNode, term: string): void {
  let node = trie;
  for (const character of term) {
    let next = node.children.get(character);
    if (!next) {
      next = { children: new Map() };
      node.children.set(character, next);
    }
    node = next;
  }
  node.terminal = true;
}

function insertRepeatedTerm(trie: TermTrieNode, term: string): void {
  let node = trie;
  for (const character of `${term}${term}`) {
    let next = node.children.get(character);
    if (!next) {
      next = { children: new Map() };
      node.children.set(character, next);
    }
    node = next;
  }
  node.replacement = term;
}

function findTitleRanges(text: string, trie: TitleTrieNode, signal?: AbortSignal): TextRange[] {
  const ranges: TextRange[] = [];
  for (let start = 0; start < text.length; start += 1) {
    if ((start & 4095) === 0) throwIfAborted(signal);
    let node: TitleTrieNode | undefined = trie;
    let bestEnd = -1;
    for (let end = start; end < text.length; end += 1) {
      node = node.children.get(text[end]);
      if (!node) break;
      if (node.entry) bestEnd = end + 1;
    }
    if (bestEnd > start) {
      ranges.push({ start, end: bestEnd });
      start = bestEnd - 1;
    }
  }
  return ranges;
}

function findTermRanges(text: string, trie: TermTrieNode, signal?: AbortSignal): TextRange[] {
  const ranges: TextRange[] = [];
  for (let start = 0; start < text.length; start += 1) {
    if ((start & 4095) === 0) throwIfAborted(signal);
    let node: TermTrieNode | undefined = trie;
    let bestEnd = -1;
    for (let end = start; end < text.length; end += 1) {
      node = node.children.get(text[end]);
      if (!node) break;
      if (node.terminal) bestEnd = end + 1;
    }
    if (bestEnd > start) {
      ranges.push({ start, end: bestEnd });
      start = bestEnd - 1;
    }
  }
  return ranges;
}

function overlapsAny(start: number, end: number, ranges: TextRange[]): boolean {
  return ranges.some((range) => start < range.end && end > range.start);
}

function removeOverlappingCorrections(corrections: TextCorrectionDecoration[]): TextCorrectionDecoration[] {
  const sorted = [...corrections].sort((left, right) => left.start - right.start || right.end - left.end);
  const result: TextCorrectionDecoration[] = [];
  for (const item of sorted) {
    if (result.some((existing) => item.start < existing.end && item.end > existing.start)) continue;
    result.push(item);
  }
  return result;
}

function normalizeForCompletion(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase('zh-CN');
}

function isHan(character: string): boolean {
  return /^\p{Script=Han}$/u.test(character);
}

function isHanTerm(value: string): boolean {
  return /^\p{Script=Han}+$/u.test(value);
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  return Number.isInteger(value) ? Math.max(min, Math.min(max, value!)) : fallback;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Task cancelled', 'AbortError');
}

function emptyAnalysis(request: TextAssistAnalyzeRequest): TextAssistAnalysis {
  return {
    nodeId: request.nodeId,
    revision: request.revision,
    windowStart: request.windowStart,
    windowLength: request.text.length,
    decorations: [],
    completions: [],
  };
}
