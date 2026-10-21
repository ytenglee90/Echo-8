'use client';

import type { ViewClient } from '../../core/contracts.ts';
import { Icon } from '../../ui/Icon.tsx';

export function TextNodeEmptyState({ client }: { client: ViewClient }) {
  return (
    <section className="canvas-empty-state" aria-label="空白画布快捷操作">
      <Icon name="text" size={24} />
      <strong>从一个文本节点开始</strong>
      <span>也可以拖入 TXT、Word 文档或纯文本。</span>
      <button type="button" onClick={() => void client.dispatch('node.create')}>
        <Icon name="add" size={15} />
        创建第一个文本节点
      </button>
      <kbd>Ctrl/⌘ + Enter</kbd>
    </section>
  );
}
