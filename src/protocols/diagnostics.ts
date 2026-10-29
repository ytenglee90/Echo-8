export interface DiagnosticRecord {
  id: number;
  timestamp: number;
  level: 'info' | 'warn' | 'error';
  source: string;
  message: string;
  detail?: unknown;
}
