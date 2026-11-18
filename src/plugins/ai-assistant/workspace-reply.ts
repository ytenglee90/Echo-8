import { isRecord, type PluginContext } from '../../core/contracts.ts';
import type { ContentSummary } from '../../protocols/content.ts';
import type { WorkspacePlanReceipt, WorkspacePlanStep } from '../../protocols/workspace-actions.ts';
import { isCapabilityUnavailable } from './runtime-errors.ts';

function readNames(context: PluginContext, ids: string[], signal: AbortSignal) {
  return ids.length ? context.capabilities.request<ContentSummary[]>('content.canvasSummariesById@1',
    { nodeIds: [...new Set(ids)] }, signal).catch(error => {
    if (isCapabilityUnavailable(error, 'content.canvasSummariesById@1')) return [];
    throw error;
  }) : Promise.resolve([]);
}

const rows = (value: unknown) => Array.isArray(value) ? value.filter(isRecord) : [];
const labels = (value: unknown, field: string, limit = 8) => rows(value).slice(0, limit).flatMap(item =>
  typeof item[field] === 'string' ? ['「' + item[field].slice(0, 140) + '」'] : []).join('、');
const statusWord = (value: unknown) => value === true ? '开启' : value === false ? '关闭' : '未知';
const brief = (value: unknown, length = 1200) => typeof value === 'string'
  ? value.slice(0, length) + (value.length > length ? '…' : '') : '';

