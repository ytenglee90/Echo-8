import type { TextAssistCompileResult, TextAssistResourceTexts } from './resource-format.ts';
import { compileTextAssistResources } from './resource-format.ts';

export const TEXT_ASSIST_COMPILE_JOB = 'text-assist.compile-rules@2';

export type TextAssistCompileRequest = TextAssistResourceTexts;

export function compileTextAssistWorkerRequest(request: TextAssistCompileRequest): TextAssistCompileResult {
  return compileTextAssistResources(request);
}
