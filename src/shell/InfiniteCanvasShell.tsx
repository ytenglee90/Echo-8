'use client';

import {
  type CSSProperties,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { RegisteredShortcut, UIContribution, UISlot, ViewClient } from '../core/contracts.ts';
import type { ApplicationKernel } from '../core/kernel.ts';
import { contrastingInk } from '../ui/color-contrast.ts';
import { scrollHorizontalOverflow } from '../ui/horizontal-overflow.ts';
import { Icon } from '../ui/Icon.tsx';
import { commandTooltip } from '../ui/shortcut-presentation.ts';
import { useNonPassiveWheel } from '../ui/use-non-passive-wheel.ts';
import { PluginBoundary } from './PluginBoundary.tsx';
import { TaskNoticeCenter } from './TaskNoticeCenter.tsx';

type PluginView = ComponentType<{
  client: ViewClient;
  renderSlot?: (slot: UISlot) => ReactNode;
}>;

export function InfiniteCanvasShell({ kernel }: { kernel: ApplicationKernel }) {
  const uiVersion = useSyncExternalStore(kernel.ui.subscribe.bind(kernel.ui), kernel.ui.getVersion, () => 0);
  const theme = kernel.ui.getActiveTheme();
  const themeStyle = toThemeStyle(theme.tokens);

  useEffect(() => {
    const localizedEvents = new WeakSet<Event>();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (localizedEvents.has(event)) return;
      // The input method owns every key until it commits the composition.
      // In particular Enter/Escape must not leak into app shortcuts while a
      // Chinese candidate is still being selected.
      if (event.isComposing || event.key === 'Process') return;
      const target = event.target as HTMLElement | null;
      const editable = Boolean(target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'));
      const ownsLocalHistory = editable && Boolean(target?.closest('[data-local-history="true"]'));
      const hoveredRegion = [...globalThis.document?.querySelectorAll<HTMLElement>('[data-keyboard-region]') ?? []]
        .filter((region) => region.matches(':hover'))
        .at(-1);
      if (!editable && hoveredRegion && !hoveredRegion.contains(target)) {
        const localized = new KeyboardEvent('keydown', {
          key: event.key,
          code: event.code,
          location: event.location,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          metaKey: event.metaKey,
          repeat: event.repeat,
          bubbles: true,
          cancelable: true,
          composed: true,
        });
        localizedEvents.add(localized);
        hoveredRegion.dispatchEvent(localized);
        if (localized.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }
      if (!editable) kernel.ui.setKeyPressed(event.key, true);
      if (ownsLocalHistory && isNativeHistoryShortcut(event)) return;
      // A real DOM text selection owns Copy. Without this guard the canvas's
      // governed Ctrl/Cmd+C shortcut would replace native chat-copy behavior.
      if (isNativeSelectionCopy(event)) return;
      const shortcut = kernel.ui.matchShortcut(event);
      if (editable && !shortcut?.allowInEditable) return;
      if (!editable && event.key === ' ') event.preventDefault();
      if (!shortcut?.command) return;
      event.preventDefault();
      void kernel.createViewClient(shortcut.owner).dispatch(shortcut.command, undefined);
    };
    const handleKeyUp = (event: KeyboardEvent) => kernel.ui.setKeyPressed(event.key, false);
    const handleBlur = () => kernel.ui.clearPressedKeys();
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    const remove = () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
      kernel.ui.clearPressedKeys();
    };
    const untrack = kernel.resources.track('core.shell', 'listener', remove);
    return () => {
      remove();
      untrack();
    };
  }, [kernel]);

  useEffect(() => {
    const modalSurface = kernel.ui.topSurface([
      'overlay.modal',
      'editor.immersive.overlay',
      'command.palette',
    ]);
    const previousFocus = globalThis.document?.activeElement as HTMLElement | null;
    const surfaceKey = modalSurface ? `${modalSurface.owner}:${modalSurface.id}` : undefined;
    let fullscreenWasActive = Boolean(globalThis.document?.fullscreenElement);
    let immersiveEscapePending = false;

    if (surfaceKey) {
      queueMicrotask(() => {
        const root = findSurfaceRoot(surfaceKey);
        if (!root || root.contains(globalThis.document?.activeElement ?? null)) return;
        focusableElements(root)[0]?.focus();
      });
    }

    const handleSurfaceKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !surfaceKey) return;
      const root = findSurfaceRoot(surfaceKey);
      if (!root) return;
      const focusable = focusableElements(root);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && globalThis.document?.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && globalThis.document?.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const dispatchManagedEscape = async () => {
      const activeSurface = kernel.ui.topSurface([
        'overlay.modal',
        'editor.immersive.overlay',
        'command.palette',
      ]);
      const exitsImmersive = activeSurface?.id === 'editor.immersive';
      if (exitsImmersive && immersiveEscapePending) return;
      if (exitsImmersive) immersiveEscapePending = true;
      try {
        await kernel.router.dispatch('system.ui.escape', undefined, 'core.ui');
        if (exitsImmersive && globalThis.document?.fullscreenElement) {
          await globalThis.document.exitFullscreen().catch(() => undefined);
        }
      } finally {
        if (exitsImmersive) immersiveEscapePending = false;
      }
    };
    const handleEscapeKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      void dispatchManagedEscape();
    };
    const handleFullscreenChange = () => {
      const fullscreenActive = Boolean(globalThis.document?.fullscreenElement);
      const nativeFullscreenWasDismissed = fullscreenWasActive && !fullscreenActive;
      fullscreenWasActive = fullscreenActive;
      if (!nativeFullscreenWasDismissed || immersiveEscapePending) return;
      if (kernel.ui.topSurface(['overlay.modal'])?.id !== 'editor.immersive') return;
      void dispatchManagedEscape();
    };
    globalThis.document?.addEventListener('keydown', handleSurfaceKey, true);
    globalThis.document?.addEventListener('keydown', handleEscapeKey);
    globalThis.document?.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      globalThis.document?.removeEventListener('keydown', handleSurfaceKey, true);
      globalThis.document?.removeEventListener('keydown', handleEscapeKey);
      globalThis.document?.removeEventListener('fullscreenchange', handleFullscreenChange);
      if (modalSurface && previousFocus?.isConnected) queueMicrotask(() => previousFocus.focus());
    };
  }, [kernel, uiVersion]);

  const topContributions = kernel.listUI('top.primary');
  const shortcuts = kernel.ui.listShortcuts();
  const rightPrimaryOpen = Boolean(kernel.ui.topSurface(['right.primary']));
  const groups = [
    ['file', '文件与命令'],
    ['create', '新建'],
    ['assist', '辅助工具'],
    ['history', '撤销与重做'],
    ['tools', '画布工具'],
    ['edit', '编辑'],
    ['appearance', '选中项工具'],
    ['clipboard', '剪贴板'],
    ['status', '画布状态'],
    ['metrics', '文字统计'],
  ] as const;

  return (
    <main
      className="application-shell"
      data-theme={theme.mode}
      data-right-primary-open={rightPrimaryOpen ? 'true' : 'false'}
      style={themeStyle}
    >
      <div className="welcome-layer">
        <Slot kernel={kernel} slot="application.welcome" />
      </div>
      <header className="top-bar">
        <PrimaryToolbar>
          {groups.map(([group, label]) => {
            const contributions = topContributions.filter((item) => item.group === group);
            if (contributions.length === 0) return null;
            return (
              <div className="toolbar-group" role="group" aria-label={label} key={group}>
                {contributions.map((contribution) => (
                  <TopContribution
                    contribution={contribution}
                    kernel={kernel}
                    shortcuts={shortcuts}
                    key={`${contribution.owner}:${contribution.id}`}
                  />
                ))}
              </div>
            );
          })}
        </PrimaryToolbar>
      </header>

      <section className="canvas-host" onPointerDownCapture={(event) => releaseExternalEditableFocus(event.currentTarget)}>
        <Slot kernel={kernel} slot="canvas.background" />
        <Slot kernel={kernel} slot="canvas.groups" />
        <Slot kernel={kernel} slot="canvas.connections" />
        <Slot kernel={kernel} slot="canvas.content" />
        <Slot kernel={kernel} slot="canvas.selection" />
      </section>

      <aside className="right-rail">
        <Slot kernel={kernel} slot="right.editor" />
        <Slot kernel={kernel} slot="right.primary" />
      </aside>

      <div className="floating-layer">
        <Slot kernel={kernel} slot="overlay.floating" />
      </div>
      <div className="modal-layer">
        <Slot kernel={kernel} slot="overlay.modal" />
        <Slot kernel={kernel} slot="command.palette" />
      </div>
      <div className="task-notice-layer" aria-live="polite">
        <TaskNoticeCenter
          scheduler={kernel.tasks}
          persistence={kernel.persistence}
          client={kernel.createViewClient('core.shell')}
        />
      </div>
    </main>
  );
}

