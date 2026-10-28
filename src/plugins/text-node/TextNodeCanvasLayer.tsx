import type {
  CSSProperties,
} from 'react';
import { useState } from 'react';
import type { ViewClient } from '../../core/contracts.ts';
import type { ContentSummary } from '../../protocols/content.ts';
import {
  useCanvasEntityLayerRuntime,
  type CanvasEntityCharacterCount,
} from '../../ui/canvas-entity-layer-runtime.tsx';
import { Icon } from '../../ui/Icon.tsx';
import { useCommandAvailability } from '../../ui/runtime-hooks.ts';
import { endEllipsis, nodeTitleLimit } from '../../ui/title-ellipsis.ts';

const NODE_PREVIEW_MIN_ZOOM = 0.5;

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
  nodeById,
  duplicateOrigins,
  visibleNodes,
  offscreenSelectedNodes,
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
      style={{ transform: `translate3d(${camera.x}px, ${camera.y}px, 0) scale(${camera.zoom})` }}
    >
      {duplicateOrigins.map((origin) => {
        const node = nodeById.get(origin.id);
        if (!node) return null;
        const titleColor = previewEntities.has(node.id)
          ? appearancePreview?.color ?? node.titleColor
          : node.titleColor;
        const titleInk = contrastTextColor(titleColor);
        const isTextBox = node.presentation === 'text-box';
        const renderedTitle = isTextBox
          ? node.title
          : endEllipsis(node.title, nodeTitleLimit(node.width, node.height, detail === 'title-only'));
        return (
          <article
            className={`text-node-card duplicate-origin ${isTextBox ? 'text-box' : ''} ${!isTextBox && detail === 'title-only' ? 'compact' : ''}`}
            key={`duplicate-origin:${node.id}`}
            style={{
              width: node.width,
              height: node.height,
              transform: `translate3d(${origin.x}px, ${origin.y}px, 0)`,
              backgroundColor: !isTextBox && detail === 'title-only' ? titleColor : undefined,
              color: isTextBox ? titleColor : undefined,
              '--node-title-ink': titleInk,
              '--text-box-color': titleColor,
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
      {offscreenSelectedNodes.map((node) => (
        <article
          className="canvas-selected-node-proxy"
          key={`selected-proxy:${node.id}`}
          aria-label={`已选中，文本节点：${node.title}`}
        />
      ))}
      {visibleNodes.map((node) => {
        const position = previews[node.id] ?? node;
        const size = resizePreviews[node.id] ?? node;
        const isTextBox = node.presentation === 'text-box';
        const renderedTitleColor = previewEntities.has(node.id)
          ? appearancePreview?.color ?? node.titleColor
          : node.titleColor;
        const titleInk = contrastTextColor(renderedTitleColor);
        const renderedTitle = isTextBox
          ? node.title
          : endEllipsis(node.title, nodeTitleLimit(size.width, size.height, detail === 'title-only'));
        return (
          <article
            className={`text-node-card ${isTextBox ? 'text-box' : ''} ${selected.has(node.id) ? 'selected' : ''} ${connectionTargetId === node.id ? 'connection-target' : ''} ${!isTextBox && detail === 'title-only' ? 'compact' : ''}`}
            key={node.id}
            style={{
              width: size.width,
              height: size.height,
              transform: `translate3d(${position.x}px, ${position.y}px, 0)`,
              backgroundColor: !isTextBox && detail === 'title-only' ? renderedTitleColor : undefined,
              color: isTextBox ? renderedTitleColor : undefined,
              '--node-title-ink': titleInk,
              '--text-box-color': renderedTitleColor,
            } as CSSProperties}
            onPointerDown={(event) => beginNodeDrag(event, node)}
            onDoubleClick={(event) => {
              if (isTextBox) {
                event.preventDefault();
                event.stopPropagation();
                setTitleEdit({ id: node.id, original: node.title, value: node.title });
                return;
              }
              void client.dispatch('editor.open', { id: node.id }).catch(() => undefined);
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
            aria-label={`${selected.has(node.id) ? '已选中，' : ''}${isTextBox ? '文本框' : '文本节点'}：${node.title}`}
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
                <strong className="text-box-title" title={node.title}>{renderedTitle}</strong>
              )
            ) : detail === 'preview' ? (
              <>
                <header style={{ backgroundColor: renderedTitleColor, color: titleInk }}>
                  <span className="node-type-dot" />
                  <strong title={node.title}>{renderedTitle}</strong>
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
                {renderedTitle}
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

function canvasNodeDetail(zoom: number): 'title-only' | 'preview' {
  return zoom < NODE_PREVIEW_MIN_ZOOM ? 'title-only' : 'preview';
}

function contrastTextColor(color: string): '#111111' | '#ffffff' {
  const match = /^#([0-9a-f]{6})$/iu.exec(color);
  if (!match) return '#ffffff';
  const numeric = Number.parseInt(match[1], 16);
  const channels = [numeric >> 16, (numeric >> 8) & 255, numeric & 255].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  return luminance > 0.42 ? '#111111' : '#ffffff';
}

function formatNodeCharacterCount(
  node: ContentSummary,
  counts: ReadonlyMap<string, CanvasEntityCharacterCount>,
): string {
  const count = counts.get(node.id);
  return count?.revision === node.revision ? count.characters.toLocaleString() : '…';
}
