import { ArtifactDownloadHost, FilePanel } from './FilePanel.tsx';
import { createImportExportPlugin } from './model.ts';

export const importExportPlugin = createImportExportPlugin(FilePanel, ArtifactDownloadHost);