function PrimaryToolbar({ children }: { children: ReactNode }) {
  const actionsRef = useRef<HTMLElement>(null);
  const [canRewind, setCanRewind] = useState(false);
  const [canAdvance, setCanAdvance] = useState(false);
  const updateOverflow = useCallback(() => {
    const actions = actionsRef.current;
    if (!actions) return;
    const remaining = actions.scrollWidth - actions.clientWidth - actions.scrollLeft;
    setCanRewind(actions.scrollLeft > 1);
    setCanAdvance(remaining > 1);
  }, []);

  useNonPassiveWheel(actionsRef, (event) => {
    const actions = actionsRef.current;
    if (!actions || !scrollHorizontalOverflow(actions, event)) return;
    event.preventDefault();
    updateOverflow();
  });

  useEffect(() => {
    updateOverflow();
  });

  useEffect(() => {
    const actions = actionsRef.current;
    if (!actions) return undefined;
    const observer = typeof ResizeObserver === 'function'
      ? new ResizeObserver(updateOverflow)
      : undefined;
    observer?.observe(actions);
    globalThis.addEventListener?.('resize', updateOverflow);
    return () => {
      observer?.disconnect();
      globalThis.removeEventListener?.('resize', updateOverflow);
    };
  }, [updateOverflow]);

  return (
    <div className={[
      'primary-toolbar-shell',
      canRewind ? 'has-backward-overflow' : '',
      canAdvance ? 'has-forward-overflow' : '',
    ].filter(Boolean).join(' ')}>
      <nav
        ref={actionsRef}
        className="primary-actions"
        aria-label="主工具栏"
        onScroll={updateOverflow}
      >
        {children}
      </nav>
      {canRewind ? (
        <button
          type="button"
          className="toolbar-overflow-button toolbar-overflow-previous"
          aria-label="返回左侧工具"
          title="返回左侧工具"
          onClick={() => {
            const actions = actionsRef.current;
            if (!actions) return;
            actions.scrollBy({ left: -Math.max(160, actions.clientWidth * 0.72), behavior: 'smooth' });
          }}
        >
          <Icon name="chevron-left" />
        </button>
      ) : null}
      {canAdvance ? (
        <button
          type="button"
          className="toolbar-overflow-button toolbar-overflow-next"
          aria-label="显示右侧更多工具"
          title="显示右侧更多工具"
          onClick={() => {
            const actions = actionsRef.current;
            if (!actions) return;
            actions.scrollBy({ left: Math.max(160, actions.clientWidth * 0.72), behavior: 'smooth' });
          }}
        >
          <Icon name="chevron-right" />
        </button>
      ) : null}
    </div>
  );
}

