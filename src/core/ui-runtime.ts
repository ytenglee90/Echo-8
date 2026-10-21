import type {
  ActionContribution,
  RegisteredAction,
  RegisteredShortcut,
  ShortcutContribution,
  ShortcutOverride,
  UIContribution,
  UISlot,
} from './contracts.ts';
import type { ActiveTheme, ThemeDefinition, ThemeTokenOverrides } from '../protocols/theme.ts';

const allowedSlots = new Set<UISlot>([
  'application.welcome',
  'top.primary',
  'top.contextual',
  'left.tools',
  'canvas.background',
  'canvas.empty',
  'canvas.entities',
  'canvas.groups',
  'canvas.content',
  'canvas.connections',
  'canvas.selection',
  'ai.settings',
  'ai.retrieval',
  'right.primary',
  'right.editor',
  'bottom.status',
  'overlay.floating',
  'overlay.modal',
  'editor.immersive.overlay',
  'command.palette',
]);

const exclusiveSurfaceSlots = new Set<UISlot>([
  'right.primary',
  'overlay.modal',
  'editor.immersive.overlay',
  'command.palette',
]);

const overlaySurfaceSlots = new Set<UISlot>(['overlay.modal', 'command.palette']);

interface OwnedContribution extends UIContribution {
  owner: string;
}

interface OwnedTheme extends ThemeDefinition {
  owner: string;
}

const CORE_THEME: ActiveTheme = Object.freeze({
  owner: 'core.ui',
  id: 'default-light',
  label: '默认浅色',
  mode: 'light',
  tokens: Object.freeze({
    surface: '#f5f5f3',
    panel: '#ffffff',
    panelSoft: 'rgba(255, 255, 255, 0.88)',
    ink: '#18181a',
    muted: '#707075',
    faint: '#a7a7ac',
    border: 'rgba(24, 24, 27, 0.11)',
    borderStrong: 'rgba(24, 24, 27, 0.2)',
    accent: '#202124',
    accentSoft: '#ececeb',
    success: '#27855a',
    danger: '#c83d43',
    toolbar: 'rgba(250, 250, 249, 0.92)',
    rail: '#fafaf9',
    status: '#fafaf9',
    canvas: '#efefec',
    canvasGrid: 'rgba(24, 24, 27, 0.15)',
    nodeSurface: 'rgba(255, 255, 255, 0.97)',
    editor: '#f1f1ef',
    editorPaper: '#ffffff',
    editorChrome: '#ffffff',
    annotation: '#ff9f0a',
    groupBackground: '#202124',
    control: '#f1f1ef',
    selection: '#111114',
  }),
});

export class UIRuntime {
  private readonly contributions = new Map<string, OwnedContribution>();
  private readonly actions = new Map<string, RegisteredAction>();
  private readonly shortcuts = new Map<string, RegisteredShortcut>();
  private readonly shortcutOverrides = new Map<string, ShortcutOverride[]>();
  private effectiveShortcuts = new Map<string, RegisteredShortcut>();
  private readonly themes = new Map<string, OwnedTheme>();
  private readonly surfaceStacks = new Map<UISlot, string[]>();
  private readonly surfaceCloseCommands = new Map<string, string>();
  private readonly surfaceActivationOrder = new Map<string, number>();
  private surfaceSequence = 0;
  private activeTheme: ActiveTheme = CORE_THEME;
  private readonly listeners = new Set<() => void>();
  private readonly keyboardListeners = new Set<() => void>();
  private readonly pressedKeys = new Set<string>();
  private keyboardVersion = 0;
  private readonly clockListeners = new Set<() => void>();
  private clockTimer?: ReturnType<typeof setInterval>;
  private clock = Date.now();
  private version = 0;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getVersion = (): number => this.version;

  subscribeKeyboard = (listener: () => void): (() => void) => {
    this.keyboardListeners.add(listener);
    return () => this.keyboardListeners.delete(listener);
  };

  getKeyboardVersion = (): number => this.keyboardVersion;

  isKeyPressed = (key: string): boolean => this.pressedKeys.has(normalizeKey(key));

