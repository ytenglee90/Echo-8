'use client';

import type { ReactNode } from 'react';
import { Icon } from './Icon.tsx';

export function BrandLoadingMark({
  size = 52,
  className = '',
}: {
  size?: number;
  className?: string;
}) {
  return (
    <span className={`brand-loading-mark${className ? ` ${className}` : ''}`} aria-hidden="true">
      <Icon name="echo-8" size={size} motion="processing" />
    </span>
  );
}

export function ProcessingIndicator({
  size = 13,
  paused = false,
  className = '',
}: {
  size?: number;
  paused?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`processing-indicator${paused ? ' is-paused' : ''}${className ? ` ${className}` : ''}`}
      aria-hidden="true"
    >
      <Icon name="echo-8" size={size} motion="processing" />
    </span>
  );
}

export function ProcessingLabel({
  children,
  size,
  className = '',
}: {
  children: ReactNode;
  size?: number;
  className?: string;
}) {
  return (
    <span className={`processing-label${className ? ` ${className}` : ''}`}>
      <ProcessingIndicator size={size} />
      <span>{children}</span>
    </span>
  );
}
