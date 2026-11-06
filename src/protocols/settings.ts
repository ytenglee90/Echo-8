/** Declarative, runtime-only navigation metadata; never stored in a book. */
export interface SettingsPageContributionV1 {
  version: 1;
  label: string;
  icon: string;
  order: number;
  /** A payload-free command owned by the contributing plugin. */
  openCommand: string;
}

declare module './commands.ts' {
  interface ApplicationCommandMap {
    'system.ui.openSettings@1': CommandContract<undefined, { opened: boolean }>;
  }
}
