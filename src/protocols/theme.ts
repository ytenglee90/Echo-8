export interface ThemeTokens {
  surface: string;
  panel: string;
  panelSoft: string;
  ink: string;
  muted: string;
  faint: string;
  border: string;
  borderStrong: string;
  accent: string;
  accentSoft: string;
  success: string;
  danger: string;
  toolbar: string;
  rail: string;
  status: string;
  canvas: string;
  canvasGrid: string;
  nodeSurface: string;
  editor: string;
  editorPaper: string;
  editorChrome: string;
  annotation: string;
  groupBackground: string;
  control: string;
  selection: string;
}

export interface ThemeDefinition {
  id: string;
  label: string;
  mode: 'light' | 'dark';
  tokens: ThemeTokens;
}

export interface ActiveTheme extends ThemeDefinition {
  owner: string;
}

export type ThemeTokenOverrides = Partial<ThemeTokens>;
