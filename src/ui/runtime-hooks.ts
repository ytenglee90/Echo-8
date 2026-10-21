'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ViewClient } from '../core/contracts.ts';
import { commandTooltip } from './shortcut-presentation.ts';
import type {
  ContentCatalogDelta,
  ContentCatalogInvalidation,
  ContentSummary,
} from '../protocols/content.ts';

export function useCommandAvailability(client: ViewClient, type: string): boolean {
  useSyncExternalStore(client.subscribeCommands, client.getCommandVersion, () => 0);
  return client.isCommandAvailable(type);
}

export function useCommandTooltip(
  client: ViewClient,
  command: string,
  label: string,
): string {
  useSyncExternalStore(client.subscribeUI, client.getUIVersion, () => 0);
  return commandTooltip(
    { owner: client.owner, command, label },
    client.getShortcutsForCommand(command),
  );
}

export function useContentCatalog(client: ViewClient, options?: { geometryOnly?: boolean }): {
  summaries: ContentSummary[];
  byId: ReadonlyMap<string, ContentSummary>;
  geometryById: ReadonlyMap<string, ContentSummary>;
  unavailable: boolean;
} {
  const geometryOnly = options?.geometryOnly ?? false;
  const capabilityVersion = useSyncExternalStore(
    client.subscribeCapabilities,
    client.getCapabilityVersion,
    () => 0,
  );
  const [summaries, setSummaries] = useState<ContentSummary[]>([]);
  const [byId, setById] = useState<ReadonlyMap<string, ContentSummary>>(() => new Map());
  const [geometryById, setGeometryById] = useState<ReadonlyMap<string, ContentSummary>>(() => new Map());
  const [unavailable, setUnavailable] = useState(false);
  const catalog = useRef(new Map<string, ContentSummary>());
  const catalogVersion = useRef<number | undefined>(undefined);
  const multipleProviders = useRef(false);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const generation = useRef(0);

  const enqueueRefresh = (reset: boolean) => {
    const expectedGeneration = generation.current;
    queue.current = queue.current.catch(() => undefined).then(async () => {
      const deltas = await client.requestAll<ContentCatalogDelta>('content.catalog@2',
        reset || multipleProviders.current ? undefined : { sinceVersion: catalogVersion.current });
      if (generation.current !== expectedGeneration) return;
      if (deltas.length === 0) throw new Error('Content catalog unavailable');
      multipleProviders.current = deltas.length > 1;
      catalogVersion.current = deltas.length === 1 ? deltas[0].version : undefined;
      const merged = mergeContentCatalogDeltas(catalog.current, deltas);
      const geometryChanged = merged.geometryChanged;
      catalog.current = merged.catalog;
      if (geometryChanged || !geometryOnly) {
        const snapshot = new Map(catalog.current);
        setById(snapshot);
        setSummaries([...snapshot.values()]);
        if (geometryChanged) setGeometryById(snapshot);
      }
      setUnavailable(false);
    }).catch(() => {
      if (generation.current !== expectedGeneration) return;
      catalogVersion.current = undefined;
      catalog.current.clear();
      setById(new Map());
      setGeometryById(new Map());
      setSummaries([]);
      setUnavailable(true);
    });
  };

  useEffect(() => {
    generation.current += 1;
    catalogVersion.current = undefined;
    multipleProviders.current = false;
    enqueueRefresh(true);
    // enqueueRefresh intentionally reads the current generation and stable client.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capabilityVersion, client, geometryOnly]);

  useEffect(
    () => client.subscribeSignal<ContentCatalogInvalidation>('content.catalog.invalidated', (message) => {
      if (geometryOnly && !message.payload.geometry) return;
      enqueueRefresh(false);
    }),
    // enqueueRefresh intentionally serializes through refs and the stable client.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, geometryOnly],
  );

  useEffect(() => () => {
    generation.current += 1;
  }, []);

  return { summaries, byId, geometryById, unavailable };
}

export function applyCatalogDelta(
  current: readonly ContentSummary[],
  delta: ContentCatalogDelta,
): ContentSummary[] {
  if (delta.reset) return delta.summaries;
  if (delta.summaries.length === 0 && delta.removedIds.length === 0) return current as ContentSummary[];
  const byId = new Map(current.map((summary) => [summary.id, summary]));
  for (const id of delta.removedIds) byId.delete(id);
  for (const summary of delta.summaries) byId.set(summary.id, summary);
  return [...byId.values()];
}

export function mergeContentCatalogDeltas(
  current: ReadonlyMap<string, ContentSummary>,
  deltas: readonly ContentCatalogDelta[],
): { catalog: Map<string, ContentSummary>; geometryChanged: boolean } {
  const reset = deltas.length > 1 || deltas.some((delta) => delta.reset);
  const catalog = reset ? new Map<string, ContentSummary>() : new Map(current);
  let geometryChanged = reset;
  for (const delta of deltas) {
    for (const id of delta.removedIds) {
      geometryChanged ||= catalog.has(id);
      catalog.delete(id);
    }
    for (const summary of delta.summaries) {
      const previous = catalog.get(summary.id);
      geometryChanged ||= !previous || !sameGeometry(previous, summary);
      catalog.set(summary.id, summary);
    }
  }
  return { catalog, geometryChanged };
}

function sameGeometry(left: ContentSummary, right: ContentSummary): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}
