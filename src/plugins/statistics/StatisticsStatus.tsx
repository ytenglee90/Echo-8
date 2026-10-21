'use client';

import { useEffect, useState } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import type { SelectedTextStatistics } from '../../protocols/statistics.ts';

export function StatisticsStatus({ client }: { client: ViewClient }) {
  const [reloadToken, setReloadToken] = useState(0);
  const [selectedTextNodes, setSelectedTextNodes] = useState(0);
  const [selectedCharacters, setSelectedCharacters] = useState(0);

  useEffect(
    () => client.subscribeSignal('statistics.selection.invalidated', () => {
      setReloadToken((value) => value + 1);
    }),
    [client],
  );

  useEffect(() => {
    const controller = new AbortController();
    void client.request<SelectedTextStatistics>('statistics.selected@1', undefined, controller.signal).then((selected) => {
      if (controller.signal.aborted) return;
      setSelectedTextNodes(selected.nodeCount);
      setSelectedCharacters(selected.nonWhitespaceGraphemes);
    }).catch(() => {
      if (controller.signal.aborted) return;
      setSelectedTextNodes(0);
      setSelectedCharacters(0);
    });
    return () => controller.abort();
  }, [client, reloadToken]);

  return (
    <span
      className="toolbar-statistics"
      title={`已选文字节点总数 ${selectedTextNodes.toLocaleString()}；已选节点正文字数 ${selectedCharacters.toLocaleString()}（包含标点和组合 Emoji，不含空格、制表符和换行）`}
      aria-live="polite"
    >
      {selectedTextNodes.toLocaleString()} / {selectedCharacters.toLocaleString()}
    </span>
  );
}
