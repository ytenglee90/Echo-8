import { createId, isRecord } from '../../core/contracts.ts';
import { AI_TEXT_BOOK_KIND, AI_TEXT_BOOK_VERSION, type AITextBookLinkV1 } from '../../protocols/ai-text-book.ts';
import { PROJECT_FORMAT_VERSION, PROJECT_KIND, type ProjectOpenPayload } from '../../protocols/files.ts';
import { DEFAULT_TEXT_DOCUMENT_FORMAT } from '../../protocols/formatting.ts';
import { assertNotAborted, yieldToMainThread } from '../../services/async-control.ts';

const CHUNK_SIZE = 64 * 1024;
const MAX_BODY_LENGTH = 32 * 1024 * 1024;
const FALLBACK_COLORS = ['#a83d44', '#3568a8', '#7354a3', '#257780', '#896344', '#3f7456', '#5864a2', '#454851'];

interface NativeNode {
  id: string; contentId: string; title: string; x: number; y: number;
  width: number; height: number; presentation: 'card' | 'text-box'; titleColor: string;
  revision: number; createdAt: number; updatedAt: number;
  cardSize: { width: number; height: number };
  textBoxSize?: { width: number; height: number };
}
interface NativeContent {
  id: string; storageVersion: 2; chunkIds: string[]; chunkLengths: number[];
  length: number; revision: number;
}
interface SourceNode {
  node: NativeNode; content: NativeContent; category: string; section: string; order: number;
}
interface InputLimits { maxEntries: number; maxLogicalEntryBytes: number }

export function isAITextBookHeader(value: unknown): boolean {
  return isRecord(value) && value.kind === AI_TEXT_BOOK_KIND;
}

/** Stages untrusted input only; the file owner's existing open command commits it. */
export class AITextBookReader {
  private readonly namespaces: Record<string, Record<string, unknown>> = Object.create(null);
  private readonly nodes = new Map<string, SourceNode>();
  private readonly links: AITextBookLinkV1[] = [];
  private readonly colors = new Map<string, string>();
  private readonly titles = new Set<string>();
  private readonly now = Date.now();
  private records = 0;
  private entries = 0;
  private ended = false;
  private readonly limits: InputLimits;

  constructor(header: unknown, limits: InputLimits) {
    this.limits = limits;
    const value = fields(header, ['type', 'kind', 'formatVersion', 'title']);
    requireInput(value.type === 'manifest' && value.kind === AI_TEXT_BOOK_KIND && value.formatVersion === AI_TEXT_BOOK_VERSION,
      'AI 文本书籍版本不支持');
    if (value.title !== undefined) requireInput(typeof value.title === 'string' && value.title.length <= 2000, '书名不正确');
    for (const name of ['textNode', 'textContent', 'textContentChunk', 'textFormat', 'textFormatMark', 'groups', 'connections']) {
      this.namespaces[name] = Object.create(null) as Record<string, unknown>;
    }
  }

  accept(value: unknown, byteLength: number): void {
    requireInput(!this.ended, 'AI 文本书籍结束标记之后存在多余数据');
    requireInput(isRecord(value), 'AI 文本书籍记录必须是对象');
    requireInput(byteLength <= this.limits.maxLogicalEntryBytes, 'AI 文本书籍单条记录过大');
    requireInput(++this.records <= this.limits.maxEntries, 'AI 文本书籍记录过多');
    if (value.type === 'node') this.addNode(value);
    else if (value.type === 'text') {
      const part = fields(value, ['type', 'id', 'text']);
      const source = this.nodes.get(sourceId(part.id));
      requireInput(source !== undefined, '追加正文的节点尚未声明');
      requireInput(typeof part.text === 'string', '追加正文必须是字符串');
      this.append(source, part.text);
    } else if (value.type === 'link') {
      const link = fields(value, ['type', 'from', 'to', 'kind', 'label']);
      sourceId(link.from); sourceId(link.to);
      requireInput(link.from !== link.to, 'AI 文本书籍不允许自连');
      requireInput(link.kind === 'sequence' || link.kind === 'insert', 'AI 文本书籍连线类型错误');
      requireInput(link.label === undefined || (typeof link.label === 'string' && link.label.length <= 200), '连线标签过长或格式错误');
      this.links.push(link as unknown as AITextBookLinkV1);
    } else if (value.type === 'end') {
      fields(value, ['type']);
      this.ended = true;
    } else throw new Error('AI 文本书籍包含未知记录');
  }