  setKeyPressed(key: string, pressed: boolean): void {
    const normalized = normalizeKey(key);
    if (!normalized) return;
    const changed = pressed ? !this.pressedKeys.has(normalized) : this.pressedKeys.has(normalized);
    if (!changed) return;
    if (pressed) this.pressedKeys.add(normalized);
    else this.pressedKeys.delete(normalized);
    this.bumpKeyboard();
  }

  clearPressedKeys(): void {
    if (this.pressedKeys.size === 0) return;
    this.pressedKeys.clear();
    this.bumpKeyboard();
  }

  subscribeClock = (listener: () => void): (() => void) => {
    this.clockListeners.add(listener);
    if (!this.clockTimer) {
      this.clockTimer = setInterval(() => {
        this.clock = Date.now();
        for (const clockListener of this.clockListeners) clockListener();
      }, 1000);
    }
    return () => {
      this.clockListeners.delete(listener);
      if (this.clockListeners.size === 0 && this.clockTimer) {
        clearInterval(this.clockTimer);
        this.clockTimer = undefined;
      }
    };
  };

  getClock = (): number => this.clock;

  registerTheme(owner: string, definition: ThemeDefinition): () => void {
    validateTheme(definition);
    const key = `${owner}:${definition.id}`;
    if (this.themes.has(key)) throw new Error(`Duplicate theme: ${key}`);
    const theme = Object.freeze({ ...structuredClone(definition), owner });
    this.themes.set(key, theme);
    this.bump();
    return () => {
      if (!this.themes.delete(key)) return;
      if (this.activeTheme.owner === owner && this.activeTheme.id === definition.id) {
        this.activeTheme = CORE_THEME;
      }
      this.bump();
    };
  }

  activateTheme(owner: string, id: string, overrides: ThemeTokenOverrides = {}): void {
    const theme = this.themes.get(`${owner}:${id}`);
    if (!theme) throw new Error(`Theme unavailable: ${owner}:${id}`);
    for (const [key, value] of Object.entries(overrides)) {
      if (!(key in theme.tokens) || typeof value !== 'string' || value.length === 0) {
        throw new Error(`Invalid theme token override: ${key}`);
      }
    }
    this.activeTheme = Object.freeze({
      ...structuredClone(theme),
      tokens: Object.freeze({ ...theme.tokens, ...overrides }),
    });
    this.bump();
  }

  getActiveTheme = (): ActiveTheme => this.activeTheme;

  contribute(owner: string, contribution: UIContribution): () => void {
    if (!allowedSlots.has(contribution.slot)) throw new Error(`Unknown UI slot: ${contribution.slot}`);
    const key = `${owner}:${contribution.id}`;
    if (this.contributions.has(key)) throw new Error(`Duplicate UI contribution: ${key}`);
    const owned = Object.freeze({ ...contribution, owner });
    this.contributions.set(key, owned);
    this.bump();
    return () => {
      if (!this.contributions.delete(key)) return;
      this.removeSurfaceKey(key);
      this.bump();
    };
  }

  activateSurface(owner: string, slot: UISlot, contributionId: string, closeCommand?: string): void {
    if (!allowedSlots.has(slot)) throw new Error(`Unknown UI slot: ${slot}`);
    const key = `${owner}:${contributionId}`;
    const contribution = this.contributions.get(key);
    if (!contribution || contribution.slot !== slot) {
      throw new Error(`Surface contribution unavailable: ${key} in ${slot}`);
    }
    const globalTop = this.closableSurfaces()[0];
    const existingCloseCommand = this.surfaceCloseCommands.get(key);
    if (
      this.surfaceStacks.get(slot)?.at(-1) === key &&
      globalTop?.owner === owner && globalTop.id === contributionId && globalTop.slot === slot &&
      (!closeCommand || closeCommand === existingCloseCommand)
    ) return;
    const stack = (this.surfaceStacks.get(slot) ?? []).filter((item) => item !== key);
    stack.push(key);
    this.surfaceStacks.set(slot, stack);
    if (closeCommand) this.surfaceCloseCommands.set(key, closeCommand);
    this.surfaceActivationOrder.set(key, ++this.surfaceSequence);
    this.bump();
  }

