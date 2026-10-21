import { DiagnosticCenterPanel } from './DiagnosticCenterPanel.tsx';
import { createDiagnosticCenterPlugin } from './model.ts';

export const diagnosticCenterPlugin = createDiagnosticCenterPlugin(DiagnosticCenterPanel);
