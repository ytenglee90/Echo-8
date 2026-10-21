import type { PalettePreferences } from '../../protocols/appearance.ts';

export type PalettePresetId = 'bright' | 'dark' | 'eye-care';

export interface PalettePreset {
  id: PalettePresetId;
  key: 'A' | 'B' | 'C';
  label: string;
  description: string;
  canvasBackground: string;
  preferences: PalettePreferences;
}

export const PALETTE_PRESETS: readonly PalettePreset[] = [
  {
    id: 'bright',
    key: 'A',
    label: '明调',
    description: '清爽白灰，适合明亮环境',
    canvasBackground: '#efefec',
    preferences: {
      themeId: 'light',
      editorBackground: '#f1f1ef',
      editorChromeBackground: '#ffffff',
      toolbarBackground: '#fafaf9',
      annotationColor: '#ff9f0a',
      groupBackground: '#202124',
    },
  },
  {
    id: 'dark',
    key: 'B',
    label: '暗调',
    description: '低亮深灰，适合夜间使用',
    canvasBackground: '#18191b',
    preferences: {
      themeId: 'dark',
      editorBackground: '#202125',
      editorChromeBackground: '#1b1c1f',
      toolbarBackground: '#141517',
      annotationColor: '#ffb340',
      groupBackground: '#f1f1f2',
    },
  },
  {
    id: 'eye-care',
    key: 'C',
    label: '护眼',
    description: '柔和草木色，降低长时阅读刺激',
    canvasBackground: '#e4e8da',
    preferences: {
      themeId: 'light',
      editorBackground: '#f0f2e8',
      editorChromeBackground: '#e8ecdf',
      toolbarBackground: '#e3e8d9',
      annotationColor: '#78964d',
      groupBackground: '#536b52',
    },
  },
];
