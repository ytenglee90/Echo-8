import type { CommandContract } from './commands.ts';

export type TextAssistDecoration = TextCorrectionDecoration | TextNodeReferenceDecoration;

export interface TextCorrectionDecoration {
  id: string;
  kind: 'correction';
  start: number;
  end: number;
  original: string;
  suggestions: string[];
  message: string;
}

export interface TextNodeReferenceTarget {
  id: string;
  title: string;
  preview: string;
}

export interface TextNodeReferenceDecoration {
  id: string;
  kind: 'node-reference';
  start: number;
  end: number;
  title: string;
  targets: TextNodeReferenceTarget[];
}

export interface TextCompletionCandidate {
  id: string;
  kind: 'correction' | 'node-title';
  label: string;
  detail: string;
  insertText: string;
  replaceStart: number;
  replaceEnd: number;
  targetId?: string;
}

export interface TextAssistSettings {
  correctionEnabled: boolean;
  completionEnabled: boolean;
}

export const DEFAULT_TEXT_ASSIST_SETTINGS: TextAssistSettings = {
  correctionEnabled: true,
  completionEnabled: true,
};

export interface TextAssistAnalyzeRequest {
  nodeId: string;
  revision: number;
  text: string;
  windowStart: number;
  cursor: number;
  maxDecorations?: number;
  maxCompletions?: number;
}

export interface TextAssistAnalysis {
  nodeId: string;
  revision: number;
  windowStart: number;
  windowLength: number;
  decorations: TextAssistDecoration[];
  completions: TextCompletionCandidate[];
}

export type TextAssistResourceRole = 'rules';

export interface TextAssistEnsureResourcesRequest {
  automatic?: boolean;
}

export interface TextAssistEnsureResourcesResult {
  created: Array<{ role: TextAssistResourceRole; nodeId: string }>;
  missing: TextAssistResourceRole[];
}

export const TEXT_ASSIST_RULE_FILE_REQUESTED_SIGNAL = 'text.assist.rules-file.requested';

export interface TextAssistImportRulesFileRequest {
  name: string;
  text: string;
}

export interface TextAssistImportRulesFileResult {
  loaded: true;
  name: string;
  ensured: TextAssistEnsureResourcesResult;
}

export interface TextAssistResourceBinding {
  schemaVersion: 4;
  role: TextAssistResourceRole;
  nodeId: string;
  createdAt: number;
  updatedAt: number;
  defaultRuleVersion: number;
  /** Built-in rules are referenced by version; only the user overlay travels with the book. */
  ruleStorage: 'builtin-overlay' | 'embedded';
}

export interface TextAssistCorrectionRule {
  original: string;
  replacement: string;
  confidence: number;
  message: string;
}

export interface TextAssistPinyinConfusionEntry {
  character: string;
  sameTone: string;
  differentTone: string;
}

export interface TextAssistShapeConfusionEntry {
  character: string;
  candidates: string;
}

export interface TextAssistLanguageModel {
  schemaVersion: 3;
  corrections: TextAssistCorrectionRule[];
  ignoredTerms: string[];
  allowedRepeats: string[];
  repeatedTerms: string[];
  punctuationMappings: Array<{ original: string; replacement: string }>;
  checks: {
    repeatedPunctuation: boolean;
    spaceBeforeChinesePunctuation: boolean;
    repeatedText: boolean;
    repeatedTerms: boolean;
    consecutiveSpaces: boolean;
    mixedChinesePunctuation: boolean;
    conflictingPunctuation: boolean;
  };
  completion: {
    minimumPrefix: number;
    useContains: boolean;
    useFuzzy: boolean;
    minimumFuzzyPrefix: number;
  };
  scoring: {
    nodeTitle: number;
    prefix: number;
    contains: number;
    fuzzy: number;
  };
  confusion: {
    pinyin: TextAssistPinyinConfusionEntry[];
    shape: TextAssistShapeConfusionEntry[];
    useSameTone: boolean;
    useDifferentTone: boolean;
    useShape: boolean;
    minimumTermLength: number;
    maximumTermLength: number;
  };
}

export interface TextAssistResourceIssue {
  role: TextAssistResourceRole;
  line: number;
  message: string;
}

export interface TextAssistResourceStatus {
  ready: boolean;
  dirty: boolean;
  usingLastValid: boolean;
  association: {
    state: 'unassociated' | 'same-origin' | 'stored';
    fileName?: string;
  };
  bindings: Partial<Record<TextAssistResourceRole, TextAssistResourceBinding>>;
  revisions: Partial<Record<TextAssistResourceRole, number>>;
  ignoredTermCount: number;
  correctionCount: number;
  issues: TextAssistResourceIssue[];
}

declare module './commands.ts' {
  interface ApplicationCommandMap {
    'textAssist.loadRulesFile': CommandContract<undefined, { requested: true }>;
    'textAssist.importRulesFile': CommandContract<
      TextAssistImportRulesFileRequest,
      TextAssistImportRulesFileResult
    >;
    'textAssist.ensureResources': CommandContract<
      TextAssistEnsureResourcesRequest | undefined,
      TextAssistEnsureResourcesResult
    >;
  }
}
