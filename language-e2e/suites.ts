import { languageCases as originalCases } from './corpus.ts';
import { extensionLanguageCases } from './extensions.ts';

const requested = process.env.ECHO8_LANGUAGE_SUITE ?? 'original';
if (!['original', 'extended'].includes(requested)) throw new Error('Unknown language suite: ' + requested);
export const languageSuite = requested;
export const allLanguageCases = [...originalCases, ...extensionLanguageCases];
export const languageCases = requested === 'extended' ? extensionLanguageCases : originalCases;
export const languageReportStem = requested === 'extended' ? 'Echo-8-扩展动作同义指令' : 'Echo-8-自然语言同义指令';
