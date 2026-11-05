import type { ShortcutOverride } from '../core/contracts.ts';

/** Personal account settings, never part of a shared book document. */
export interface PersonalShortcutsSnapshot { overrides: ShortcutOverride[] }
declare module './commands.ts' {
  interface ApplicationCommandMap {
    'shortcuts.applyAccountSettings': CommandContract<PersonalShortcutsSnapshot, { count: number }>;
  }
}