function describeReadback(action: string, raw: unknown): string | undefined {
  const result = isRecord(raw) ? raw : {};
  switch (action) {
    case 'registered:cloud-sync:cloud-sync.save-as-action':
      return result.open === true ? '已打开云端另存设置，请填写名称并确认' : undefined;
    case 'registered:text-assist:text-assist.load-rules-file-action':
      return result.requested === true ? '请选择本机 TXT 纠错规则文件' : undefined;
    case 'appearance.theme':
      return result.themeId === 'dark' || result.themeId === 'light'
        ? '已切换为' + (result.themeId === 'dark' ? '深色' : '浅色') + '主题' : undefined;
    case 'appearance.read': {
      const prefs = isRecord(result.preferences) ? result.preferences : undefined;
      return prefs ? '编辑区背景 ' + prefs.editorBackground + '，工具栏 ' + prefs.toolbarBackground +
        '，标注 ' + prefs.annotationColor + '，群组底色 ' + prefs.groupBackground : undefined;
    }
    case 'document.revision': return typeof result.revision === 'number' ? '书籍修订号为 ' + result.revision : undefined;
    case 'recovery.list': return rows(raw).length ? '本地恢复点有 ' + rows(raw).length + ' 个，' + labels(raw, 'label') : '现在没有本地恢复点';
    case 'recovery.preview': return typeof result.label === 'string'
      ? '恢复点「' + result.label + '」，当前书籍修订 ' + result.currentDocumentRevision + '，恢复点修订 ' + result.targetDocumentRevision : undefined;
    case 'persistence.read': {
      const word = { idle: '等待保存', saved: '已保存', pending: '有待保存改动', saving: '正在保存', error: '保存失败', 'memory-only': '仅保存在内存' }[String(result.state)];
      return word ? '本地保存状态为' + word : undefined;
    }
    case 'persistence.preferences': case 'persistence.interval':
      return typeof result.autosaveIntervalMs === 'number' ? result.autosaveIntervalMs > 0
        ? '自动保存间隔为 ' + result.autosaveIntervalMs / 1_000 + ' 秒' : '当前关闭自动保存' : undefined;
    case 'storage.read': {
      const categories = rows(result.categories);
      const bytes = result.originUsedBytes ?? categories.reduce((total, row) => total + (typeof row.bytes === 'number' ? row.bytes : 0), 0);
      return '本地存储使用 ' + Math.round(Number(bytes) / 1024) + ' KiB';
    }
    case 'shortcuts.read': case 'settings.shortcuts': {
      const custom = labels(result.overrides, 'chord');
      const defined = labels(raw, 'label');
      return custom ? '自定义快捷键有 ' + rows(result.overrides).length + ' 项，' + custom
        : defined ? '当前快捷键包括 ' + defined : '当前没有自定义快捷键，工作区使用默认绑定';
    }
    case 'plugins.read': {
      const active = rows(raw).filter(item => item.status === 'active');
      return '已启用 ' + active.length + ' 个插件' + (active.length ? '，包括 ' + labels(active, 'name') : '');
    }
    case 'workspace.state': {
      const plugins = rows(result.plugins);
      if (plugins.length) return '当前工作区启用 ' + plugins.filter(item => item.status === 'active').length + ' 个插件';
      return undefined;
    }
    case 'library.cachedProjects':
      return rows(raw).length ? '本地缓存有 ' + rows(raw).length + ' 本可访问书籍' : '本地书库缓存为空';
    case 'clipboard.read': return typeof result.count === 'number' ? '内部剪贴板有 ' + result.count + ' 个对象' : undefined;
    case 'clipboard.copy': return typeof result.count === 'number' ? '已复制 ' + result.count + ' 个选中项到内部剪贴板' : undefined;
    case 'clipboard.cut': return typeof result.count === 'number' ? '已剪切 ' + result.count + ' 个发送时选中的对象到内部剪贴板' : undefined;
    case 'clipboard.paste': return typeof result.created === 'number' ? '已粘贴 ' + result.created + ' 个对象到画布' : undefined;
    case 'clipboard.duplicate': return typeof result.created === 'number' ? '已复制 ' + result.created + ' 个对象及其内部关系，原对象保留' : undefined;
    case 'correction.settings': return '本地纠错已' + statusWord(result.correctionEnabled) + '，文字补全已' + statusWord(result.completionEnabled);
    case 'correction.toggle': return '本地纠错已' + statusWord(result.correctionEnabled);
    case 'completion.toggle': return '文字补全已' + statusWord(result.completionEnabled);
    case 'layout.guides.toggle': return '智能参考线已' + statusWord(result.guides);
    case 'layout.snap.toggle': return '自动吸附已' + statusWord(result.snap);
    case 'content.read': return typeof result.text === 'string' ? '原文：' + brief(result.text) : undefined;
    case 'content.search': {
      const hits = rows(result.hits);
      const titles = labels(hits, 'title');
      return hits.length ? '找到 ' + hits.length + ' 处文字，涉及 ' + titles + (result.truncated ? '（还有更多匹配）' : '') : '没有找到匹配文字';
    }
    case 'content.filter':
      return typeof result.count === 'number' ? '筛得 ' + result.count + ' 张卡片' + (result.count ? '，' + labels(result.matches, 'title') : '') : undefined;
    case 'format.read': case 'format.document':
      return isRecord(result.format) ? '正文字号为 ' + result.format.fontSize + '，行距为 ' + result.format.lineHeight : undefined;
    case 'content.diff':
      return result.equal === true ? '读取的原文范围相同' :
        isRecord(result.left) && isRecord(result.right) ? '原文差异：左侧「' + brief(result.left.text, 160) + '」，右侧「' + brief(result.right.text, 160) + '」' : undefined;
    case 'search.read': return typeof result.matchCount === 'number' ?
      '当前查找「' + brief(result.query, 120) + '」' + (result.truncated === true ? '已显示前 ' : '找到 ') + result.matchCount + ' 处结果'
      : '当前没有已完成的查找结果';
    case 'layout.inspect': return Array.isArray(result.nodes) && Array.isArray(result.overlaps)
      ? '已检查 ' + result.nodes.length + ' 张卡片的位置，发现 ' + result.overlaps.length + ' 对重叠' : undefined;
    case 'diagnostics.operations': {
      const entries = rows(result.entries);
      return entries.length ? '最近操作记录共 ' + entries.length + ' 项，' + entries.slice(0, 4)
        .map(entry => brief(entry.code, 100) + '（' + brief(entry.status, 30) + '）').join('、') : '当前没有操作回执记录';
    }
    case 'assistant.transcript':
      return typeof result.text === 'string' && result.text.trim() ? '本次对话原文（末尾）：' + result.text.slice(-1200) : '本次对话暂无原文';
    case 'assistant.templates': {
      const templates = rows(result.templates);
      return templates.length ? '已配置 ' + templates.length + ' 个提示模板，' + labels(templates, 'label') : '当前没有可读取的提示模板';
    }
    default: return undefined;
  }
}

