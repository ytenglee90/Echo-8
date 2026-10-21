export interface ContentStatistics {
  nodeCount: number;
  utf16Units: number;
  graphemes: number;
  nonWhitespaceGraphemes: number;
  words: number;
  lines: number;
  revisions: Record<string, number>;
}

export interface StatisticsContribution {
  kind: string;
  label: string;
  count: number;
}

export interface SelectedTextStatistics {
  nodeCount: number;
  utf16Units: number;
  graphemes: number;
  nonWhitespaceGraphemes: number;
}

export interface StatisticsSnapshot extends ContentStatistics {
  modules: StatisticsContribution[];
  computedAt: number;
  status: 'idle' | 'running' | 'ready' | 'error';
  error?: string;
}