  async finish(signal?: AbortSignal): Promise<ProjectOpenPayload> {
    requireInput(this.ended && this.nodes.size > 0, 'AI 文本书籍缺少节点或结束标记，可能未输出完整');
    assertNotAborted(signal);
    const grouped = new Map<string, SourceNode[]>();
    const notes: SourceNode[] = [];
    let index = 0;
    for (const source of this.nodes.values()) {
      if (source.content.chunkIds.length === 0) this.append(source, '');
      if (source.node.presentation === 'text-box') notes.push(source);
      else {
        source.node.titleColor = this.colors.get(source.category) ?? categoryColor(source.category);
        const group = source.category + (source.section ? `｜${source.section}` : '');
        const members = grouped.get(group) ?? [];
        members.push(source); grouped.set(group, members);
      }
      if (++index % 24 === 0) { assertNotAborted(signal); await yieldToMainThread(); }
    }
    const groups = [...grouped];
    const collator = new Intl.Collator('zh-CN', { numeric: true });
    let top = 120;
    for (let band = 0; band < groups.length; band += 2) {
      let bottom = top;
      for (let panel = 0; panel < 2 && band + panel < groups.length; panel += 1) {
        const [title, members] = groups[band + panel];
        members.sort((a, b) => a.order - b.order || collator.compare(a.node.title, b.node.title));
        const left = 120 + panel * 1380;
        const header = this.makeNode(this.uniqueHeaderTitle(title), 'text-box', members[0].node.titleColor);
        this.append(header, `分类：${title}`);
        Object.assign(header.node, { x: left, y: top });
        const rowTop = top + header.node.height + 32;
        members.forEach((source, member) => Object.assign(source.node, {
          x: left + member % 3 * 420, y: rowTop + Math.floor(member / 3) * 230,
        }));
        const id = createId('group');
        this.put('groups', id, { id, title, memberIds: [header.node.id, ...members.map(m => m.node.id)],
          titleStyle: { fontSize: 16, fontWeight: 650 }, titleMarks: [], color: paleColor(members[0].node.titleColor),
          revision: 1, createdAt: this.now, updatedAt: this.now });
        bottom = Math.max(bottom, rowTop + Math.ceil(members.length / 3) * 230);
      }
      top = bottom + 120;
      assertNotAborted(signal);
      if (band % 24 === 22) await yieldToMainThread();
    }
    for (const source of notes) {
      Object.assign(source.node, { x: 120, y: top }); top += source.node.height + 48;
    }
    const seenLinks = new Set<string>();
    for (let index = 0; index < this.links.length; index += 1) {
      const link = this.links[index], from = this.nodes.get(link.from)?.node, to = this.nodes.get(link.to)?.node;
      requireInput(from && to, 'AI 文本书籍连线引用了不存在的节点');
      const key = JSON.stringify([link.from, link.to, link.kind]);
      requireInput(!seenLinks.has(key), 'AI 文本书籍包含重复连线'); seenLinks.add(key);
      const id = createId('connection'), dashed = link.kind === 'insert';
      const ac = from.x + from.width / 2, bc = to.x + to.width / 2;
      this.put('connections', id, { id, from: { nodeId: from.id, side: dashed ? 'title' : 'right' },
        to: { nodeId: to.id, side: dashed ? 'title' : 'left' }, label: link.label ?? (dashed ? '插入' : '承接'),
        labelWidth: 120, labelHeight: 36, revision: 1, createdAt: this.now,
        ...(dashed ? { titleRoute: true, titleOrigin: { side: ac <= bc ? 'right' : 'left', sourceIsLeft: ac <= bc, sourceCenterX: ac, targetCenterX: bc } } : {}) });
      if (index % 24 === 23) { assertNotAborted(signal); await yieldToMainThread(); }
    }
    const plugin = (id: string, namespaces: string[], dataVersion: number) => ({ id, namespaces, dataVersion, version: '0.1.0', available: true });
    assertNotAborted(signal);
    return {
      manifest: { type: 'manifest', kind: PROJECT_KIND, formatVersion: PROJECT_FORMAT_VERSION, coreVersion: '0.1.0',
        historyMode: 'none', savedAt: this.now, documentRevision: 1,
        plugins: [plugin('text-node', ['textNode', 'textContent', 'textContentChunk', 'textFormat', 'textFormatMark'], 2),
          plugin('groups', ['groups'], 2), plugin('connections', ['connections', 'connectionAppearance', 'connectionJunction'], 14)] },
      document: { revision: 1, namespaces: this.namespaces }, history: { undo: [], redo: [] },
    };
  }