function TopContribution({
  kernel,
  contribution,
  shortcuts,
}: {
  kernel: ApplicationKernel;
  contribution: UIContribution & { owner: string };
  shortcuts: RegisteredShortcut[];
}) {
  if (contribution.kind === 'button') {
    return (
      <button
        type="button"
        className={`toolbar-icon-button ${contribution.id.includes('create') ? 'primary' : ''}`}
        aria-label={contribution.label}
        title={commandTooltip(contribution, shortcuts)}
        onPointerDown={contribution.preserveEditableFocus ? (event) => event.preventDefault() : undefined}
        onClick={() =>
          contribution.command &&
          void kernel.createViewClient(contribution.owner).dispatch(contribution.command, undefined)
        }
      >
        <Icon name={contribution.icon ?? 'more'} />
      </button>
    );
  }

  const View = contribution.component as PluginView | undefined;
  if (!View) return null;
  const client = kernel.createViewClient(contribution.owner);
  const reportError = (owner: string, error: Error, info: ErrorInfo) => {
    kernel.diagnostics.record('error', owner, 'Plugin UI crashed', { error: error.message, stack: info.componentStack });
  };
  return (
    <div
      className="ui-contribution-root"
      data-ui-contribution={`${contribution.owner}:${contribution.id}`}
    >
      <PluginBoundary owner={contribution.owner} onError={reportError}>
        <View client={client} renderSlot={(slot) => <Slot kernel={kernel} slot={slot} />} />
      </PluginBoundary>
    </div>
  );
}