  deactivateSurface(owner: string, slot: UISlot, contributionId: string): void {
    const key = `${owner}:${contributionId}`;
    const stack = this.surfaceStacks.get(slot);
    if (!stack) return;
    const next = stack.filter((item) => item !== key);
    if (next.length > 0) this.surfaceStacks.set(slot, next);
    else this.surfaceStacks.delete(slot);
    if (![...this.surfaceStacks.values()].some((items) => items.includes(key))) {
      this.surfaceCloseCommands.delete(key);
      this.surfaceActivationOrder.delete(key);
    }
    this.bump();
  }

  surfaceSnapshot(): Array<{ slot: UISlot; active?: string; stack: string[] }> {
    const slots = new Set<UISlot>([...exclusiveSurfaceSlots, ...this.surfaceStacks.keys()]);
    return [...slots].map((slot) => {
      const stack = [...(this.surfaceStacks.get(slot) ?? [])];
      return { slot, active: stack.at(-1), stack };
    });
  }

  topSurface(slots: UISlot[]): {
    owner: string;
    id: string;
    slot: UISlot;
    closeCommand?: string;
  } | undefined {
    const candidates = slots.flatMap((slot) => {
      const key = this.surfaceStacks.get(slot)?.at(-1);
      return key ? [{ slot, key, order: this.surfaceActivationOrder.get(key) ?? 0 }] : [];
    });
    const top = candidates.sort((left, right) => right.order - left.order)[0];
    if (!top) return undefined;
    const separator = top.key.indexOf(':');
    return {
      owner: top.key.slice(0, separator),
      id: top.key.slice(separator + 1),
      slot: top.slot,
      closeCommand: this.surfaceCloseCommands.get(top.key),
    };
  }

  closableSurfaces(): Array<{ owner: string; id: string; slot: UISlot; closeCommand: string }> {
    const results: Array<{ owner: string; id: string; slot: UISlot; closeCommand: string; order: number }> = [];
    for (const [slot, stack] of this.surfaceStacks) {
      for (const key of stack) {
        const closeCommand = this.surfaceCloseCommands.get(key);
        if (!closeCommand) continue;
        const separator = key.indexOf(':');
        results.push({
          owner: key.slice(0, separator),
          id: key.slice(separator + 1),
          slot,
          closeCommand,
          order: this.surfaceActivationOrder.get(key) ?? 0,
        });
      }
    }
    return results.sort((left, right) => right.order - left.order)
      .map((surface) => ({
        owner: surface.owner,
        id: surface.id,
        slot: surface.slot,
        closeCommand: surface.closeCommand,
      }));
  }

  registerAction(owner: string, contribution: ActionContribution): () => void {
    validateAction(contribution);
    const key = `${owner}:${contribution.id}`;
    if (this.actions.has(key)) throw new Error(`Duplicate action: ${key}`);
    const owned = Object.freeze({ ...structuredClone(contribution), owner });
    this.actions.set(key, owned);
    this.bump();
    return () => {
      if (this.actions.delete(key)) this.bump();
    };
  }

  registerShortcut(owner: string, shortcut: ShortcutContribution): () => void {
    const key = `${owner}:${shortcut.id}`;
    if (this.shortcuts.has(key)) throw new Error(`Duplicate shortcut: ${key}`);
    const mode = shortcut.mode ?? 'press';
    const baseChord = shortcut.chord?.trim() ? validateChord(shortcut.chord, mode === 'hold') : '';
    if (mode === 'press' && !shortcut.command?.trim()) {
      throw new Error(`Press shortcut ${key} has no command`);
    }
    const owned: RegisteredShortcut = {
      ...shortcut,
      mode,
      chord: baseChord,
      baseChord,
      overridden: false,
      disabled: false,
      owner,
    };
    this.shortcuts.set(key, owned);
    try {
      this.rebuildShortcuts();
    } catch (error) {
      this.shortcuts.delete(key);
      throw error;
    }
    this.bump();
    return () => {
      if (this.shortcuts.get(key) === owned) {
        this.shortcuts.delete(key);
        this.rebuildShortcuts();
        this.bump();
      }
    };
  }

  validateShortcutOverrides(owner: string, overrides: ShortcutOverride[]): ShortcutOverride[] {
    const normalized = normalizeOverrides(
      overrides,
      (target) => this.shortcuts.get(target)?.mode === 'hold',
    );
    const previous = this.shortcutOverrides.get(owner);
    this.shortcutOverrides.set(owner, normalized);
    try {
      this.buildEffectiveShortcuts();
    } finally {
      if (previous) this.shortcutOverrides.set(owner, previous);
      else this.shortcutOverrides.delete(owner);
    }
    return structuredClone(normalized);
  }

