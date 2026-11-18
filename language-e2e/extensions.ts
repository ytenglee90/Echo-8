import type { LanguageCase } from './corpus.ts';

/** Additions are measured separately; the original 528 utterances stay frozen. */
export const extensionLanguageCases: LanguageCase[] = [{
  id: 'clipboard.duplicate',
  phrases: [
    '把主角和反派连同内部关系复制到右边',
    '复制主角与反派及它们之间的连线到右侧，原件保留',
    '将主角和反派克隆到右方，保留原对象',
  ],
  oracle: 'duplicate-graph',
}];
