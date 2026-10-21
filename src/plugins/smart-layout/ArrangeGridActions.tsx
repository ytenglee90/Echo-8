'use client';

import { useEffect, useRef, useState } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import { IconButton, type IconName } from '../../ui/Icon.tsx';
import { useCommandTooltip } from '../../ui/runtime-hooks.ts';
import type { ArrangeMode } from '../../protocols/layout.ts';

export function ArrangeGridActions({ client }: { client: ViewClient }) {
  const tooltip = useCommandTooltip(
    client,
    'node.arrangeSelectedCycle',
    '自动排列（连续点击：宫格 → 横排 → 竖排）',
  );
  const [nextMode, setNextMode] = useState<ArrangeMode>('grid');
  const resetTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(resetTimer.current), []);
  const icon: IconName = nextMode === 'grid'
    ? 'grid'
    : nextMode === 'horizontal'
      ? 'grid-horizontal'
      : 'grid-vertical';
  return (
    <div className="canvas-tool-actions" aria-label="自动排列">
      <IconButton
        icon={icon}
        label={tooltip}
        className="icon-button toolbar-tool-button"
        onClick={() => {
          void client.dispatch('node.arrangeSelectedCycle').then((result) => {
            setNextMode(result.nextMode);
            window.clearTimeout(resetTimer.current);
            resetTimer.current = window.setTimeout(() => setNextMode('grid'), result.resetAfterMs);
          });
        }}
      />
    </div>
  );
}