function toThemeStyle(tokens: ReturnType<ApplicationKernel['ui']['getActiveTheme']>['tokens']): CSSProperties {
  const panelInk = contrastingInk(tokens.panel);
  const toolbarInk = contrastingInk(tokens.toolbar);
  const editorChromeInk = contrastingInk(tokens.editorChrome);
  const editorPaperInk = contrastingInk(tokens.editorPaper);
  const annotationInk = contrastingInk(tokens.annotation);
  return {
    '--surface': tokens.surface,
    '--panel': tokens.panel,
    '--panel-soft': tokens.panelSoft,
    '--panel-ink': panelInk,
    '--panel-muted': `color-mix(in srgb, ${panelInk} 68%, transparent)`,
    '--panel-faint': `color-mix(in srgb, ${panelInk} 46%, transparent)`,
    '--panel-border': `color-mix(in srgb, ${panelInk} 18%, transparent)`,
    '--panel-border-strong': `color-mix(in srgb, ${panelInk} 28%, transparent)`,
    '--panel-hover': `color-mix(in srgb, ${panelInk} 10%, transparent)`,
    '--ink': tokens.ink,
    '--muted': tokens.muted,
    '--faint': tokens.faint,
    '--border': tokens.border,
    '--border-strong': tokens.borderStrong,
    '--accent': tokens.accent,
    '--accent-soft': tokens.accentSoft,
    '--success': tokens.success,
    '--danger': tokens.danger,
    '--toolbar': tokens.toolbar,
    '--toolbar-ink': toolbarInk,
    '--toolbar-muted': `color-mix(in srgb, ${toolbarInk} 68%, transparent)`,
    '--toolbar-border': `color-mix(in srgb, ${toolbarInk} 18%, transparent)`,
    '--toolbar-hover': `color-mix(in srgb, ${toolbarInk} 10%, transparent)`,
    '--toolbar-active-surface': toolbarInk,
    '--toolbar-active-ink': tokens.toolbar,
    '--rail': tokens.rail,
    '--status': tokens.status,
    '--canvas-background': tokens.canvas,
    '--canvas-grid': tokens.canvasGrid,
    '--node-surface': tokens.nodeSurface,
    '--editor-background': tokens.editor,
    '--editor-paper': tokens.editorPaper,
    '--editor-paper-ink': editorPaperInk,
    '--editor-chrome': tokens.editorChrome,
    '--editor-chrome-ink': editorChromeInk,
    '--editor-chrome-muted': `color-mix(in srgb, ${editorChromeInk} 68%, transparent)`,
    '--editor-chrome-border': `color-mix(in srgb, ${editorChromeInk} 18%, transparent)`,
    '--editor-chrome-hover': `color-mix(in srgb, ${editorChromeInk} 10%, transparent)`,
    '--editor-chrome-active-surface': editorChromeInk,
    '--editor-chrome-active-ink': tokens.editorChrome,
    '--annotation-color': tokens.annotation,
    '--annotation-ink': annotationInk,
    '--group-background': tokens.groupBackground,
    '--control-surface': tokens.control,
    '--selection': tokens.selection,
  } as CSSProperties;
}

function Slot({ kernel, slot }: { kernel: ApplicationKernel; slot: UISlot }) {
  const contributions = kernel.listUI(slot).filter((item) => item.kind !== 'button');
  const clients = useMemo(
    () => new Map(contributions.map((item) => [item.owner, kernel.createViewClient(item.owner)])),
    [contributions, kernel],
  );
  const reportError = (owner: string, error: Error, info: ErrorInfo) => {
    kernel.diagnostics.record('error', owner, 'Plugin UI crashed', { error: error.message, stack: info.componentStack });
  };

  return contributions.map((contribution) => {
    const View = contribution.component as PluginView | undefined;
    if (!View) return null;
    return (
      <div
        className="ui-contribution-root"
        data-ui-contribution={`${contribution.owner}:${contribution.id}`}
        data-ui-slot={slot}
        key={`${contribution.owner}:${contribution.id}`}
      >
        <PluginBoundary
          owner={contribution.owner}
          onError={reportError}
        >
          <View
            client={clients.get(contribution.owner)!}
            renderSlot={(embeddedSlot) => <Slot kernel={kernel} slot={embeddedSlot} />}
          />
        </PluginBoundary>
      </div>
    );
  });
}

function findSurfaceRoot(key: string): HTMLElement | null {
  return globalThis.document?.querySelector<HTMLElement>(`[data-ui-contribution="${key}"]`) ?? null;
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), ' +
    '[href], [tabindex]:not([tabindex="-1"]), [contenteditable]:not([contenteditable="false"])',
  )].filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
}

function isNativeHistoryShortcut(event: KeyboardEvent): boolean {
  if (!event.ctrlKey && !event.metaKey) return false;
  return event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y';
}

function isNativeSelectionCopy(event: KeyboardEvent): boolean {
  if ((!event.ctrlKey && !event.metaKey) || event.altKey || event.key.toLowerCase() !== 'c') return false;
  const selection = globalThis.getSelection?.();
  return Boolean(selection && !selection.isCollapsed && selection.toString().length > 0);
}

function releaseExternalEditableFocus(canvasHost: HTMLElement): void {
  const active = globalThis.document?.activeElement;
  if (!(active instanceof HTMLElement) || canvasHost.contains(active)) return;
  if (!active.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
  active.blur();
}
