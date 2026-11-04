import type { PalettePreferences, PalettePresetId } from '../../protocols/appearance.ts';

export type { PalettePresetId } from '../../protocols/appearance.ts';

export interface PalettePreset {
  id: PalettePresetId;
  key: 'A' | 'B' | 'C';
  label: string;
  description: string;
  canvasBackground: string;
  connectionColor: string;
  junctionColor: string;
  preferences: PalettePreferences;
}

export const PALETTE_PRESETS: readonly PalettePreset[] = [
  {
    id: 'bright',
    key: 'A',
    label: '明调',
    description: '清爽白灰，适合明亮环境',
    canvasBackground: '#efefec',
    connectionColor: '#80858c', junctionColor: '#616b78',
    preferences: {
      themeId: 'light',
      editorBackground: '#f7f7f4',
      editorChromeBackground: '#ffffff',
      toolbarBackground: '#fafaf9',
      annotationColor: '#b9812e',
      groupBackground: '#75808d',
    },
  },
  {
    id: 'dark',
    key: 'B',
    label: '暗调',
    description: '低亮深灰，适合夜间使用',
    canvasBackground: '#18191b',
    connectionColor: '#8d98a7', junctionColor: '#bec9d6',
    preferences: {
      themeId: 'dark',
      editorBackground: '#202125',
      editorChromeBackground: '#25282e',
      toolbarBackground: '#1c1e23',
      annotationColor: '#dfb977',
      groupBackground: '#8294ab',
    },
  },
  {
    id: 'eye-care',
    key: 'C',
    label: '护眼',
    description: '柔和草木色，降低长时阅读刺激',
    canvasBackground: '#e4e8da',
    connectionColor: '#7b8672', junctionColor: '#5c6d51',
    preferences: {
      themeId: 'light',
      editorBackground: '#f1f3e9',
      editorChromeBackground: '#e8ecdf',
      toolbarBackground: '#eaf0e2',
      annotationColor: '#8c6b3d',
      groupBackground: '#6d7c64',
    },
  },
];
