import type { TextAssistResourceRole } from '../../protocols/text-assist.ts';

export interface TextAssistResourceSeed {
  role: TextAssistResourceRole;
  title: string;
  x: number;
  y: number;
}

/**
 * Resource metadata only. Rule text lives in Echo-8-text-assist-rules.txt so
 * the runtime code stays small and the language data can be updated alone.
 */
export const TEXT_ASSIST_RESOURCE_SEEDS: readonly TextAssistResourceSeed[] = [{
  role: 'rules',
  title: '纠错与补全规则',
  x: 120,
  y: 760,
}];

export const TEXT_ASSIST_RESOURCE_ROLES = TEXT_ASSIST_RESOURCE_SEEDS.map((seed) => seed.role);
