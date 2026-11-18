import {
  type TextAssistCompileResult,
  type TextAssistResourceTexts,
  compileTextAssistResources,
} from './resource-format.ts';

export const TEXT_ASSIST_COMPILE_JOB = 'text-assist.compile-rules@2';

export type TextAssistCompileRequest = TextAssistResourceTexts;

export function compileTextAssistWorkerRequest(request: TextAssistCompileRequest): TextAssistCompileResult {
  return compileTextAssistResources(request);
}