  private addNode(input: unknown): void {
    const value = fields(input, ['type', 'id', 'category', 'name', 'text', 'section', 'presentation', 'color', 'order']);
    const id = sourceId(value.id);
    requireInput(!this.nodes.has(id), 'AI 文本书籍节点 ID 重复');
    const category = shortText(value.category, 80, '类目'), name = shortText(value.name, 2000, '名称');
    const section = value.section === undefined ? '' : shortText(value.section, 200, '分区');
    requireInput(value.text === undefined || typeof value.text === 'string', '节点正文必须是字符串');
    requireInput(value.presentation === undefined || value.presentation === 'card' || value.presentation === 'text-box', '节点形态错误');
    requireInput(value.color === undefined || (typeof value.color === 'string' && /^#[0-9a-f]{6}$/iu.test(value.color)), '颜色必须为六位十六进制');
    requireInput(value.order === undefined || (typeof value.order === 'number' && Number.isSafeInteger(value.order) && value.order >= 0), '节点排序号错误');
    const presentation = value.presentation === 'text-box' ? 'text-box' : 'card';
    const color = typeof value.color === 'string' ? value.color.toLowerCase() : categoryColor(category);
    if (presentation === 'card' && value.color !== undefined) {
      requireInput(!this.colors.has(category) || this.colors.get(category) === color, '同类目卡片颜色不一致');
      this.colors.set(category, color);
    }
    const title = presentation === 'text-box' ? name : `${category}｜${name}`;
    const titleKey = title.normalize('NFKC');
    requireInput(!this.titles.has(titleKey), 'AI 文本书籍节点标题重复，请补充卷章号'); this.titles.add(titleKey);
    const source = this.makeNode(title, presentation, color, category, section, typeof value.order === 'number' ? value.order : 0);
    this.nodes.set(id, source);
    if (typeof value.text === 'string' && value.text.length > 0) this.append(source, value.text);
  }

  private makeNode(title: string, presentation: 'card' | 'text-box', color: string, category = '', section = '', order = 0): SourceNode {
    const id = createId('node'), contentId = createId('content');
    const units = [...title].reduce((sum, c) => sum + (c.codePointAt(0)! > 255 ? 2 : 1), 0);
    const height = presentation === 'text-box' ? Math.max(64, 32 + Math.ceil(units / 20) * 32) : 158;
    requireInput(height <= 1200, '文本框标题过长，请把长内容放入卡片正文');
    const node: NativeNode = { id, contentId, title, x: 0, y: 0, width: 280, height, presentation, titleColor: color,
      cardSize: { width: 280, height: 158 }, ...(presentation === 'text-box' ? { textBoxSize: { width: 280, height } } : {}),
      revision: 1, createdAt: this.now, updatedAt: this.now };
    const content: NativeContent = { id: contentId, storageVersion: 2, chunkIds: [], chunkLengths: [], length: 0, revision: 1 };
    this.put('textNode', id, node); this.put('textContent', contentId, content);
    this.put('textFormat', id, { nodeId: id, storageVersion: 2, markIds: [], revision: 1, format: { ...DEFAULT_TEXT_DOCUMENT_FORMAT } });
    return { node, content, category, section, order };
  }

  private append(source: SourceNode, text: string): void {
    const content = source.content;
    requireInput(content.length + text.length <= MAX_BODY_LENGTH, 'AI 文本书籍单节点正文超出安全上限');
    for (let offset = 0; offset < text.length || (offset === 0 && content.chunkIds.length === 0); offset += CHUNK_SIZE) {
      const part = text.slice(offset, offset + CHUNK_SIZE), id = createId('content-chunk');
      this.put('textContentChunk', id, { id, contentId: content.id, text: part });
      content.chunkIds.push(id); content.chunkLengths.push(part.length); content.length += part.length;
    }
  }

  private put(namespace: string, key: string, value: unknown): void {
    requireInput(++this.entries <= this.limits.maxEntries, 'AI 文本书籍生成的记录过多');
    this.namespaces[namespace][key] = value;
  }

  private uniqueHeaderTitle(title: string): string {
    let value = title;
    while (this.titles.has(value.normalize('NFKC'))) value = `分类：${value}`;
    this.titles.add(value.normalize('NFKC')); return value;
  }
}

function requireInput(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function fields(value: unknown, allowed: string[]): Record<string, unknown> {
  requireInput(isRecord(value), 'AI 文本书籍记录必须是对象');
  requireInput(Object.keys(value).every(key => allowed.includes(key)), 'AI 文本书籍包含不支持的字段');
  return value;
}
function sourceId(value: unknown): string {
  requireInput(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,99}$/u.test(value), 'AI 文本书籍节点引用 ID 错误');
  return value;
}
function shortText(value: unknown, maximum: number, label: string): string {
  requireInput(typeof value === 'string' && value.trim().length > 0 && value.length <= maximum, `${label}不能为空或过长`);
  return value.trim();
}
function categoryColor(category: string): string {
  let hash = 0;
  for (const character of category) hash = ((hash * 31) + character.codePointAt(0)!) >>> 0;
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length];
}
function paleColor(color: string): string {
  return '#' + [1, 3, 5].map(index => Math.round(parseInt(color.slice(index, index + 2), 16) * 0.12 + 255 * 0.88).toString(16).padStart(2, '0')).join('');
}
