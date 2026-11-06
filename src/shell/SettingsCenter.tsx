'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { UIContribution } from '../core/contracts.ts';
import { Icon } from '../ui/Icon.tsx';

type PageContribution = UIContribution & { owner: string };

/** Layout only: owners supply pages and execute their own registered commands. */
export function SettingsCenter({ pages, active, onOpen, onReturnFocus, children }: {
  pages: PageContribution[];
  active: PageContribution;
  onOpen: (page: PageContribution) => Promise<unknown>;
  onReturnFocus: () => void;
  children: ReactNode;
}) {
  const [error, setError] = useState('');
  const content = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    previousFocus.current = document.activeElement as HTMLElement | null;
    return () => {
      const target = previousFocus.current;
      if (target?.isConnected && target !== document.body && target !== document.documentElement) target.focus();
      else onReturnFocus();
    };
  }, [onReturnFocus]);
  useEffect(() => {
    // Direct commands and keyboard shortcuts land on the active page heading.
    // Category clicks retain navigation focus for predictable keyboard traversal.
    if (!document.activeElement?.closest('.settings-navigation')) content.current?.focus();
    content.current?.scrollTo(0, 0);
  }, [active.owner, active.id]);

  return (
    <section className="settings-center" aria-label="设置中心">
      <div className="settings-sidebar">
        <div className="settings-center-title"><Icon name="settings" /><h2>设置</h2></div>
        <nav className="settings-navigation" aria-label="设置分类">
          {pages.map((page) => (
            <button
              type="button"
              key={`${page.owner}:${page.id}`}
              aria-current={page.owner === active.owner && page.id === active.id ? 'page' : undefined}
              onClick={() => {
                setError('');
                void onOpen(page).catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
              }}
            >
              <Icon name={page.settings!.icon} size={16} />
              <span>{page.settings!.label}</span>
            </button>
          ))}
        </nav>
      </div>
      <div className="settings-content" ref={content} tabIndex={-1} aria-label={active.settings!.label}>
        {error && <p className="settings-navigation-error" role="alert">{error}</p>}
        {children}
      </div>
    </section>
  );
}
