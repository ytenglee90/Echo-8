import type {
  CSSProperties,
} from 'react';
import { useEffect, useState } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import type { ContentSummary } from '../../protocols/content.ts';
import type { SearchMatchPreview } from '../../protocols/search.ts';
import {
  useCanvasEntityLayerRuntime,
  type CanvasEntityCharacterCount,
} from '../../ui/canvas-entity-layer-runtime.tsx';
import { Icon } from '../../ui/Icon.tsx';
import { alignCanvasRectToDevicePixels } from '../../ui/canvas-pixel-alignment.ts';
import { ensureCanvasColorContrast } from '../../ui/canvas-contrast.ts';
import { contrastTextColor } from '../../ui/color-contrast.ts';
import { useCommandAvailability } from '../../ui/runtime-hooks.ts';
import { endEllipsis, nodeTitleLimit } from '../../ui/title-ellipsis.ts';
import { canvasNodeDetail } from '../../services/canvas-lod.ts';

interface TextNodeCanvasLayerProps {
  client: ViewClient;
}

export function TextNodeCanvasLayer({ client }: TextNodeCanvasLayerProps) {
  const runtime = useCanvasEntityLayerRuntime();
  const connectionsAvailable = useCommandAvailability(client, 'connection.create');
  return (
    <TextNodeCanvasLayerView
      client={client}
      {...runtime}
      connectionsAvailable={connectionsAvailable}
    />
  );
}

