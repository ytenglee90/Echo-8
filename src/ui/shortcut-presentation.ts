import type { RegisteredShortcut } from '../core/contracts.ts';

export interface CommandPresentation {
  owner: string;
  command?: string;
  label: string;
  tooltip?: string;
}

export function commandTooltip(
  presentation: CommandPresentation,
  shortcuts: readonly RegisteredShortcut[],
): string {
  const base = stripShortcutSuffix(presentation.tooltip ?? presentation.label);
  if (!presentation.command) return base;
  const labels = shortcuts
    .filter((shortcut) =>
      shortcut.owner === presentation.owner &&
      shortcut.command === presentation.command &&
      shortcut.mode === 'press' &&
      !shortcut.disabled &&
      Boolean(shortcut.chord))
    .map((shortcut) => formatShortcutChord(shortcut.chord));
  const unique = [...new Set(labels)];
  return unique.length > 0 ? `${base}（${unique.join(' / ')}）` : base;
}

export function formatShortcutChord(chord: string): string {
  return chord
    .split('+')
    .filter(Boolean)
    .map((part) => SHORTCUT_PART_LABELS[part.toLocaleLowerCase('en-US')] ?? formatKey(part))
    .join(' + ');
}

export function stripShortcutSuffix(value: string): string {
  const match = value.match(/\s*[（(]([^（）()]*)[）)]\s*$/u);
  if (!match || !looksLikeShortcut(match[1])) return value;
  return value.slice(0, match.index).trimEnd();
}

const SHORTCUT_PART_LABELS: Readonly<Record<string, string>> = Object.freeze({
  mod: 'Ctrl/⌘',
  control: 'Ctrl',
  ctrl: 'Ctrl',
  meta: '⌘',
  command: '⌘',
  shift: 'Shift',
  alt: 'Alt',
  option: 'Alt',
  space: 'Space',
  escape: 'Esc',
  esc: 'Esc',
  enter: 'Enter',
  return: 'Enter',
  backspace: 'Backspace',
  delete: 'Delete',
  tab: 'Tab',
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
});

function formatKey(value: string): string {
  return value.length === 1 ? value.toLocaleUpperCase('en-US') : value;
}

function looksLikeShortcut(value: string): boolean {
  const compact = value.replaceAll(' ', '');
  return /(?:Ctrl|Command|Cmd|⌘|Alt|Option|Shift|Enter|Return|Delete|Backspace|Space|Esc|Tab|F\d{1,2})/iu
    .test(compact) || /^[a-z0-9=+-]$/iu.test(compact);
}