  setShortcutOverrides(owner: string, overrides: ShortcutOverride[]): void {
    const normalized = this.validateShortcutOverrides(owner, overrides);
    if (normalized.length > 0) this.shortcutOverrides.set(owner, normalized);
    else this.shortcutOverrides.delete(owner);
    this.rebuildShortcuts();
    this.bump();
  }

  clearShortcutOverrides(owner: string): void {
    if (!this.shortcutOverrides.delete(owner)) return;
    this.rebuildShortcuts();
    this.bump();
  }

  list(slot: UISlot): OwnedContribution[] {
    const activeSurface = this.activeSurfaceFor(slot);
    return [...this.contributions.values()]
      .filter((item) => item.slot === slot)
      .filter((item) => !activeSurface || `${item.owner}:${item.id}` === activeSurface)
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || a.id.localeCompare(b.id));
  }

  matchShortcut(event: KeyboardEvent): RegisteredShortcut | undefined {
    const shortcut = this.effectiveShortcuts.get(chordFromEvent(event));
    return shortcut?.mode === 'press' ? shortcut : undefined;
  }

  isShortcutPressed(owner: string, id: string): boolean {
    const shortcut = [...this.effectiveShortcuts.values()].find(
      (candidate) => candidate.owner === owner && candidate.id === id,
    );
    if (!shortcut || shortcut.mode !== 'hold') return false;
    return shortcut.chord.split('+').every((part) => {
      if (part === 'mod') return this.pressedKeys.has('control') || this.pressedKeys.has('meta');
      return this.pressedKeys.has(part);
    });
  }

  listShortcuts(): RegisteredShortcut[] {
    const overrides = this.resolveShortcutOverrides();
    return [...this.shortcuts.entries()]
      .map(([target, shortcut]) => {
        const override = overrides.get(target)?.override;
        const chord = override?.disabled === true ? '' : override?.chord ?? shortcut.baseChord;
        return structuredClone({
          ...shortcut,
          chord,
          overridden: Boolean(override),
          disabled: !chord,
        });
      })
      .sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'));
  }

  listActions(): RegisteredAction[] {
    return [...this.actions.values()]
      .map((action) => structuredClone(action))
      .sort((left, right) =>
        (left.priority ?? 0) - (right.priority ?? 0) || left.label.localeCompare(right.label, 'zh-CN'),
      );
  }

  getAction(owner: string, id: string): RegisteredAction | undefined {
    const action = this.actions.get(`${owner}:${id}`);
    return action ? structuredClone(action) : undefined;
  }

  private rebuildShortcuts(): void {
    this.effectiveShortcuts = this.buildEffectiveShortcuts();
  }

  private buildEffectiveShortcuts(): Map<string, RegisteredShortcut> {
    const byTarget = this.resolveShortcutOverrides();
    const effective = new Map<string, RegisteredShortcut>();
    for (const [target, shortcut] of this.shortcuts) {
      const override = byTarget.get(target)?.override;
      if (override?.disabled === true) continue;
      const chord = override?.chord ?? shortcut.baseChord;
      if (!chord) continue;
      const existing = effective.get(chord);
      if (existing) {
        throw new Error(`Shortcut conflict: ${chord} (${existing.owner}, ${shortcut.owner})`);
      }
      effective.set(chord, {
        ...shortcut,
        chord,
        overridden: Boolean(override),
        disabled: false,
      });
    }
    return effective;
  }

  private resolveShortcutOverrides(): Map<string, { controller: string; override: ShortcutOverride }> {
    const byTarget = new Map<string, { controller: string; override: ShortcutOverride }>();
    for (const [controller, overrides] of this.shortcutOverrides) {
      for (const override of overrides) {
        const target = `${override.targetOwner}:${override.targetId}`;
        const previous = byTarget.get(target);
        if (previous && previous.controller !== controller) {
          throw new Error(`Shortcut override conflict: ${target} (${previous.controller}, ${controller})`);
        }
        byTarget.set(target, { controller, override });
      }
    }
    return byTarget;
  }

  private bump(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  private bumpKeyboard(): void {
    this.keyboardVersion += 1;
    for (const listener of this.keyboardListeners) listener();
  }

  private removeSurfaceKey(key: string): void {
    for (const [slot, stack] of this.surfaceStacks) {
      const next = stack.filter((item) => item !== key);
      if (next.length > 0) this.surfaceStacks.set(slot, next);
      else this.surfaceStacks.delete(slot);
    }
    this.surfaceCloseCommands.delete(key);
    this.surfaceActivationOrder.delete(key);
  }

  private activeSurfaceFor(slot: UISlot): string | undefined {
    if (!exclusiveSurfaceSlots.has(slot)) return undefined;
    if (!overlaySurfaceSlots.has(slot)) return this.surfaceStacks.get(slot)?.at(-1);
    const top = this.topSurface([...overlaySurfaceSlots]);
    return top?.slot === slot ? `${top.owner}:${top.id}` : '__surface-owned-by-other-overlay-slot__';
  }
}