export async function workspaceReply(
  context: PluginContext, steps: WorkspacePlanStep[], receipt: WorkspacePlanReceipt, signal: AbortSignal,
): Promise<string> {
  if (receipt.status === 'cancelled' || receipt.status === 'expired') return '这份工作区计划已失效，请重新发送任务。';
  const summaries: string[] = [];
  for (const step of receipt.steps) {
    if (step.message) {
      summaries.push(step.message);
      continue;
    }
    if (step.status !== 'completed') continue;
    const args = steps.find(item => item.id === step.id)?.arguments;
    const target = isRecord(args?.target) ? args.target.title : undefined;
    const result = isRecord(step.result) ? step.result : {};
    if (step.id.startsWith('$verify.')) continue;
    switch (step.action) {
      case 'viewport.set':
      case 'viewport.scale':
      case 'viewport.focusEntity':
      case 'viewport.read': {
        if (typeof target === 'string') summaries.push('已聚焦「' + target + '」');
        if (typeof result.zoom === 'number') summaries.push('画布缩放为 ' + Number((result.zoom * 100).toFixed(3)) + '%');
        break;
      }
      case 'minimap.open': case 'minimap.close': case 'minimap.read':
        if (typeof result.open === 'boolean') summaries.push(result.open ? '小地图已打开' : '小地图已关闭');
        break;
      case 'library.state':
        if (typeof result.open === 'boolean') summaries.push(result.open ? '当前显示书库' : '当前显示画布');
        break;
      case 'content.find': {
        const names = Array.isArray(result.matches) ? result.matches.flatMap(match =>
          isRecord(match) && typeof match.title === 'string' ? ['「' + match.title + '」'] : []) : [];
        summaries.push(names.length ? '找到 ' + result.count + ' 张同名卡片，' + names.join('、') : '未找到「' + args?.title + '」');
        break;
      }
      case 'selection.set': case 'selection.read': case 'selection.clear': case 'editor.read': case 'node.create': case 'node.rename': {
        const selected = step.action === 'editor.read' ? result.openPanes : result.ids;
        const ids = Array.isArray(selected) ? selected.filter((id): id is string => typeof id === 'string')
          : typeof result.id === 'string' ? [result.id] : typeof result.targetId === 'string' ? [result.targetId] : [];
        const nodes = await readNames(context, ids.slice(0, 20), signal);
        const names = nodes.map(node => '「' + node.title + '」').join('、');
        if (step.action === 'node.create' || step.action === 'node.rename') {
          if (names) summaries.push((step.action === 'node.create' ? '已新建' : '已改名为') + names);
        } else if (step.action === 'selection.set' && nodes.length === ids.length && ids.length > 0) {
          summaries.push('已选中 ' + ids.length + ' 个节点，' + names);
        } else {
          const label = step.action === 'editor.read' ? '编辑窗格' : '选区';
          summaries.push(ids.length ? label + '有 ' + ids.length + ' 个对象' + (names ? '，' + names : '') : label + '为空');
        }
        break;
      }
      case 'viewport.size':
        if (typeof result.width === 'number' && typeof result.height === 'number') {
          summaries.push('画布可视区域为 ' + Math.round(result.width) + ' × ' + Math.round(result.height) + ' 像素');
        }
        break;
      case 'history.read':
        if (typeof result.undoCount === 'number' && typeof result.redoCount === 'number') {
          summaries.push('可撤销 ' + result.undoCount + ' 步，可重做 ' + result.redoCount + ' 步');
        }
        break;
      case 'node.inspect':
        if (typeof result.title === 'string') summaries.push('「' + result.title + '」坐标 (' + result.x + ', ' + result.y +
          ')，尺寸 ' + result.width + ' × ' + result.height + '，正文 ' + result.length + ' 字符');
        break;
      case 'layout.arrange': case 'layout.horizontal': case 'layout.vertical':
        if (typeof result.changed === 'number') summaries.push('已调整 ' + result.changed + ' 张卡片的位置');
        break;
      case 'group.list': {
        const groups = Array.isArray(step.result) ? step.result.filter(isRecord) : [];
        const visibleGroups = groups.slice(0, 10);
        const nodeIds = visibleGroups.flatMap(group => Array.isArray(group.memberIds) ?
          group.memberIds.filter((id): id is string => typeof id === 'string').slice(0, 5) : []);
        const members = await readNames(context, nodeIds, signal);
        const names = new Map(members.map(node => [node.id, node.title]));
        summaries.push(groups.length ? '共有 ' + groups.length + ' 个群组，' + visibleGroups.map(group => {
          const ids = Array.isArray(group.memberIds) ? group.memberIds : [];
          const listed = ids.slice(0, 5).flatMap(id => names.get(id) ?? []);
          return '「' + group.title + '」有 ' + ids.length + ' 个成员' + (listed.length ? '（' + listed.join('、') + '）' : '');
        }).join('，') : '画布上没有群组');
        break;
      }
      case 'annotation.list': {
        const annotations = Array.isArray(step.result) ? step.result.filter(isRecord) : [];
        const bodies = annotations.slice(0, 6).map(note => typeof note.body === 'string' && note.body
          ? '「' + note.body.slice(0, 120) + (note.body.length > 120 ? '…' : '') + '」' : '空白标注');
        summaries.push(annotations.length ? '共有 ' + annotations.length + ' 条标注，' + bodies.join('、') : '画布上没有标注');
        break;
      }
      case 'connection.graph': {
        const connections = Array.isArray(result.connections) ? result.connections.filter(isRecord) : [];
        const pairs = connections.slice(0, 16).flatMap(connection => isRecord(connection.from) && isRecord(connection.to) &&
          typeof connection.from.nodeId === 'string' && typeof connection.to.nodeId === 'string' ?
          [[connection.from.nodeId, connection.to.nodeId] as const] : []);
        const nodes = await readNames(context, pairs.flatMap(pair => [...pair]), signal);
        const names = new Map(nodes.map(node => [node.id, node.title]));
        const relations = pairs.flatMap(([left, right]) => names.has(left) && names.has(right) ?
          ['「' + names.get(left) + '」→「' + names.get(right) + '」'] : []);
        summaries.push(connections.length ? '共有 ' + connections.length + ' 条连线' +
          (relations.length ? '，' + relations.join('、') : '') : '画布上没有连线');
        break;
      }
      case 'connection.path': case 'entities.list': {
        const values = step.action === 'connection.path' ? result.nodeIds : result.ids;
        if (!Array.isArray(values)) break;
        if (result.found === false) { summaries.push('没有找到连接这两个对象的路径'); break; }
        const ids = values.slice(0, 20).filter((id): id is string => typeof id === 'string');
        const nodes = new Map((await readNames(context, ids, signal)).map(node => [node.id, node.title]));
        const names = ids.flatMap(id => nodes.get(id) ?? []);
        summaries.push(step.action === 'connection.path' ? '最短路径有 ' + (values.length - 1) + ' 条线，' + names.join(' → ')
          : '工作区有 ' + result.count + ' 个可操作对象' + (names.length ? '，包括 ' + names.join('、') : ''));
        break;
      }
      case 'statistics.read': case 'statistics.selection': case 'content.statistics':
        if (result.status === 'running' || result.status === 'idle') summaries.push('画布统计仍在计算，请稍后查询。');
        else if (result.status === 'error') summaries.push('画布统计未完成。');
        else if (typeof result.nonWhitespaceGraphemes === 'number') summaries.push(
          '共 ' + result.nodeCount + ' 张卡，正文 ' + result.nonWhitespaceGraphemes + ' 字（不含空白）',
        );
        break;
      default: {
        const summary = describeReadback(step.action, step.result);
        if (summary) summaries.push(summary);
      }
    }
  }
  if (summaries.length) return [...new Set(summaries)].join('，') + '。';
  if (receipt.status === 'completed') return '已完成 ' + receipt.steps.filter(step => step.status === 'completed').length + ' 项本地工作区操作。';
  return '本地工作区计划没有完成。';
}