function TextNodeCanvasLayerView({
  client,
  camera,
  canvasColor,
  nodeById,
  duplicateOrigins,
  visibleNodes,
  previews,
  resizePreviews,
  appearancePreview,
  previewEntities,
  nodeCharacterCounts,
  selected,
  connectionTargetId,
  connectionsAvailable,
  beginNodeDrag,
  handleConnectionPort,
  beginNodeResize,
}: TextNodeCanvasLayerProps & ReturnType<typeof useCanvasEntityLayerRuntime> & {
  connectionsAvailable: boolean;
}) {
  const detail = canvasNodeDetail(camera.zoom);
  const [titleEdit, setTitleEdit] = useState<{
    id: string;
    original: string;
    value: string;
  }>();
  const [searchMatch, setSearchMatch] = useState<SearchMatchPreview>();
  useEffect(
    () => client.subscribeSignal<SearchMatchPreview>('search.match.preview', (message) => {
      setSearchMatch(message.payload.clear ? undefined : message.payload);
    }),
    [client],
  );
  useEffect(() => () => {
    client.emit('canvas.entity.hover.preview', { clear: true });
  }, [client]);
  const finishTitleEdit = (save: boolean) => {
    const edit = titleEdit;
    if (!edit) return;
    setTitleEdit(undefined);
    if (!save || edit.value === edit.original) return;
    void client.dispatch('node.rename', { id: edit.id, title: edit.value }).catch(() => undefined);
  };
  return (
    <div
      className="canvas-world"
      style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})` }}
    >
      {duplicateOrigins.map((origin) => {
        const node = nodeById.get(origin.id);
        if (!node) return null;
        const titleColor = previewEntities.has(node.id)
          ? appearancePreview?.color ?? node.titleColor
          : node.titleColor;
        const titleInk = contrastTextColor(titleColor);
        const isTextBox = node.presentation === 'text-box';
        const renderedTextBoxColor = isTextBox
          ? ensureCanvasColorContrast(titleColor, canvasColor, 4.5)
          : titleColor;
        const renderedTitle = isTextBox
          ? node.title
          : endEllipsis(node.title, nodeTitleLimit(node.width, node.height, detail === 'title-only'));
        const renderedFrame = alignCanvasRectToDevicePixels({
          x: origin.x,
          y: origin.y,
          width: node.width,
          height: node.height,
        }, camera);
        return (
          <article
            className={`text-node-card duplicate-origin ${isTextBox ? 'text-box' : ''} ${!isTextBox && detail === 'title-only' ? 'compact' : ''}`}
            key={`duplicate-origin:${node.id}`}
            style={{
              width: renderedFrame.width,
              height: renderedFrame.height,
              transform: `translate(${renderedFrame.x}px, ${renderedFrame.y}px)`,
              backgroundColor: !isTextBox && detail === 'title-only' ? titleColor : undefined,
              color: isTextBox ? renderedTextBoxColor : undefined,
              '--node-title-ink': titleInk,
              '--text-box-color': renderedTextBoxColor,
            } as CSSProperties}
            aria-hidden="true"
          >
            {isTextBox ? (
              <strong className="text-box-title">{renderedTitle}</strong>
            ) : detail === 'preview' ? (
              <>
                <header className="duplicate-node-header" style={{ backgroundColor: titleColor, color: titleInk }}>
                  <span className="node-type-dot" />
                  <strong>{renderedTitle}</strong>
                  <span className="node-count">
                    {formatNodeCharacterCount(node, nodeCharacterCounts)}
                  </span>
                </header>
                <p>{node.preview || '双击打开正文编辑器'}</p>
              </>
            ) : (
              <strong className="node-zoom-title" style={{ color: titleInk }}>{renderedTitle}</strong>
            )}
          </article>
        );
      })}
      {visibleNodes.map((node) => {
        const position = previews[node.id] ?? node;
        const size = resizePreviews[node.id] ?? node;
        const isTextBox = node.presentation === 'text-box';
        const renderedTitleColor = previewEntities.has(node.id)
          ? appearancePreview?.color ?? node.titleColor
          : node.titleColor;
        const titleInk = contrastTextColor(renderedTitleColor);
        const renderedTextBoxColor = isTextBox
          ? ensureCanvasColorContrast(renderedTitleColor, canvasColor, 4.5)
          : renderedTitleColor;
        const renderedTitle = isTextBox
          ? node.title
          : endEllipsis(node.title, nodeTitleLimit(size.width, size.height, detail === 'title-only'));
        const titleMatch = searchMatch?.field === 'title' && searchMatch.nodeId === node.id
          ? searchMatch
          : undefined;
        const titleLimit = isTextBox
          ? node.title.length
          : nodeTitleLimit(size.width, size.height, detail === 'title-only');
        const renderedFrame = alignCanvasRectToDevicePixels({
          x: position.x,
          y: position.y,
          width: size.width,
          height: size.height,
        }, camera);
        const isSelected = selected.has(node.id);
        return (
          <article
            className={`text-node-card ${isTextBox ? 'text-box' : ''} ${isSelected ? 'selected' : ''} ${isSelected && detail === 'title-only' ? 'overview-selected' : ''} ${connectionTargetId === node.id ? 'connection-target' : ''} ${!isTextBox && detail === 'title-only' ? 'compact' : ''}`}
            key={node.id}
            style={{
              width: renderedFrame.width,
              height: renderedFrame.height,
              transform: `translate(${renderedFrame.x}px, ${renderedFrame.y}px)`,
              backgroundColor: !isTextBox && detail === 'title-only' ? renderedTitleColor : undefined,
              color: isTextBox ? renderedTextBoxColor : undefined,
              '--node-title-ink': titleInk,
              '--text-box-color': renderedTextBoxColor,
            } as CSSProperties}
            onPointerDown={(event) => beginNodeDrag(event, node)}
            onPointerEnter={() => client.emit('canvas.entity.hover.preview', { id: node.id })}
            onPointerLeave={() => client.emit('canvas.entity.hover.preview', { id: node.id, clear: true })}
            onDoubleClick={(event) => {
              if (isTextBox) {
                event.preventDefault();
                event.stopPropagation();
                setTitleEdit({ id: node.id, original: node.title, value: node.title });
                return;
              }
              void client.dispatch('editor.open', {
                id: node.id,
                mode: event.shiftKey ? 'add' : 'replace',
              }).catch(() => undefined);
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.target !== event.currentTarget) return;
              event.preventDefault();
              if (isTextBox) {
                setTitleEdit({ id: node.id, original: node.title, value: node.title });
              } else {
                void client.dispatch('editor.open', { id: node.id }).catch(() => undefined);
              }
            }}
            tabIndex={0}
            aria-label={`${isSelected ? '已选中，' : ''}${isTextBox ? '文本框' : '文本节点'}：${node.title}`}
          >
            {isTextBox ? (
              titleEdit?.id === node.id ? (
                <input
                  className="text-box-title-input"
                  aria-label={`编辑${node.title}的文本框文字`}
                  autoFocus
                  value={titleEdit.value}
                  onFocus={(event) => event.currentTarget.select()}
                  onPointerDown={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                  onChange={(event) => setTitleEdit({ ...titleEdit, value: event.currentTarget.value })}
                  onBlur={() => finishTitleEdit(true)}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.nativeEvent.isComposing) return;
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      event.currentTarget.blur();
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      finishTitleEdit(false);
                    }
                  }}
                />
              ) : (
                <strong className="text-box-title" title={node.title}>
                  <NodeTitleSearchMatch
                    title={node.title}
                    fallback={renderedTitle}
                    maximum={titleLimit}
                    match={titleMatch}
                  />
                </strong>
              )
            ) : detail === 'preview' ? (
              <>
                <header style={{ backgroundColor: renderedTitleColor, color: titleInk }}>
                  <span className="node-type-dot" />
                  <strong title={node.title}>
                    <NodeTitleSearchMatch
                      title={node.title}
                      fallback={renderedTitle}
                      maximum={titleLimit}
                      match={titleMatch}
                    />
                  </strong>
                  <span
                    className="node-count"
                    title="正文字数：包含标点和组合 Emoji，不含空格、制表符和换行"
                  >
                    {formatNodeCharacterCount(node, nodeCharacterCounts)}
                  </span>
                </header>
                <p>{node.preview || '双击打开正文编辑器'}</p>
              </>
            ) : (
              <strong className="node-zoom-title" style={{ color: titleInk }} title={node.title}>
                <NodeTitleSearchMatch
                  title={node.title}
                  fallback={renderedTitle}
                  maximum={titleLimit}
                  match={titleMatch}
                />
              </strong>
            )}
            {connectionsAvailable && (
              <>
                {!isTextBox && (
                  <button
                    type="button"
                    className="connection-edge title"
                    aria-label={`从${node.title}标题栏连接`}
                    title="从标题栏圆点前方创建连线"
                    tabIndex={-1}
                    onPointerDown={(event) => handleConnectionPort(event, node, 'title')}
                  />
                )}
                <button
                  type="button"
                  className="connection-edge left"
                  aria-label={`从${node.title}左侧连接`}
                  title="从左侧创建连线"
                  onPointerDown={(event) => handleConnectionPort(event, node, 'left')}
                />
                <button
                  type="button"
                  className="connection-edge right"
                  aria-label={`从${node.title}右侧连接`}
                  title="从右侧创建连线"
                  onPointerDown={(event) => handleConnectionPort(event, node, 'right')}
                />
              </>
            )}
            {(isTextBox || detail === 'preview') && (
              <button
                type="button"
                className="node-resize-handle"
                aria-label={`调整${node.title}的大小；双击恢复初始大小`}
                title="拖动调整节点大小；双击恢复初始大小"
                onPointerDown={(event) => beginNodeResize(event, node)}
                onDoubleClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void client.dispatch('node.resetSize', { id: node.id });
                }}
              ><Icon name="resize" size={14} /></button>
            )}
          </article>
        );
      })}
    </div>
  );
}

function NodeTitleSearchMatch({
  title,
  fallback,
  maximum,
  match,
}: {
  title: string;
  fallback: string;
  maximum: number;
  match?: SearchMatchPreview;
}) {
  if (!match || !Number.isInteger(match.start) || !Number.isInteger(match.length) ||
    match.start! < 0 || match.length! <= 0 || match.start! + match.length! > title.length) {
    return fallback;
  }
  const start = match.start!;
  const end = start + match.length!;
  const budget = Math.max(match.length! + 2, Math.max(3, Math.floor(maximum)));
  let before = Math.min(start, Math.floor((budget - match.length!) / 2));
  let after = Math.min(title.length - end, budget - match.length! - before);
  before = Math.min(start, budget - match.length! - after);
  after = Math.min(title.length - end, budget - match.length! - before);
  const sliceStart = safeUtf16Start(title, start - before);
  const sliceEnd = safeUtf16End(title, end + after);
  return (
    <>
      {sliceStart > 0 && '…'}
      {title.slice(sliceStart, start)}
      <mark className="node-title-search-hit">{title.slice(start, end)}</mark>
      {title.slice(end, sliceEnd)}
      {sliceEnd < title.length && '…'}
    </>
  );
}

function safeUtf16Start(value: string, index: number): number {
  const bounded = Math.max(0, Math.min(value.length, index));
  return bounded > 0 && bounded < value.length && isLowSurrogate(value.charCodeAt(bounded))
    ? bounded - 1
    : bounded;
}

function safeUtf16End(value: string, index: number): number {
  const bounded = Math.max(0, Math.min(value.length, index));
  return bounded > 0 && bounded < value.length && isHighSurrogate(value.charCodeAt(bounded - 1))
    ? bounded + 1
    : bounded;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function formatNodeCharacterCount(
  node: ContentSummary,
  counts: ReadonlyMap<string, CanvasEntityCharacterCount>,
): string {
  const count = counts.get(node.id);
  return count?.revision === node.revision ? count.characters.toLocaleString() : '…';
}