function validateAction(action: ActionContribution): void {
  if (!/^[a-z0-9.-]+$/u.test(action.id)) throw new Error(`Invalid action id: ${action.id}`);
  if (!action.label.trim()) throw new Error(`Action ${action.id} has no label`);
  if (!action.command.trim()) throw new Error(`Action ${action.id} has no command`);
  if (!action.category.trim()) throw new Error(`Action ${action.id} has no category`);
}

function normalizeOverrides(
  overrides: ShortcutOverride[],
  allowsModifierOnly: (target: string) => boolean,
): ShortcutOverride[] {
  const targets = new Set<string>();
  return overrides.map((override) => {
    if (!override.targetOwner || !override.targetId) throw new Error('快捷键覆盖缺少目标');
    const target = `${override.targetOwner}:${override.targetId}`;
    if (targets.has(target)) throw new Error(`Duplicate shortcut override: ${target}`);
    targets.add(target);
    if (override.disabled === true) {
      if (override.chord !== undefined && override.chord.trim()) {
        throw new Error(`Disabled shortcut override cannot define a chord: ${target}`);
      }
      return { targetOwner: override.targetOwner, targetId: override.targetId, disabled: true };
    }
    if (typeof override.chord !== 'string') throw new Error(`Shortcut override has no chord: ${target}`);
    return {
      targetOwner: override.targetOwner,
      targetId: override.targetId,
      chord: validateChord(override.chord, allowsModifierOnly(target)),
    };
  });
}

function validateTheme(theme: ThemeDefinition): void {
  if (!/^[a-z0-9-]+$/u.test(theme.id)) throw new Error(`Invalid theme id: ${theme.id}`);
  if (!theme.label.trim()) throw new Error(`Theme ${theme.id} has no label`);
  if (theme.mode !== 'light' && theme.mode !== 'dark') throw new Error(`Invalid theme mode: ${theme.id}`);
  const required = Object.keys(CORE_THEME.tokens) as Array<keyof ThemeDefinition['tokens']>;
  for (const key of required) {
    if (typeof theme.tokens[key] !== 'string' || theme.tokens[key].length === 0) {
      throw new Error(`Theme ${theme.id} is missing token ${key}`);
    }
  }
}

function normalizeChord(chord: string): string {
  return chord
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .sort((a, b) => modifierRank(a) - modifierRank(b) || a.localeCompare(b))
    .join('+');
}

function validateChord(chord: string, allowModifierOnly = false): string {
  const normalized = normalizeChord(chord);
  const parts = normalized.split('+').filter(Boolean);
  const modifierOnly = parts.every((part) => ['mod', 'control', 'meta', 'alt', 'shift'].includes(part));
  if (parts.length === 0 || (!allowModifierOnly && modifierOnly)) {
    throw new Error(`Invalid shortcut chord: ${chord}`);
  }
  return normalized;
}

function chordFromEvent(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push('mod');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  const key = event.key === ' ' ? 'space' : event.key.toLowerCase();
  if (!['control', 'meta', 'alt', 'shift'].includes(key)) parts.push(key);
  return normalizeChord(parts.join('+'));
}

function normalizeKey(key: string): string {
  return key === ' ' ? 'space' : key.trim().toLowerCase();
}

function modifierRank(value: string): number {
  return value === 'mod' ? 0 : value === 'alt' ? 1 : value === 'shift' ? 2 : 3;
}
